import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Deployment, ErrorOccurrence, Ticket, TicketEvent } from '../models/index.js';
import { emailReporterFixed } from './notification.service.js';
import { publish } from '../realtime.js';

// Deployments (E8): "merged" vs "live", which release brought a crash back, reporter emails held
// until the fix is deployed, DORA metrics, a public status page and a README badge.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const productionOf = (project) => project.deploys?.production || 'production';

export const deploySchema = z.object({
  release: z.string().trim().max(100).optional(),
  sha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i, 'sha is a git commit id').optional(),
  ref: z.string().trim().max(200).optional(),
  environment: z.string().trim().min(1).max(60).optional(),
  status: z.enum(['success', 'failure']).default('success'),
  url: z.string().trim().url().max(500).optional(),
}).refine((b) => b.release || b.sha, { message: 'Send the release name or the commit sha' });

// Records a deploy. A successful production deploy ships every ticket merged before it, and sends
// the "fixed" emails that were waiting for it.
export async function recordDeployment(project, input, { source, by = null, externalId = null, at = new Date() }) {
  const environment = input.environment || productionOf(project);
  if (externalId && await Deployment.exists({ project: project._id, externalId })) return { duplicate: true };
  const deployment = await Deployment.create({
    project: project._id, environment, release: input.release || (input.sha ? input.sha.slice(0, 7) : null),
    sha: input.sha ?? null, ref: input.ref ?? null, status: input.status ?? 'success', source, url: input.url ?? null,
    externalId, by, at,
  });
  const shipped = [];
  let emailed = 0;
  if (deployment.status === 'success' && environment === productionOf(project)) {
    const tickets = await Ticket.find({ project: project._id, deletedAt: null, mergedAt: { $ne: null, $lte: at }, shipped: null });
    for (const t of tickets) {
      t.shipped = { deployment: deployment._id, release: deployment.release, environment, at };
      await t.save();
      shipped.push(t);
    }
    if (shipped.length) {
      await TicketEvent.insertMany(shipped.map((t) => ({
        project: project._id, ticket: t._id, actor: null, source: source === 'github' ? 'github' : 'app', type: 'deployed', at,
        to: { release: deployment.release, environment },
      })));
    }
    // Reporter emails held until the fix is live.
    const waiting = await Ticket.find({ project: project._id, deletedAt: null, fixEmailPending: true, resolvedAt: { $ne: null, $lte: at } });
    for (const t of waiting) {
      if (t.contact?.email || t.otherReporters?.length) { emailReporterFixed(project, t); emailed += 1; }
      t.fixEmailPending = false;
      await t.save();
    }
    deployment.shipped = shipped.length;
    await deployment.save();
    for (const t of shipped) publish(String(project._id), 'ticket', { action: 'updated', actorId: null, number: t.number });
  }
  publish(String(project._id), 'deploy', { action: 'created' });
  return { deployment: deploymentJson(deployment), shipped: shipped.map((t) => `${project.key}-${t.number}`), emailed };
}

export const deploymentJson = (d) => ({
  id: String(d._id), environment: d.environment, release: d.release, sha: d.sha, ref: d.ref, status: d.status,
  source: d.source, url: d.url, shipped: d.shipped ?? 0, at: d.at,
});

// GitHub's deployment_status event.
export async function deployFromGithub(project, payload) {
  const st = payload.deployment_status;
  const dep = payload.deployment;
  if (!st || !dep) return null;
  const status = st.state === 'success' ? 'success' : ['failure', 'error'].includes(st.state) ? 'failure' : null;
  if (!status) return { ignored: st.state };
  const release = dep.payload?.release ?? dep.payload?.version ?? (dep.description && dep.description.length <= 100 ? dep.description : null) ?? dep.sha?.slice(0, 7);
  return recordDeployment(project, {
    release: release ? String(release).slice(0, 100) : undefined, sha: dep.sha, ref: dep.ref, environment: dep.environment || undefined,
    status, url: st.environment_url || st.target_url || undefined,
  }, { source: 'github', externalId: `gh:${st.id}`, at: st.created_at ? new Date(st.created_at) : new Date() });
}

// The release a crash came back in: the one the report said, or else the last production deploy before it.
export async function releaseAt(project, at, reported = null) {
  if (reported) return reported;
  const last = await Deployment.findOne({ project: project._id, environment: productionOf(project), status: 'success', at: { $lte: at } }).sort({ at: -1 }).lean();
  return last?.release ?? null;
}

// ---------- DORA ----------

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hours = (ms) => Math.round((ms / HOUR) * 10) / 10;

