import { HttpError } from '../errors.js';
import { Project, Ticket, TicketEvent } from '../models/index.js';
import { notify } from './notification.service.js';
import { runRules } from './automation.service.js';
import { roleAtLeast } from './project.service.js';

// Service levels (E4C). Per priority, a project can promise a first response and a resolution
// within so many hours of a ticket being created. Hours are calendar hours (nights and weekends
// count). "Responded" means a teammate other than the reporter commented, or the ticket left a
// to-do column; resolving it counts as responding too. Epics have no targets.
const HOUR = 3600 * 1000;
// "At risk" once less than a quarter of the time is left.
export const AT_RISK_SHARE = 0.25;
export const SLA_KINDS = ['response', 'resolve'];
const HOURS_FIELD = { response: 'responseHours', resolve: 'resolveHours' };

export function targetFor(project, priority) {
  if (!project.sla?.enabled) return null;
  return project.sla.targets?.find((t) => t.priority === priority) ?? null;
}

function clock(hours, start, doneAt, now) {
  if (!hours) return null;
  const dueAt = new Date(start.getTime() + hours * HOUR);
  if (doneAt) return { hours, dueAt, doneAt, state: doneAt <= dueAt ? 'met' : 'missed' };
  const left = dueAt - now;
  return { hours, dueAt, doneAt: null, state: left < 0 ? 'breached' : left <= hours * HOUR * AT_RISK_SHARE ? 'at_risk' : 'running' };
}

// { response, resolve } for one ticket (each null when that target isn't set), or null.
export function slaOf(project, ticket, now = new Date()) {
  if (ticket.type === 'epic' || ticket.deletedAt || !ticket.createdAt) return null;
  const t = targetFor(project, ticket.priority);
  if (!t) return null;
  const response = clock(t.responseHours, ticket.createdAt, ticket.respondedAt ?? ticket.resolvedAt ?? null, now);
  const resolve = clock(t.resolveHours, ticket.createdAt, ticket.resolvedAt ?? null, now);
  return response || resolve ? { response, resolve } : null;
}

// MongoDB conditions for "open and past (or close to) its target", for list filters and the
// breach checker. `state` is 'breached' or 'at_risk'.
function openPast(project, kind, state, now) {
  const field = HOURS_FIELD[kind];
  const or = [];
  for (const t of project.sla?.targets ?? []) {
    const h = t[field];
    if (!h) continue;
    const late = new Date(now - h * HOUR);
    const createdAt = state === 'breached' ? { $lt: late } : { $gte: late, $lt: new Date(now - h * HOUR * (1 - AT_RISK_SHARE)) };
    or.push({ priority: t.priority, createdAt });
  }
  if (!or.length) return null;
  const open = kind === 'response' ? { respondedAt: null, resolvedAt: null } : { resolvedAt: null };
  return { ...open, type: { $ne: 'epic' }, $or: or };
}

export function slaFilter(project, state, now = new Date()) {
  if (!project.sla?.enabled) return { _id: null };
  const parts = SLA_KINDS.map((k) => openPast(project, k, state, now)).filter(Boolean);
  return parts.length ? { $or: parts } : { _id: null };
}

// Tickets made before service levels existed have no `respondedAt`: work it out from their
// history (the first comment by someone other than the reporter, or the first move out of a
// to-do column), so their clocks are real rather than guessed.
async function backfillResponses(project) {
  const tickets = await Ticket.find({ project: project._id, respondedAt: { $exists: false } }, { _id: 1, reporter: 1 }).lean();
  if (!tickets.length) return;
  const todo = new Set(project.statuses.filter((s) => s.category === 'todo').map((s) => s.key));
  const started = (status) => status !== undefined && status !== null && !todo.has(status);
  const events = await TicketEvent.find(
    { ticket: { $in: tickets.map((t) => t._id) }, type: { $in: ['created', 'status_changed', 'commented'] } },
    { ticket: 1, type: 1, actor: 1, to: 1, at: 1 },
  ).sort({ at: 1 }).lean();
  const reporter = new Map(tickets.map((t) => [String(t._id), String(t.reporter)]));
  const first = new Map();
  for (const e of events) {
    const id = String(e.ticket);
    if (first.has(id)) continue;
    const responded = (e.type === 'created' && started(e.to?.status))
      || (e.type === 'status_changed' && started(e.to))
      || (e.type === 'commented' && e.actor && String(e.actor) !== reporter.get(id));
    if (responded) first.set(id, e.at);
  }
  await Ticket.bulkWrite(tickets.map((t) => ({
    updateOne: { filter: { _id: t._id }, update: { $set: { respondedAt: first.get(String(t._id)) ?? null } } },
  })));
}

// At start-up: every project with tickets from before service levels existed.
export async function backfillAllResponses() {
  const ids = await Ticket.distinct('project', { respondedAt: { $exists: false } });
  for (const id of ids) {
    const project = await Project.findById(id);
    if (project) await backfillResponses(project);
  }
}

