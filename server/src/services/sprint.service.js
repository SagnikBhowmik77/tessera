import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { addDays, dayToDate, startOfDayIn, todayIn } from '../dates.js';
import { Milestone, Sprint, Ticket, TicketEvent } from '../models/index.js';
import { canEdit, ticketKey } from './ticket.service.js';

// Sprints (plan -> start -> complete, unfinished work carried over), the sprint retro report,
// and milestones. Every ticket move between sprints or milestones goes into the ticket's history
// ('relation_changed', field 'sprint' / 'milestone'), which is what the report reads to tell
// committed work from work added mid-sprint.

const MAX_SPRINT_DAYS = 56;
const MAX_OPEN_SPRINTS = 20;
const MAX_MILESTONES = 100;

const dayOf = (d) => (d ? d.toISOString().slice(0, 10) : null);
const doneKeys = (project) => new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));
const pts = (t) => t?.storyPoints ?? 0;
// Hours to three decimals (about 4 seconds), so a short blocked spell still shows.
const hours = (ms) => Math.round((ms / 3600e3) * 1000) / 1000;
const sprintRef = (s) => (s ? { id: String(s._id), name: s.name } : null);
const milestoneRef = (m) => (m ? { id: String(m._id), name: m.name } : null);

const sprintNotFound = () => new HttpError(404, 'sprint_not_found', 'Sprint not found');
const milestoneNotFound = () => new HttpError(404, 'milestone_not_found', 'Milestone not found');

async function findSprint(project, id) {
  const s = await Sprint.findOne({ _id: id, project: project._id });
  if (!s) throw sprintNotFound();
  return s;
}

async function findMilestone(project, id) {
  const m = await Milestone.findOne({ _id: id, project: project._id });
  if (!m) throw milestoneNotFound();
  return m;
}

function checkDates(start, end) {
  if (!start || !end) return;
  if (end < start) throw new HttpError(400, 'sprint_dates', 'The sprint must end on or after the day it starts');
  const days = Math.round((end - start) / 86400e3) + 1;
  if (days > MAX_SPRINT_DAYS) throw new HttpError(400, 'sprint_too_long', `Sprints are at most ${MAX_SPRINT_DAYS} days`);
}

export function shapeSprint(s, stats = {}) {
  return {
    id: String(s._id),
    name: s.name,
    goal: s.goal,
    startDate: dayOf(s.startDate),
    endDate: dayOf(s.endDate),
    state: s.state,
    startedAt: s.startedAt,
    closedAt: s.closedAt,
    carriedTo: s.carriedTo ? String(s.carriedTo) : null,
    ...stats,
  };
}

export function shapeMilestone(m) {
  return { id: String(m._id), name: m.name, description: m.description, dueDate: dayOf(m.dueDate), closedAt: m.closedAt };
}

const emptyStats = () => ({ tickets: 0, done: 0, points: 0, pointsDone: 0 });

// Every sprint with its ticket counts, plus velocity (points finished per closed sprint).
export async function listSprints(project) {
  const done = [...doneKeys(project)];
  const sprints = await Sprint.find({ project: project._id }).lean();
  const live = await Ticket.aggregate([
    { $match: { project: project._id, deletedAt: null, sprint: { $ne: null } } },
    {
      $group: {
        _id: '$sprint',
        tickets: { $sum: 1 },
        done: { $sum: { $cond: [{ $in: ['$status', done] }, 1, 0] } },
        points: { $sum: { $ifNull: ['$storyPoints', 0] } },
        pointsDone: { $sum: { $cond: [{ $in: ['$status', done] }, { $ifNull: ['$storyPoints', 0] }, 0] } },
      },
    },
  ]);
  const liveBy = new Map(live.map((r) => [String(r._id), r]));

  // Closed sprints are described by what was stored when they closed.
  const closed = sprints.filter((s) => s.state === 'closed');
  const ids = [...new Set(closed.flatMap((s) => [...s.committed, ...s.completed, ...s.unfinished]).map(String))];
  const points = new Map((await Ticket.find({ _id: { $in: ids } }, { storyPoints: 1 }).lean()).map((t) => [String(t._id), pts(t)]));
  const sum = (list) => list.reduce((n, id) => n + (points.get(String(id)) ?? 0), 0);

  const shaped = sprints.map((s) => {
    if (s.state !== 'closed') {
      const r = liveBy.get(String(s._id));
      return shapeSprint(s, r ? { tickets: r.tickets, done: r.done, points: r.points, pointsDone: r.pointsDone } : emptyStats());
    }
    return shapeSprint(s, {
      tickets: s.completed.length + s.unfinished.length,
      done: s.completed.length,
      points: sum(s.completed) + sum(s.unfinished),
      pointsDone: sum(s.completed),
    });
  });
  const order = { active: 0, planned: 1, closed: 2 };
  const far = '9999-12-31';
  shaped.sort((a, b) => order[a.state] - order[b.state]
    || (a.state === 'closed'
      ? new Date(b.closedAt) - new Date(a.closedAt)
      : (a.startDate ?? far).localeCompare(b.startDate ?? far) || a.id.localeCompare(b.id)));

  const velocity = closed
    .sort((a, b) => a.closedAt - b.closedAt)
    .slice(-8)
    .map((s) => ({
      id: String(s._id),
      name: s.name,
      committed: s.committed.length,
      committedPoints: sum(s.committed),
      completed: s.completed.length,
      completedPoints: sum(s.completed),
    }));
  return { sprints: shaped, velocity };
}