export async function dora(project, days = 30, now = new Date()) {
  const since = new Date(+now - days * DAY);
  const env = productionOf(project);
  const deploys = await Deployment.find({ project: project._id, environment: env, at: { $gte: since, $lte: now } }).sort({ at: 1 }).lean();
  const ok = deploys.filter((d) => d.status === 'success');

  const shipped = await Ticket.find({ project: project._id, 'shipped.at': { $gte: since, $lte: now }, mergedAt: { $ne: null } }, { mergedAt: 1, shipped: 1 }).lean();
  const lead = shipped.map((t) => +new Date(t.shipped.at) - +new Date(t.mergedAt)).filter((x) => x >= 0);

  // A deploy "failed" when, within 24 hours, a finished crash came back or a new crash arrived
  // reporting that release; failed deploy runs count too.
  let failed = 0;
  for (const d of deploys) {
    if (d.status === 'failure') { failed += 1; continue; }
    const until = new Date(+new Date(d.at) + DAY);
    const bad = await ErrorOccurrence.exists({
      project: project._id, at: { $gte: d.at, $lte: until },
      $or: [{ regression: true }, ...(d.release ? [{ release: d.release }] : [])],
    });
    if (bad) failed += 1;
  }

  // Time to restore: from a crash coming back to its ticket being finished again.
  const done = new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));
  const back = await TicketEvent.find({ project: project._id, type: 'status_changed', at: { $gte: since, $lte: now }, source: { $ne: 'automation' } }).sort({ at: 1 }).lean();
  const recurred = await TicketEvent.find({ project: project._id, type: 'error_recurred', at: { $gte: since, $lte: now } }, { ticket: 1, at: 1 }).lean();
  const reopenedAt = new Map();
  const restore = [];
  for (const e of back) {
    const byCrash = recurred.some((r) => String(r.ticket) === String(e.ticket) && +r.at === +e.at);
    if (byCrash && done.has(e.from) && !done.has(e.to)) reopenedAt.set(String(e.ticket), e.at);
    if (done.has(e.to) && !done.has(e.from) && reopenedAt.has(String(e.ticket))) {
      restore.push(+e.at - +reopenedAt.get(String(e.ticket)));
      reopenedAt.delete(String(e.ticket));
    }
  }

  return {
    days, environment: env,
    deploys: { total: deploys.length, successful: ok.length, perWeek: Math.round((ok.length / (days / 7)) * 10) / 10 },
    leadTime: { hours: lead.length ? hours(median(lead)) : null, tickets: lead.length },
    changeFailure: { rate: deploys.length ? Math.round((failed / deploys.length) * 100) : null, failed, of: deploys.length },
    timeToRestore: { hours: restore.length ? hours(median(restore)) : null, incidents: restore.length },
  };
}

export async function listDeployments(project) {
  const rows = await Deployment.find({ project: project._id }).sort({ at: -1 }).limit(50).lean();
  return { deployments: rows.map(deploymentJson), dora: { d30: await dora(project, 30), d90: await dora(project, 90) }, settings: deploySettings(project) };
}

export function deploySettings(project) {
  const s = project.statusPage ?? {};
  return {
    production: productionOf(project),
    emailAfterDeploy: Boolean(project.deploys?.emailAfterDeploy),
    statusPage: {
      enabled: Boolean(s.enabled), token: s.enabled ? s.token : null, showCrashes: Boolean(s.showCrashes),
      pageUrl: s.enabled ? `${config.appUrl}/status/${s.token}` : null,
      badgeUrl: s.enabled ? `${config.apiUrl}/api/status/${s.token}/badge.svg` : null,
    },
    hookUrl: `${config.apiUrl}/api/deploys`,
  };
}

export async function updateDeploySettings(project, { production, emailAfterDeploy, statusPage }) {
  if (production !== undefined || emailAfterDeploy !== undefined) {
    project.deploys = {
      production: production ?? project.deploys?.production ?? 'production',
      emailAfterDeploy: emailAfterDeploy ?? project.deploys?.emailAfterDeploy ?? false,
    };
  }
  if (statusPage) {
    const cur = project.statusPage ?? {};
    project.statusPage = {
      enabled: statusPage.enabled ?? Boolean(cur.enabled),
      token: cur.token || randomBytes(18).toString('base64url'),
      showCrashes: statusPage.showCrashes ?? Boolean(cur.showCrashes),
    };
  }
  await project.save();
  return deploySettings(project);
}

// ---------- public status page and badge ----------

export async function publicStatus(Project, token) {
  const project = await Project.findOne({ 'statusPage.token': token, 'statusPage.enabled': true, archivedAt: null });
  if (!project) throw new HttpError(404, 'status_not_found', 'This status page does not exist or has been turned off');
  const done = project.statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const env = productionOf(project);
  const since = new Date(Date.now() - 90 * DAY);
  const [deploys, incidents, crashes] = await Promise.all([
    Deployment.find({ project: project._id, environment: env, at: { $gte: since } }).sort({ at: -1 }).limit(30).lean(),
    Ticket.find({ project: project._id, deletedAt: null, triage: false, labels: 'incident', status: { $nin: done } }, { title: 1, createdAt: 1, priority: 1 }).sort({ createdAt: -1 }).lean(),
    project.statusPage.showCrashes ? ErrorOccurrence.countDocuments({ project: project._id, at: { $gte: new Date(Date.now() - DAY) } }) : null,
  ]);
  const last = deploys.find((d) => d.status === 'success');
  return {
    name: project.name,
    state: incidents.length ? 'incident' : 'operational',
    incidents: incidents.map((i) => ({ title: i.title, since: i.createdAt, priority: i.priority })),
    lastDeploy: last ? { release: last.release, at: last.at } : null,
    deploys: deploys.map((d) => ({ release: d.release, status: d.status, at: d.at })),
    crashes24h: crashes,
    project,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A flat badge like the ones on GitHub READMEs, drawn here (no outside service).
export function badgeSvg(label, value, color) {
  const w = (s) => Math.round(String(s).length * 6.6 + 12);
  const lw = w(label);
  const vw = w(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title>`
    + `<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

export async function badge(Project, token, show) {
  const s = await publicStatus(Project, token);
  if (show === 'release') return badgeSvg('release', s.lastDeploy?.release ?? 'none yet', '#7c6cf0');
  if (show === 'deploys') {
    const d = await dora(s.project, 30);
    return badgeSvg('deploys', `${d.deploys.perWeek}/week`, '#0e7490');
  }
  return badgeSvg('status', s.state === 'incident' ? `${s.incidents.length} incident${s.incidents.length === 1 ? '' : 's'}` : 'operational', s.state === 'incident' ? '#dc2626' : '#16a34a');
}