// Saving targets. Tickets already past a target when it is saved show as breached but are not
// alerted (alerts are for breaches that happen from now on, not a burst for old work).
export async function setSla(project, { enabled, targets }) {
  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.priority)) throw new HttpError(400, 'duplicate_priority', `There are two targets for ${t.priority} priority`);
    seen.add(t.priority);
    if (t.responseHours && t.resolveHours && t.responseHours > t.resolveHours) {
      throw new HttpError(400, 'sla_order', `For ${t.priority} priority, the first response target can't be longer than the resolution target`);
    }
  }
  if (enabled && !targets.some((t) => t.responseHours || t.resolveHours)) {
    throw new HttpError(400, 'sla_empty', 'Set at least one target, or turn service levels off');
  }
  project.sla = { enabled, targets: targets.filter((t) => t.responseHours || t.resolveHours) };
  await project.save();
  if (enabled) {
    await backfillResponses(project);
    const now = new Date();
    for (const kind of SLA_KINDS) {
      const past = openPast(project, kind, 'breached', now);
      if (past) await Ticket.updateMany({ project: project._id, deletedAt: null, [`slaAlerted.${kind}`]: null, ...past }, { $set: { [`slaAlerted.${kind}`]: now } });
    }
  }
  return project.sla;
}

const LABEL = { response: 'First response', resolve: 'Resolution' };
const hoursText = (h) => (h === 1 ? '1 hour' : `${h} hours`);

// Finds tickets that have just gone past a target: records it in their history, tells the
// assignee (or the project's managers when nobody is assigned), and runs "SLA breached" rules.
// Claiming `slaAlerted.<kind>` first means each breach is handled once, even with two servers.
export async function checkSlaBreaches(now = new Date()) {
  const handled = [];
  const projects = await Project.find({ 'sla.enabled': true, archivedAt: null });
  for (const project of projects) {
    for (const kind of SLA_KINDS) {
      const past = openPast(project, kind, 'breached', now);
      if (!past) continue;
      const due = await Ticket.find({ project: project._id, deletedAt: null, [`slaAlerted.${kind}`]: null, ...past }).limit(200);
      for (const ticket of due) {
        const claimed = await Ticket.updateOne({ _id: ticket._id, [`slaAlerted.${kind}`]: null }, { $set: { [`slaAlerted.${kind}`]: now } });
        if (!claimed.modifiedCount) continue;
        ticket.slaAlerted = { ...(ticket.slaAlerted?.toObject?.() ?? ticket.slaAlerted ?? {}), [kind]: now };
        const hours = targetFor(project, ticket.priority)?.[HOURS_FIELD[kind]];
        await TicketEvent.create({
          project: project._id, ticket: ticket._id, actor: null, source: 'sla', type: 'sla_breached', field: kind, to: { hours }, at: now,
        });
        const key = `${project.key}-${ticket.number}`;
        const people = ticket.assignee
          ? [ticket.assignee]
          : project.members.filter((m) => roleAtLeast(m.role, 'manager')).map((m) => m.user);
        await notify(people.map((user) => ({
          user, project: project._id, ticket: ticket._id, actor: null, type: 'sla_breached',
          ticketKey: key, ticketTitle: ticket.title, excerpt: `${LABEL[kind]} target of ${hoursText(hours)} missed`,
        })));
        await runRules(project, ticket, [{ type: 'sla_breached', field: kind }]);
        handled.push({ project: String(project._id), number: ticket.number, kind });
      }
    }
  }
  return handled;
}

// Checks at start-up and every 5 minutes. A sleeping free server checks again as soon as it
// wakes, so an alert can be late but is never lost.
export function startSlaChecker({ onBreach } = {}) {
  const tick = () => checkSlaBreaches()
    .then((list) => { for (const b of list) onBreach?.(b); })
    .catch((err) => console.error('SLA check failed:', err.message));
  tick();
  setInterval(tick, 5 * 60 * 1000).unref();
}

// How the project is doing against its targets: tickets created in the last `days` days, by
// priority, plus every open ticket that is past a target right now.
export async function slaReport(project, { days = 30 } = {}, now = new Date()) {
  if (!project.sla?.enabled) return { enabled: false };
  const since = new Date(now - days * 24 * HOUR);
  const recent = await Ticket.find(
    { project: project._id, deletedAt: null, type: { $ne: 'epic' }, createdAt: { $gte: since } },
    { priority: 1, type: 1, createdAt: 1, respondedAt: 1, resolvedAt: 1 },
  ).lean();
  const empty = () => ({ met: 0, missed: 0, breached: 0, at_risk: 0, running: 0 });
  const rows = project.sla.targets.map((t) => ({
    priority: t.priority, responseHours: t.responseHours ?? null, resolveHours: t.resolveHours ?? null,
    tickets: 0, response: empty(), resolve: empty(),
  }));
  const byPriority = new Map(rows.map((r) => [r.priority, r]));
  for (const ticket of recent) {
    const row = byPriority.get(ticket.priority);
    const s = slaOf(project, ticket, now);
    if (!row || !s) continue;
    row.tickets += 1;
    for (const kind of SLA_KINDS) if (s[kind]) row[kind][s[kind].state] += 1;
  }
  const past = slaFilter(project, 'breached', now);
  const open = await Ticket.find({ project: project._id, deletedAt: null, ...past })
    .sort({ createdAt: 1 }).limit(50).populate('assignee', 'name email');
  const breached = open.map((t) => {
    const s = slaOf(project, t, now);
    return {
      key: `${project.key}-${t.number}`, number: t.number, title: t.title, priority: t.priority,
      assignee: t.assignee ? { id: String(t.assignee._id), name: t.assignee.name } : null,
      kinds: SLA_KINDS.filter((k) => s?.[k]?.state === 'breached').map((k) => ({ kind: k, dueAt: s[k].dueAt })),
    };
  });
  return { enabled: true, days, rows, breached };
}
