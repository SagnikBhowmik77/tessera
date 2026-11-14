import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Project, Ticket, TicketEvent } from '../models/index.js';
import { publish } from '../realtime.js';
import { closeFromIntegration, serializeTicket } from './ticket.service.js';
import { REPO_NAME } from '../bugs/sourcelink.js';
import { issueFromDelivery, moveFromDelivery, refreshFromDelivery } from './githubdeep.service.js';
import { deployFromGithub } from './deploy.service.js';

export const webhookUrl = (projectId) => `${config.apiUrl}/api/hooks/github/${projectId}`;

// What to paste into GitHub (Settings -> Webhooks -> Add webhook). Connecting again makes a
// new secret, so a leaked one can be replaced.
export async function connectGithub(project) {
  // Only the webhook's own fields change: the token, card moves and issue sync (E7) stay.
  project.github.secret = randomBytes(32).toString('hex');
  project.github.connectedAt = new Date();
  await project.save();
  return githubSettings(project, { withSecret: true });
}

export async function disconnectGithub(project) {
  project.github.secret = null;
  project.github.connectedAt = null;
  await project.save();
  return githubSettings(project);
}

export function githubSettings(project, { withSecret = false } = {}) {
  const connected = Boolean(project.github?.secret);
  return {
    connected,
    connectedAt: project.github?.connectedAt ?? null,
    url: connected ? webhookUrl(project._id) : null,
    contentType: 'application/json',
    events: ['push', 'pull_request', 'pull_request_review', 'check_suite', 'status', 'create', 'issues', 'issue_comment', 'deployment_status'],
    ...(withSecret && connected && { secret: project.github.secret }),
  };
}

// "fixes TES-12", "Closes tes-3", "resolved: TES-9" close; a bare "TES-7" just links.
// Only this project's key counts.
export function findRefs(text, key) {
  const refs = new Map();
  const re = /(?:\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b:?\s+)?\b([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,7})\b/gi;
  for (const m of String(text || '').matchAll(re)) {
    if (m[2].toUpperCase() !== key) continue;
    const number = Number(m[3]);
    refs.set(number, (refs.get(number) ?? false) || Boolean(m[1]));
  }
  return [...refs].map(([number, closes]) => ({ number, closes }));
}

function verifySignature(secret, raw, header) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const given = Buffer.from(String(header || ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Commits and pull requests from a GitHub delivery, each with whether it may close tickets.
// Like GitHub itself: commits close only when pushed to the default branch, PRs only when merged.
function itemsOf(event, payload) {
  if (event === 'push') {
    const onDefault = payload.ref === `refs/heads/${payload.repository?.default_branch}`;
    return (payload.commits ?? []).map((c) => ({
      kind: 'commit', text: c.message, url: c.url, title: String(c.message || '').split('\n')[0].slice(0, 300),
      ref: String(c.id || '').slice(0, 7), author: c.author?.username || c.author?.name || null, mayClose: onDefault,
    }));
  }
  if (event === 'pull_request' && ['opened', 'edited', 'reopened', 'closed', 'ready_for_review'].includes(payload.action)) {
    const pr = payload.pull_request ?? {};
    return [{
      kind: 'pull_request', text: `${pr.head?.ref ?? ''}\n${pr.title ?? ''}\n${pr.body ?? ''}`, url: pr.html_url, title: String(pr.title || '').slice(0, 300),
      ref: `#${pr.number}`, author: pr.user?.login ?? null, mayClose: payload.action === 'closed' && Boolean(pr.merged),
    }];
  }
  return [];
}

// Links commits and pull/merge requests that mention tickets, and closes the ones they finish.
// items: [{ kind, text, url, title, ref, author, mayClose, pr? }]; source: 'github' or 'gitlab'.
export async function linkItems(project, items, source) {
  const linked = new Set();
  const closed = new Set();
  for (const item of items) {
    if (!item.url) continue;
    for (const ref of findRefs(item.text, project.key)) {
      const ticket = await Ticket.findOne({ project: project._id, number: ref.number, deletedAt: null });
      if (!ticket) continue;
      const key = `${project.key}-${ticket.number}`;
      if (!ticket.links.some((l) => l.url === item.url)) {
        ticket.links.push({ kind: item.kind, url: item.url, title: item.title, ref: item.ref, author: item.author, ...(item.pr && { pr: item.pr }) });
        if (ticket.links.length > 50) ticket.links.splice(0, ticket.links.length - 50);
        await ticket.save();
        await TicketEvent.create({
          project: project._id, ticket: ticket._id, actor: null, source, type: 'linked',
          to: { kind: item.kind, url: item.url, title: item.title, ref: item.ref },
        });
        linked.add(key);
      }
      if (ref.closes && item.mayClose && await closeFromIntegration(project, ticket, source)) closed.add(key);
      if (linked.has(key) || closed.has(key)) {
        await ticket.populate([{ path: 'assignee', select: 'name email' }, { path: 'reporter', select: 'name email' }]);
        publish(String(project._id), 'ticket', { action: 'updated', actorId: null, ticket: serializeTicket(ticket, project) });
      }
    }
  }
  // Merge-request status (GitLab) rides along on the link and is refreshed on later deliveries.
  for (const item of items) {
    if (!item.pr || !item.url) continue;
    await Ticket.updateMany({ project: project._id, 'links.url': item.url }, { $set: { 'links.$.pr': item.pr } });
  }
  return { linked: [...linked], closed: [...closed] };
}

export async function handleGithub(projectId, headers, raw) {
  const project = mongoose.isValidObjectId(projectId) ? await Project.findById(projectId) : null;
  if (!project?.github?.secret) throw new HttpError(404, 'not_connected', 'GitHub is not connected to this project');
  if (!verifySignature(project.github.secret, raw, headers['x-hub-signature-256'])) {
    throw new HttpError(401, 'bad_signature', 'The signature does not match this project\'s webhook secret');
  }
  const event = headers['x-github-event'];
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'Set the webhook content type to application/json');
  }
  // The repository for source links, if nobody set one (E5B).
  const repo = payload.repository;
  if (!project.source?.repo && repo?.full_name && REPO_NAME.test(repo.full_name)) {
    project.source = { repo: repo.full_name, branch: repo.default_branch || 'main', pathPrefix: project.source?.pathPrefix ?? '', learnedFrom: 'github' };
    await project.save();
  }
  if (event === 'ping') return { ok: true, event };
  if (project.archivedAt) return { ok: true, event, ignored: 'project_archived', linked: [], closed: [] };

  const { linked, closed } = await linkItems(project, itemsOf(event, payload), 'github');
  // E7: refresh PR status on linked cards, move cards for branches and PRs, sync issues.
  // A GitHub API problem never fails the delivery; it is reported in the answer instead.
  const safe = (p) => p.catch((err) => ({ error: err.message }));
  const refreshed = await safe(refreshFromDelivery(project, event, payload));
  const moved = await safe(moveFromDelivery(project, event, payload, findRefs));
  const issue = await safe(issueFromDelivery(project, event, payload));
  const deploy = event === 'deployment_status' ? await safe(deployFromGithub(project, payload)) : null;
  return { ok: true, event, linked, closed, refreshed, moved, ...(issue && { issue }), ...(deploy && { deploy: deploy.deployment ? { release: deploy.deployment.release, shipped: deploy.shipped } : deploy }) };
}