export async function createSprint(project, { name, goal = '', startDate = null, endDate = null }) {
  const open = await Sprint.countDocuments({ project: project._id, state: { $ne: 'closed' } });
  if (open >= MAX_OPEN_SPRINTS) throw new HttpError(400, 'too_many_sprints', `At most ${MAX_OPEN_SPRINTS} sprints can be planned at once`);
  checkDates(startDate, endDate);
  const count = await Sprint.countDocuments({ project: project._id });
  const s = await Sprint.create({ project: project._id, name: name || `Sprint ${count + 1}`, goal, startDate, endDate });
  return shapeSprint(s, emptyStats());
}

export async function updateSprint(project, id, changes) {
  const s = await findSprint(project, id);
  if (s.state === 'closed' && (changes.startDate !== undefined || changes.endDate !== undefined)) {
    throw new HttpError(409, 'sprint_closed', 'A finished sprint\'s dates can\'t change');
  }
  if (s.state === 'active' && changes.startDate !== undefined && +changes.startDate !== +s.startDate) {
    throw new HttpError(409, 'sprint_started', 'This sprint has started, so its first day can\'t change. You can move its end date.');
  }
  if (s.state === 'active' && changes.endDate === null) throw new HttpError(400, 'sprint_dates', 'A running sprint needs an end date');
  const start = changes.startDate !== undefined ? changes.startDate : s.startDate;
  const end = changes.endDate !== undefined ? changes.endDate : s.endDate;
  checkDates(start, end);
  for (const k of ['name', 'goal', 'startDate', 'endDate']) if (changes[k] !== undefined) s[k] = changes[k];
  await s.save();
  return shapeSprint(s);
}

async function moveTickets(project, actor, tickets, from, to, at = new Date()) {
  if (!tickets.length) return;
  await Ticket.updateMany({ _id: { $in: tickets.map((t) => t._id) } }, { $set: { sprint: to?._id ?? null } });
  await TicketEvent.insertMany(tickets.map((t) => ({
    project: project._id, ticket: t._id, actor, type: 'relation_changed', field: 'sprint', from: sprintRef(from), to: sprintRef(to), at,
  })));
}

// Only a sprint that hasn't started can be deleted; its tickets go back to the backlog.
export async function deleteSprint(project, actor, id) {
  const s = await findSprint(project, id);
  if (s.state !== 'planned') throw new HttpError(409, 'sprint_not_planned', 'Only a sprint that hasn\'t started can be deleted');
  const tickets = await Ticket.find({ sprint: s._id }, { _id: 1 }).lean();
  await moveTickets(project, actor, tickets, s, null);
  await Sprint.deleteOne({ _id: s._id });
}

