import { randomBytes, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Project } from '../models/index.js';
import { openSecret, sealSecret } from '../security/twoFactor.js';
import { linkItems } from './github.service.js';

// GitLab (E13): the same as the GitHub webhook. Commits and merge requests that mention a ticket
// (TES-12) are linked to it, and "Closes TES-12" in a commit on the default branch or a merged
// merge request finishes it. GitLab signs nothing; it sends the shared secret in X-Gitlab-Token.
// An optional access token adds each merge request's pipeline status.

let fetchImpl = (...args) => fetch(...args);
export function __setGitlabFetch(fn) { fetchImpl = fn ?? ((...args) => fetch(...args)); }

const hookUrl = (project) => `${config.apiUrl}/api/hooks/gitlab/${project._id}`;
const BASE = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i;

export function gitlabSettings(project, { withSecret = false } = {}) {
  const g = project.gitlab ?? {};
  return {
    connected: Boolean(g.secret), connectedAt: g.connectedAt ?? null, hookUrl: g.secret ? hookUrl(project) : null,
    ...(withSecret && g.secret && { secret: g.secret }),
    token: g.token ? { login: g.tokenLogin, baseUrl: g.baseUrl } : null,
  };
}

export async function connectGitlab(project) {
  if (!project.gitlab?.secret) {
    project.gitlab.secret = randomBytes(24).toString('base64url');
    project.gitlab.connectedAt = new Date();
    await project.save();
  }
  return gitlabSettings(project, { withSecret: true });
}

export async function disconnectGitlab(project) {
  project.gitlab = { secret: null, connectedAt: null, token: null, tokenLogin: null, baseUrl: null };
  await project.save();
  return gitlabSettings(project);
}

async function gl(project, path) {
  const token = openSecret(project.gitlab.token, config.jwt.secret);
  const res = await fetchImpl(`${project.gitlab.baseUrl}/api/v4${path}`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(8000) });
  if (res.status === 401) throw new HttpError(400, 'gitlab_token_rejected', 'GitLab did not accept this token');
  if (!res.ok) throw new HttpError(502, 'gitlab_error', `GitLab answered ${res.status}`);
  return res.json();
}

export async function setGitlabToken(project, { token, baseUrl = 'https://gitlab.com' }) {
  const base = baseUrl.replace(/\/+$/, '');
  if (!BASE.test(base)) throw new HttpError(400, 'bad_url', 'The GitLab address is like https://gitlab.com');
  const res = await fetchImpl(`${base}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res) throw new HttpError(502, 'gitlab_unreachable', `Could not reach ${base}`);
  if (!res.ok) throw new HttpError(400, 'gitlab_token_rejected', 'GitLab did not accept this token (it needs the read_api scope)');
  const me = await res.json();
  project.gitlab.token = sealSecret(token, config.jwt.secret);
  project.gitlab.tokenLogin = me.username ?? null;
  project.gitlab.baseUrl = base;
  await project.save();
  return gitlabSettings(project);
}

export async function removeGitlabToken(project) {
  project.gitlab.token = null;
  project.gitlab.tokenLogin = null;
  await project.save();
  return gitlabSettings(project);
}

function itemsOf(event, payload) {
  if (event === 'Push Hook') {
    const onDefault = payload.ref === `refs/heads/${payload.project?.default_branch}`;
    return (payload.commits ?? []).map((c) => ({
      kind: 'commit', text: c.message, url: c.url, title: String(c.message || '').split('\n')[0].slice(0, 300),
      ref: String(c.id || '').slice(0, 7), author: c.author?.name || null, mayClose: onDefault,
    }));
  }
  if (event === 'Merge Request Hook') {
    const mr = payload.object_attributes ?? {};
    return [{
      kind: 'merge_request', text: `${mr.source_branch ?? ''}\n${mr.title ?? ''}\n${mr.description ?? ''}`, url: mr.url, title: String(mr.title || '').slice(0, 300),
      ref: `!${mr.iid}`, author: payload.user?.username ?? null, mayClose: mr.action === 'merge',
      pr: { state: mr.state, draft: Boolean(mr.draft ?? mr.work_in_progress), mergeStatus: mr.detailed_merge_status ?? mr.merge_status ?? null },
      iid: mr.iid, projectId: payload.project?.id ?? mr.target_project_id,
    }];
  }
  return [];
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function handleGitlab(projectId, headers, raw) {
  const project = mongoose.isValidObjectId(projectId) ? await Project.findById(projectId) : null;
  if (!project?.gitlab?.secret) throw new HttpError(404, 'not_connected', 'GitLab is not connected to this project');
  if (!sameSecret(project.gitlab.secret, headers['x-gitlab-token'])) throw new HttpError(401, 'bad_token', 'The secret token does not match this project');
  const event = headers['x-gitlab-event'];
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'The delivery is not JSON'); }
  if (project.archivedAt) return { ok: true, event, ignored: 'project_archived', linked: [], closed: [] };
  const items = itemsOf(event, payload);
  // With a token, a merge request's pipeline status comes along too (a GitLab problem never fails the delivery).
  let pipeline;
  for (const item of items) {
    if (item.kind === 'merge_request' && project.gitlab.token && item.projectId && item.iid) {
      try {
        const mr = await gl(project, `/projects/${encodeURIComponent(item.projectId)}/merge_requests/${item.iid}`);
        item.pr.pipeline = mr.head_pipeline?.status ?? mr.pipeline?.status ?? null;
        pipeline = item.pr.pipeline;
      } catch (err) { pipeline = { error: err.message }; }
    }
  }
  const { linked, closed } = await linkItems(project, items, 'gitlab');
  return { ok: true, event: event ?? null, linked, closed, ...(pipeline !== undefined && { pipeline }) };
}
