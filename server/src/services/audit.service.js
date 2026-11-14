import mongoose from 'mongoose';
import {
  AuditEntry, Milestone, ProjectInvite, Recurrence, Rule, Sprint, Template, User,
} from '../models/index.js';

// The project audit log (E4C). One middleware on the project router records every successful
// change to a project's setup, so new endpoints can't quietly skip it: the table below says
// which requests count and how to describe them. Single-ticket edits are not here; each ticket
// keeps its own full history.

// Writes run in the background (a log problem never fails the change itself). Reading the log
// waits for them first, so it always includes what just happened.
const pending = new Set();
export async function flushAudit() {
  await Promise.allSettled([...pending]);
}

export function recordAudit(projectId, actorId, action, { target = null, details = null } = {}) {
  const job = AuditEntry.create({ project: projectId, actor: actorId, action, target: target?.slice(0, 200) ?? null, details })
    .catch((err) => console.error(`Audit log write failed: ${err.message}`));
  pending.add(job);
  job.finally(() => pending.delete(job));
}

const nameOf = (model, field = 'name') => async (projectId, id) =>
  (mongoose.isValidObjectId(id) ? (await model.findOne({ _id: id, project: projectId }, { [field]: 1 }).lean())?.[field] : null) ?? null;
const personOf = async (_projectId, id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const u = await User.findById(id, { name: 1, email: 1 }).lean();
  return u ? `${u.name} (${u.email})` : null;
};
const recurringName = async (projectId, id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const r = await Recurrence.findOne({ _id: id, project: projectId }, { template: 1 }).lean();
  return r ? nameOf(Template)(projectId, r.template) : null;
};
const body = (ctx) => ctx.req.valid?.body ?? {};
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
const ruleSummary = (r) => r && { enabled: r.enabled, trigger: r.trigger?.type, actions: r.actions?.map((a) => a.type) };