export async function startSprint(project, actor, id) {
  const s = await findSprint(project, id);
  if (s.state !== 'planned') throw new HttpError(409, 'sprint_not_planned', s.state === 'active' ? 'This sprint is already running' : 'This sprint is finished');
  if (!s.startDate || !s.endDate) throw new HttpError(400, 'sprint_dates', 'Set the sprint\'s first and last day before starting it');
  const running = await Sprint.findOne({ project: project._id, state: 'active' }, { name: 1 }).lean();
  if (running) throw new HttpError(409, 'sprint_running', `${running.name} is still running. Complete it first.`);
  const tickets = await Ticket.find({ sprint: s._id, deletedAt: null }, { _id: 1 }).lean();
  if (!tickets.length) throw new HttpError(400, 'sprint_empty', 'Add some tickets to the sprint before starting it');
  let started;
  try {
    started = await Sprint.findOneAndUpdate(
      { _id: s._id, state: 'planned' },
      { $set: { state: 'active', startedAt: new Date(), startedBy: actor, committed: tickets.map((t) => t._id) } },
      { returnDocument: 'after' },
    );
  } catch (e) {
    if (e?.code === 11000) throw new HttpError(409, 'sprint_running', 'Another sprint is already running. Complete it first.');
    throw e;
  }
  if (!started) throw new HttpError(409, 'sprint_not_planned', 'This sprint has already started');
  return shapeSprint(started);
}

// Ends the running sprint. Finished tickets stay with it; unfinished ones move to `carryTo`:
// 'backlog', 'new' (a new sprint right after this one, same length) or a planned sprint's id.
export async function completeSprint(project, actor, id, { carryTo }) {
  const s = await findSprint(project, id);
  if (s.state !== 'active') throw new HttpError(409, 'sprint_not_active', 'Only the running sprint can be completed');
  let target = null;
  if (carryTo !== 'backlog' && carryTo !== 'new') {
    target = await findSprint(project, carryTo);
    if (target.state !== 'planned') throw new HttpError(400, 'carry_target', 'Unfinished work can only move to a sprint that hasn\'t started');
  }
  const done = doneKeys(project);
  const all = await Ticket.find({ sprint: s._id }, { status: 1, deletedAt: 1 }).lean();
  const live = all.filter((t) => !t.deletedAt);
  const completed = live.filter((t) => done.has(t.status));
  const unfinished = live.filter((t) => !done.has(t.status));
  const at = new Date();
  const closed = await Sprint.findOneAndUpdate(
    { _id: s._id, state: 'active' },
    {
      $set: {
        state: 'closed', closedAt: at, closedBy: actor,
        completed: completed.map((t) => t._id), unfinished: unfinished.map((t) => t._id),
      },
    },
    { returnDocument: 'after' },
  );
  if (!closed) throw new HttpError(409, 'sprint_not_active', 'This sprint was already completed');
  if (carryTo === 'new' && unfinished.length) {
    // The next sprint starts the day after this one was meant to end (or today if that has
    // passed) and lasts as long.
    const length = Math.round((s.endDate - s.startDate) / 86400e3);
    const today = todayIn(config.timeZone);
    const after = addDays(dayOf(s.endDate), 1);
    const first = after > today ? after : today;
    const count = await Sprint.countDocuments({ project: project._id });
    target = await Sprint.create({
      project: project._id, name: `Sprint ${count + 1}`, startDate: dayToDate(first), endDate: dayToDate(addDays(first, length)),
    });
  }
  if (target) await Sprint.updateOne({ _id: closed._id }, { $set: { carriedTo: target._id } });
  await moveTickets(project, actor, unfinished, s, target, at);
  // Binned tickets leave the sprint quietly, so a restore doesn't put them into a closed sprint.
  const binned = all.filter((t) => t.deletedAt).map((t) => t._id);
  if (binned.length) await Ticket.updateMany({ _id: { $in: binned } }, { $set: { sprint: null } });
  return {
    sprint: shapeSprint({ ...closed.toObject(), carriedTo: target?._id ?? null }),
    carriedTo: target ? shapeSprint(target) : null,
    completed: completed.length,
    unfinished: unfinished.length,
  };
}

function requireEditor(membership, ticket) {
  if (ticket.deletedAt) throw new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');
  if (!canEdit(membership, ticket)) {
    throw new HttpError(403, 'forbidden', 'You can change tickets you reported or are assigned to. Managers can change any ticket.');
  }
}

// Plan a ticket into a sprint (or back to the backlog with null).
export async function setTicketSprint(project, membership, ticket, sprintId) {
  requireEditor(membership, ticket);
  if (ticket.type === 'epic') throw new HttpError(400, 'epic_in_sprint', 'Epics span sprints. Plan the epic\'s tickets into sprints instead.');
  let target = null;
  if (sprintId !== null) {
    target = await findSprint(project, sprintId);
    if (target.state === 'closed') throw new HttpError(400, 'sprint_closed', 'That sprint is finished');
  }
  if (String(ticket.sprint ?? '') === String(target?._id ?? '')) return;
  const before = ticket.sprint ? await Sprint.findById(ticket.sprint, { name: 1 }).lean() : null;
  await moveTickets(project, membership.user, [ticket], before, target);
}

export async function setTicketMilestone(project, membership, ticket, milestoneId) {
  requireEditor(membership, ticket);
  let target = null;
  if (milestoneId !== null) {
    target = await findMilestone(project, milestoneId);
    if (target.closedAt) throw new HttpError(400, 'milestone_closed', 'That milestone is closed');
  }
  if (String(ticket.milestone ?? '') === String(target?._id ?? '')) return;
  const before = ticket.milestone ? await Milestone.findById(ticket.milestone, { name: 1 }).lean() : null;
  await Ticket.updateOne({ _id: ticket._id }, { $set: { milestone: target?._id ?? null } });
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor: membership.user, type: 'relation_changed', field: 'milestone',
    from: milestoneRef(before), to: milestoneRef(target),
  });
}

// ---------------------------------------------------------------------------------------------
// The retro report

// [from, to) spans where a switch list ({ at, on }, sorted) is on, cut off at `end`.
function spans(switches, end) {
  const out = [];
  let since = null;
  for (const s of switches) {
    if (s.on && since === null) since = +s.at;
    else if (!s.on && since !== null) { out.push([since, +s.at]); since = null; }
  }
  if (since !== null) out.push([since, +end]);
  return out;
}

const overlap = ([a, b], [c, d]) => Math.max(0, Math.min(b, d) - Math.max(a, c));
const lastBefore = (list, at) => {
  let v = null;
  for (const x of list) { if (x.at <= at) v = x; else break; }
  return v;
};