// method, path after /api/projects/:id, action, and how to name the target / what to keep.
// `pre` looks the target's name up before the request runs (needed for deletions).
const ID = '([a-f0-9]{24})';
const ROUTES = [
  ['PATCH', '', 'project.updated', { details: (c) => pick(body(c), ['name', 'key', 'description']) }],
  ['POST', '/archive', 'project.archived'],
  ['POST', '/unarchive', 'project.unarchived'],
  ['PATCH', `/members/${ID}`, 'member.role_changed', { pre: (p, m) => personOf(p, m[1]), details: (c) => ({ role: body(c).role }) }],
  ['DELETE', `/members/${ID}`, (c) => (String(c.req.user._id) === c.match[1] ? 'member.left' : 'member.removed'), {
    pre: (p, m) => personOf(p, m[1]), details: (c) => pick(c.body, ['unassignedTickets']),
  }],
  ['POST', '/invites', 'invite.sent', { target: (c) => body(c).email, details: (c) => ({ role: body(c).role }) }],
  ['DELETE', `/invites/${ID}`, 'invite.revoked', { pre: (p, m) => nameOf(ProjectInvite, 'email')(p, m[1]) }],
  ['PUT', '/statuses', 'columns.changed', {
    details: (c) => ({ columns: (body(c).statuses ?? []).map((s) => (s.wipLimit ? `${s.name} (WIP ${s.wipLimit})` : s.name)) }),
  }],
  ['PUT', '/fields', 'fields.changed', { details: (c) => ({ fields: (body(c).fields ?? []).map((f) => f.name) }) }],
  ['POST', '/templates', 'template.created', { target: (c) => c.body?.template?.name }],
  ['PATCH', `/templates/${ID}`, 'template.updated', { target: (c) => c.body?.template?.name }],
  ['DELETE', `/templates/${ID}`, 'template.deleted', { pre: (p, m) => nameOf(Template)(p, m[1]) }],
  ['POST', '/recurring', 'recurring.created', { target: (c) => c.body?.recurring?.template?.name }],
  ['PATCH', `/recurring/${ID}`, 'recurring.updated', {
    target: (c) => c.body?.recurring?.template?.name, details: (c) => pick(body(c), ['active']),
  }],
  ['DELETE', `/recurring/${ID}`, 'recurring.deleted', { pre: (p, m) => recurringName(p, m[1]) }],
  ['POST', `/recurring/${ID}/run`, 'recurring.run', { pre: (p, m) => recurringName(p, m[1]), details: (c) => ({ ticket: c.body?.ticket?.key }) }],
  ['POST', '/rules', 'rule.created', { target: (c) => c.body?.rule?.name, details: (c) => ruleSummary(c.body?.rule) }],
  ['PATCH', `/rules/${ID}`, 'rule.updated', { target: (c) => c.body?.rule?.name, details: (c) => pick(body(c), ['enabled']) }],
  ['DELETE', `/rules/${ID}`, 'rule.deleted', { pre: (p, m) => nameOf(Rule)(p, m[1]) }],
  ['PUT', '/rules/order', 'rule.reordered', { details: (c) => ({ order: (c.body?.rules ?? []).map((r) => r.name) }) }],
  ['PUT', '/labels', 'labels.changed', { details: (c) => ({ labels: c.body?.labels }) }],
  ['PUT', '/card-layout', 'card_layout.changed', { details: (c) => ({ fields: c.body?.fields }) }],
  ['POST', '/ingest-keys', 'ingest_key.created', { target: (c) => c.body?.ingestKey?.name, details: (c) => ({ origins: c.body?.ingestKey?.origins }) }],
  ['DELETE', `/ingest-keys/${ID}`, 'ingest_key.revoked', { target: (c) => c.body?.ingestKey?.name }],
  ['POST', '/sourcemaps', 'sourcemaps.uploaded', { target: (c) => c.body?.release, details: (c) => ({ files: (c.body?.maps ?? []).map((m) => m.file) }) }],
  ['DELETE', '/sourcemaps', 'sourcemaps.deleted', { target: (c) => c.body?.release, details: (c) => ({ deleted: c.body?.deleted }) }],
  ['PUT', '/github/token', 'github_token.set', { target: (c) => c.body?.github?.login }],
  ['DELETE', '/github/token', 'github_token.removed'],
  ['PUT', '/github/options', 'github.options', { details: (c) => ({ moves: c.body?.github?.moves, issueSync: c.body?.github?.issues?.sync }) }],
  ['POST', '/github/issues/import', 'github.issues_imported', { details: (c) => pick(c.body, ['imported', 'skipped']) }],
  ['POST', '/deploys', 'deploy.recorded', { target: (c) => c.body?.deployment?.release, details: (c) => ({ environment: c.body?.deployment?.environment, shipped: c.body?.shipped?.length ?? 0 }) }],
  ['PUT', '/deploys/settings', 'deploys.settings', { details: (c) => ({ production: c.body?.settings?.production, emailAfterDeploy: c.body?.settings?.emailAfterDeploy, statusPage: c.body?.settings?.statusPage?.enabled }) }],
  ['PUT', '/source', 'source.changed', { details: (c) => pick(c.body?.source, ['repo', 'branch', 'pathPrefix']) }],
  ['POST', '/setup/dismiss', 'checklist.dismissed'],
  ['DELETE', '/setup/dismiss', 'checklist.restored'],
  ['PUT', '/sla', 'sla.changed', { details: (c) => pick(c.body?.sla, ['enabled', 'targets']) }],
  ['POST', '/sprints', 'sprint.created', { target: (c) => c.body?.sprint?.name }],
  ['PATCH', `/sprints/${ID}`, 'sprint.updated', { target: (c) => c.body?.sprint?.name }],
  ['DELETE', `/sprints/${ID}`, 'sprint.deleted', { pre: (p, m) => nameOf(Sprint)(p, m[1]) }],
  ['POST', `/sprints/${ID}/start`, 'sprint.started', { pre: (p, m) => nameOf(Sprint)(p, m[1]) }],
  ['POST', `/sprints/${ID}/complete`, 'sprint.completed', { pre: (p, m) => nameOf(Sprint)(p, m[1]), details: (c) => pick(body(c), ['carryTo']) }],
  ['POST', '/milestones', 'milestone.created', { target: (c) => c.body?.milestone?.name }],
  ['PATCH', `/milestones/${ID}`, 'milestone.updated', { target: (c) => c.body?.milestone?.name }],
  ['DELETE', `/milestones/${ID}`, 'milestone.deleted', { pre: (p, m) => nameOf(Milestone)(p, m[1]) }],
  ['PUT', '/portal', 'portal.updated', { details: (c) => pick(body(c), ['enabled']) }],
  ['POST', '/portal/rotate', 'portal.link_rotated'],
  ['PUT', '/integrations/github', 'github.connected'],
  ['DELETE', '/integrations/github', 'github.disconnected'],
  ['POST', '/tickets/bulk', 'tickets.bulk_changed', {
    details: (c) => ({
      action: body(c).action, tickets: body(c).tickets?.length, done: c.body?.done, failed: c.body?.failed?.length,
      changes: Object.keys(body(c).changes ?? {}).filter((k) => body(c).changes[k] !== undefined && k !== 'overrideWip'),
    }),
  }],
  ['POST', '/tickets/import', 'tickets.imported', {
    skip: (c) => c.req.valid?.query?.dryRun,
    target: (c) => c.req.file?.originalname,
    details: (c) => ({ created: c.body?.created?.length ?? 0, skipped: c.body?.skipped?.length ?? 0 }),
  }],
  ['GET', '/tickets/export', 'tickets.exported', { details: (c) => ({ count: Number(c.res.get('X-Export-Count')) || 0 }) }],
].map(([method, path, action, opts = {}]) => ({ method, re: new RegExp(`^${path}$`), action, ...opts }));