export async function sprintReport(project, id, now = new Date()) {
  const s = await findSprint(project, id);
  if (s.state === 'planned') throw new HttpError(409, 'sprint_not_started', 'The report starts once the sprint does');
  const sid = String(s._id);
  const start = s.startedAt;
  const end = s.closedAt ?? now;
  const done = doneKeys(project);

  // Moves in and out while the sprint ran. The close itself (carry-over) happens at closedAt and
  // is reported as "carried over", not as "removed".
  const moves = await TicketEvent.find({
    project: project._id, type: 'relation_changed', field: 'sprint',
    at: { $gte: start, ...(s.closedAt ? { $lt: s.closedAt } : { $lte: end }) },
    $or: [{ 'to.id': sid }, { 'from.id': sid }],
  }).sort({ at: 1, _id: 1 }).lean();

  // Per ticket: in the sprint or not, its status, binned or not, blocked or not, over time.
  const committed = s.committed.map(String);
  const byTicket = new Map();
  const tl = (id) => {
    if (!byTicket.has(id)) byTicket.set(id, { member: [], status: [], binned: [], blocked: [] });
    return byTicket.get(id);
  };
  for (const id of committed) tl(id).member.push({ at: start, on: true });
  for (const m of moves) tl(String(m.ticket)).member.push({ at: m.at, on: m.to?.id === sid });
  const scopeIds = [...byTicket.keys()];

  const [tickets, history] = await Promise.all([
    Ticket.find({ _id: { $in: scopeIds } }).populate('assignee', 'name').lean(),
    TicketEvent.find({
      ticket: { $in: scopeIds }, at: { $lte: end },
      type: { $in: ['created', 'status_changed', 'deleted', 'restored', 'blocked', 'unblocked'] },
    }).sort({ at: 1, _id: 1 }).lean(),
  ]);
  const ticketById = new Map(tickets.map((t) => [String(t._id), t]));
  for (const e of history) {
    const x = tl(String(e.ticket));
    if (e.type === 'created') x.status.push({ at: e.at, status: e.to?.status ?? null });
    if (e.type === 'status_changed') x.status.push({ at: e.at, status: e.to });
    if (e.type === 'deleted' || e.type === 'restored') x.binned.push({ at: e.at, on: e.type === 'deleted' });
    if (e.type === 'blocked' || e.type === 'unblocked') x.blocked.push({ at: e.at, on: e.type === 'blocked', reason: e.to?.reason ?? null });
  }

  const inSprintAt = (x, at) => Boolean(lastBefore(x.member, at)?.on) && !lastBefore(x.binned, at)?.on;
  const doneAt = (x, at) => done.has(lastBefore(x.status, at)?.status);

  const unitPoints = tickets.some((t) => pts(t) > 0);
  const weight = (id) => (unitPoints ? pts(ticketById.get(id)) : 1);

  const brief = (id) => {
    const t = ticketById.get(id);
    if (!t) return null;
    return {
      key: ticketKey(project, t.number),
      title: t.title,
      type: t.type,
      status: t.status,
      statusName: project.statuses.find((st) => st.key === t.status)?.name ?? t.status,
      storyPoints: t.storyPoints ?? null,
      assignee: t.assignee?.name ?? null,
      deleted: Boolean(t.deletedAt),
    };
  };

  // Who came and went while it ran.
  const lastInstant = new Date(+end - (s.closedAt ? 1 : 0));
  const added = scopeIds.filter((id) => !committed.includes(id));
  const removed = scopeIds.filter((id) => byTicket.get(id).member.some((m) => !m.on) && !inSprintAt(byTicket.get(id), lastInstant));
  const completedIds = s.state === 'closed'
    ? s.completed.map(String)
    : scopeIds.filter((id) => inSprintAt(byTicket.get(id), end) && doneAt(byTicket.get(id), end));
  const unfinishedIds = s.state === 'closed'
    ? s.unfinished.map(String)
    : scopeIds.filter((id) => inSprintAt(byTicket.get(id), end) && !doneAt(byTicket.get(id), end));

  // Where the work waited: time in each not-done column, and time blocked, while in the sprint.
  const statusMs = new Map();
  const blockedMs = new Map();
  const reasonMs = new Map();
  for (const [id, x] of byTicket) {
    const inside = spans(x.member, end);
    const within = (span) => inside.reduce((n, w) => n + overlap(span, w), 0);
    x.status.forEach((st, i) => {
      if (!st.status || done.has(st.status)) return;
      const ms = within([+st.at, +(x.status[i + 1]?.at ?? end)]);
      if (ms > 0) statusMs.set(st.status, (statusMs.get(st.status) ?? 0) + ms);
    });
    x.blocked.forEach((b, i) => {
      if (!b.on) return;
      const ms = within([+b.at, +(x.blocked[i + 1]?.at ?? end)]);
      if (ms <= 0) return;
      blockedMs.set(id, (blockedMs.get(id) ?? 0) + ms);
      const reason = b.reason ?? 'Blocked';
      reasonMs.set(reason, (reasonMs.get(reason) ?? 0) + ms);
    });
  }
  const waited = project.statuses
    .filter((st) => statusMs.has(st.key))
    .map((st) => ({ status: st.key, name: st.name, category: st.category, hours: hours(statusMs.get(st.key)) }));
  const blocked = {
    totalHours: hours([...blockedMs.values()].reduce((a, b) => a + b, 0)),
    byReason: [...reasonMs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, ms]) => ({ reason, hours: hours(ms) })),
    tickets: [...blockedMs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, ms]) => ({ ...brief(id), hours: hours(ms) })),
  };

  // Burndown: what was left at the end of each day, against a straight line to zero.
  const tz = config.timeZone;
  const firstDay = todayIn(tz, start);
  const lastPlanned = dayOf(s.endDate) < firstDay ? firstDay : dayOf(s.endDate);
  const endDay = todayIn(tz, end);
  const lastDay = endDay > lastPlanned ? endDay : lastPlanned;
  const committedTotal = committed.reduce((n, id) => n + weight(id), 0);
  const plannedDays = Math.max(1, Math.round((dayToDate(lastPlanned) - dayToDate(firstDay)) / 86400e3));
  const burndown = [];
  for (let d = firstDay, i = 0; d <= lastDay && i < 120; d = addDays(d, 1), i++) {
    const ideal = d <= lastPlanned ? Math.round(Math.max(0, committedTotal * (1 - i / plannedDays)) * 10) / 10 : 0;
    if (d > endDay) { burndown.push({ day: d, ideal, remaining: null, scope: null }); continue; }
    const at = new Date(Math.min(+startOfDayIn(addDays(d, 1), tz) - 1, +lastInstant));
    let scope = 0;
    let remaining = 0;
    for (const [id, x] of byTicket) {
      if (!inSprintAt(x, at)) continue;
      scope += weight(id);
      if (!doneAt(x, at)) remaining += weight(id);
    }
    burndown.push({ day: d, ideal, remaining, scope });
  }

  const carried = s.carriedTo ? await Sprint.findById(s.carriedTo, { name: 1 }).lean() : null;
  const total = (ids) => ({ count: ids.length, points: ids.reduce((n, id) => n + pts(ticketById.get(id)), 0) });
  const list = (ids) => ids.map((id) => {
    const b = brief(id);
    return b && { ...b, blockedHours: hours(blockedMs.get(id) ?? 0) };
  }).filter(Boolean);
  return {
    sprint: shapeSprint(s),
    unit: unitPoints ? 'points' : 'tickets',
    summary: {
      committed: total(committed),
      added: total(added),
      removed: total(removed),
      completed: total(completedIds),
      unfinished: total(unfinishedIds),
    },
    committed: list(committed),
    added: list(added),
    removed: list(removed),
    completed: list(completedIds),
    unfinished: list(unfinishedIds),
    carriedTo: carried ? sprintRef(carried) : null,
    waited,
    blocked,
    burndown,
  };
}