export function auditTrail() {
  return async (req, res, next) => {
    const url = /^\/api\/projects\/([a-f0-9]{24})(\/[^?]*)?/.exec(req.originalUrl);
    if (!url) return next();
    const rest = (url[2] ?? '').replace(/\/$/, '');
    const route = ROUTES.find((r) => r.method === req.method && r.re.test(rest));
    if (!route) return next();
    const match = route.re.exec(rest);
    let pre = null;
    try {
      if (route.pre) pre = await route.pre(url[1], match);
    } catch { /* a missing name is fine; the change itself is checked by its own route */ }
    let sent = null;
    const json = res.json.bind(res);
    res.json = (b) => { sent = b; return json(b); };
    res.on('finish', () => {
      // Only changes that went through, by members (requireProject has set req.project).
      if (res.statusCode >= 400 || !req.project || !req.user) return;
      const ctx = { req, res, body: sent, match };
      try {
        if (route.skip?.(ctx)) return;
        const action = typeof route.action === 'function' ? route.action(ctx) : route.action;
        const target = pre ?? route.target?.(ctx) ?? null;
        const details = route.details?.(ctx) ?? null;
        recordAudit(req.project._id, req.user._id, action, { target: target ? String(target) : null, details });
      } catch (err) {
        console.error(`Audit log failed: ${err.message}`);
      }
    });
    next();
  };
}

// Filter groups shown in the app.
export const AREAS = {
  people: ['member', 'invite'],
  setup: ['project', 'columns', 'fields', 'labels', 'card_layout', 'checklist', 'template', 'recurring', 'portal', 'github', 'source', 'ingest_key', 'sourcemaps', 'github_token', 'deploy', 'deploys'],
  automation: ['rule', 'sla'],
  planning: ['sprint', 'milestone'],
  tickets: ['tickets'],
};

// Newest first, 50 at a time; `before` (an entry's time) pages back.
export async function listAudit(project, { before, area, limit = 50 }) {
  await flushAudit();
  const filter = { project: project._id };
  if (before) filter.at = { $lt: before };
  if (area) filter.action = { $regex: `^(${AREAS[area].join('|')})\\.` };
  const rows = await AuditEntry.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).populate('actor', 'name email');
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map((r) => r.toJSON());
  return { entries, nextBefore: more ? entries.at(-1).at : null };
}