// ---------------------------------------------------------------------------------------------
// Milestones

export async function listMilestones(project) {
  const done = [...doneKeys(project)];
  const [milestones, counts] = await Promise.all([
    Milestone.find({ project: project._id }).lean(),
    Ticket.aggregate([
      { $match: { project: project._id, deletedAt: null, milestone: { $ne: null } } },
      {
        $group: {
          _id: '$milestone',
          total: { $sum: 1 },
          done: { $sum: { $cond: [{ $in: ['$status', done] }, 1, 0] } },
          points: { $sum: { $ifNull: ['$storyPoints', 0] } },
          pointsDone: { $sum: { $cond: [{ $in: ['$status', done] }, { $ifNull: ['$storyPoints', 0] }, 0] } },
        },
      },
    ]),
  ]);
  const by = new Map(counts.map((c) => [String(c._id), c]));
  const today = todayIn(config.timeZone);
  return milestones.map((m) => {
    const c = by.get(String(m._id)) ?? { total: 0, done: 0, points: 0, pointsDone: 0 };
    const due = dayOf(m.dueDate);
    const finished = c.total > 0 && c.done === c.total;
    return {
      ...shapeMilestone(m),
      progress: { total: c.total, done: c.done, points: c.points, pointsDone: c.pointsDone },
      daysLeft: due ? Math.round((dayToDate(due) - dayToDate(today)) / 86400e3) : null,
      overdue: Boolean(due && due < today && !finished && !m.closedAt),
    };
  }).sort((a, b) => Number(Boolean(a.closedAt)) - Number(Boolean(b.closedAt))
    || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.name.localeCompare(b.name));
}

const duplicateName = (e) => (e?.code === 11000 ? new HttpError(409, 'milestone_exists', 'There is already a milestone with that name') : e);

export async function createMilestone(project, { name, description = '', dueDate = null }) {
  if (await Milestone.countDocuments({ project: project._id }) >= MAX_MILESTONES) {
    throw new HttpError(400, 'too_many_milestones', `At most ${MAX_MILESTONES} milestones per project`);
  }
  try {
    return shapeMilestone(await Milestone.create({ project: project._id, name, description, dueDate }));
  } catch (e) { throw duplicateName(e); }
}

export async function updateMilestone(project, id, changes) {
  const m = await findMilestone(project, id);
  for (const k of ['name', 'description', 'dueDate']) if (changes[k] !== undefined) m[k] = changes[k];
  if (changes.closed !== undefined) m.closedAt = changes.closed ? (m.closedAt ?? new Date()) : null;
  try {
    await m.save();
  } catch (e) { throw duplicateName(e); }
  return shapeMilestone(m);
}

// Deleting a milestone keeps its tickets; they just stop counting towards it.
export async function deleteMilestone(project, actor, id) {
  const m = await findMilestone(project, id);
  const tickets = await Ticket.find({ milestone: m._id }, { _id: 1 }).lean();
  if (tickets.length) {
    await Ticket.updateMany({ milestone: m._id }, { $set: { milestone: null } });
    await TicketEvent.insertMany(tickets.map((t) => ({
      project: project._id, ticket: t._id, actor, type: 'relation_changed', field: 'milestone', from: milestoneRef(m), to: null,
    })));
  }
  await Milestone.deleteOne({ _id: m._id });
}
