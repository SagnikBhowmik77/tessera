import { config } from '../config.js';
import { addDays, startOfDayIn, todayIn } from '../dates.js';
import { Ticket, TicketEvent, User } from '../models/index.js';

// Flow analytics and board time travel, all computed by replaying the ticket history
// (TicketEvent rows, written since the first ticket). Nothing here is estimated: if a
// ticket's history says it sat in "In Progress" for 3 days, that is what is reported.

const BOARD_EVENTS = ['created', 'status_changed', 'deleted', 'restored'];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const round1 = (n) => Math.round(n * 10) / 10;

// Per ticket: when it was created and every moment its column changed
// (status null = in the bin).
async function loadTransitions(project, until) {
  const events = await TicketEvent.find(
    { project: project._id, type: { $in: BOARD_EVENTS }, at: { $lte: until } },
    { ticket: 1, type: 1, to: 1, at: 1 },
  ).sort({ at: 1, _id: 1 }).lean();
  const map = new Map();
  for (const e of events) {
    const id = String(e.ticket);
    if (e.type === 'created') {
      const status = e.to?.status ?? null;
      map.set(id, { id, createdAt: e.at, list: [{ at: e.at, status }], last: status });
      continue;
    }
    const t = map.get(id);
    if (!t) continue;
    if (e.type === 'status_changed') { t.list.push({ at: e.at, status: e.to }); t.last = e.to; }
    if (e.type === 'deleted') t.list.push({ at: e.at, status: null });
    if (e.type === 'restored') t.list.push({ at: e.at, status: t.last });
  }
  return map;
}

function statusAt(t, time) {
  let status = null;
  for (const x of t.list) {
    if (x.at > time) break;
    status = x.status;
  }
  return status;
}

// Nearest-rank percentile of a sorted list.
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

// Durations in milliseconds -> days (for the usual week-scale view) and hours (so work
// finished within a day doesn't read as "0 days").
function summary(durationsMs) {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const stat = (fn, unit) => (sorted.length ? round1(fn() / unit) : null);
  const median = () => percentile(sorted, 50);
  const p85 = () => percentile(sorted, 85);
  const mean = () => sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return {
    count: sorted.length,
    medianDays: stat(median, DAY),
    p85Days: stat(p85, DAY),
    averageDays: stat(mean, DAY),
    medianHours: stat(median, HOUR),
    p85Hours: stat(p85, HOUR),
    averageHours: stat(mean, HOUR),
  };
}

function eachDay(from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export async function projectAnalytics(project, { from, to, staleDays }) {
  const tz = config.timeZone;
  const now = new Date();
  const start = startOfDayIn(from, tz);
  const end = new Date(Math.min(startOfDayIn(addDays(to, 1), tz).getTime(), now.getTime()));

  const category = new Map(project.statuses.map((s) => [s.key, s.category]));
  const isDone = (key) => category.get(key) === 'done';
  const timelines = [...(await loadTransitions(project, end)).values()];
  const numbers = new Map((await Ticket.find({ project: project._id }, { number: 1 }).lean())
    .map((t) => [String(t._id), t.number]));

  // Cycle time: first entry into an "in progress" column -> entering "done".
  // Lead time: created -> done. A ticket counts once, by its latest completion in range,
  // and only if it is still done at the end of the range.
  const cycle = [];
  const lead = [];
  const resolvedPerDay = new Map();
  for (const t of timelines) {
    if (!isDone(statusAt(t, end))) continue;
    let resolvedAt = null;
    for (let i = 0; i < t.list.length; i += 1) {
      const enteredDone = isDone(t.list[i].status) && (i === 0 || !isDone(t.list[i - 1].status));
      if (enteredDone) resolvedAt = t.list[i].at;
    }
    if (!resolvedAt || resolvedAt < start) continue;
    const started = t.list.find((x) => x.at <= resolvedAt && category.get(x.status) === 'in_progress');
    const startedAt = started?.at ?? t.createdAt;
    const number = numbers.get(t.id);
    const point = { key: `${project.key}-${number}`, number, resolvedAt };
    const cycleMs = resolvedAt - startedAt;
    cycle.push({
      ...point, ms: cycleMs, days: round1(cycleMs / DAY), hours: Math.round((cycleMs / HOUR) * 100) / 100, skippedInProgress: !started,
    });
    lead.push(resolvedAt - t.createdAt);
    const day = todayIn(tz, resolvedAt);
    resolvedPerDay.set(day, (resolvedPerDay.get(day) || 0) + 1);
  }

  // Time in each column, clipped to the range.
  const inStatus = new Map();
  for (const t of timelines) {
    for (let i = 0; i < t.list.length; i += 1) {
      const { status, at } = t.list[i];
      if (!status) continue;
      const segStart = Math.max(at.getTime(), start.getTime());
      const segEnd = Math.min((t.list[i + 1]?.at ?? end).getTime(), end.getTime());
      if (segEnd <= segStart) continue;
      const row = inStatus.get(status) ?? { ms: 0, tickets: new Set() };
      row.ms += segEnd - segStart;
      row.tickets.add(t.id);
      inStatus.set(status, row);
    }
  }

  // Cumulative flow: how many tickets sat in each column at the end of each day.
  const days = eachDay(from, to);
  const knownKeys = project.statuses.map((s) => s.key);
  const extraKeys = new Set();
  const cfdDays = days.map((day) => {
    const dayEnd = new Date(Math.min(startOfDayIn(addDays(day, 1), tz).getTime(), now.getTime()));
    const counts = Object.fromEntries(knownKeys.map((k) => [k, 0]));
    for (const t of timelines) {
      if (t.createdAt > dayEnd) continue;
      const s = statusAt(t, dayEnd);
      if (!s) continue;
      if (!(s in counts)) { counts[s] = 0; extraKeys.add(s); }
      counts[s] += 1;
    }
    return { day, counts };
  });

  // Right now: tickets per column against its WIP limit.
  const current = await Ticket.aggregate([
    { $match: { project: project._id, deletedAt: null } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const countOf = new Map(current.map((c) => [c._id, c.n]));
  const wip = project.statuses.map((s) => ({
    key: s.key, name: s.name, category: s.category, count: countOf.get(s.key) ?? 0, limit: s.wipLimit ?? null,
    over: Boolean(s.wipLimit) && (countOf.get(s.key) ?? 0) > s.wipLimit,
  }));

  return {
    range: { from, to, timeZone: tz },
    wip,
    cycleTime: {
      ...summary(cycle.map((c) => c.ms)),
      points: cycle.sort((a, b) => a.resolvedAt - b.resolvedAt).map(({ ms, ...p }) => p),
    },
    leadTime: summary(lead),
    throughput: days.map((day) => ({ day, count: resolvedPerDay.get(day) ?? 0 })),
    timeInStatus: [...knownKeys, ...[...inStatus.keys()].filter((k) => !knownKeys.includes(k))].map((key) => {
      const row = inStatus.get(key);
      const status = project.statuses.find((s) => s.key === key);
      return {
        key,
        name: status?.name ?? key,
        totalHours: row ? round1(row.ms / HOUR) : 0,
        averageHours: row ? round1(row.ms / HOUR / row.tickets.size) : 0,
        tickets: row ? row.tickets.size : 0,
      };
    }),
    cfd: { statuses: [...knownKeys, ...extraKeys], days: cfdDays },
    stale: await staleTickets(project, staleDays, now),
    blocked: await blockedTimeIn(project, start, end),
  };
}

// Blocked time (E3): replays every blocked spell up to the end of the range ('blocked' starts or
// re-reasons a spell, 'unblocked' ends it), clips each to the range, and adds it up by reason and
// by ticket. Waiting on other tickets is one reason; flags keep the words people wrote.
async function blockedTimeIn(project, start, end) {
  const events = await TicketEvent.find(
    { project: project._id, type: { $in: ['blocked', 'unblocked'] }, at: { $lte: end } },
    { ticket: 1, type: 1, to: 1, at: 1 },
  ).sort({ at: 1, _id: 1 }).lean();
  const open = new Map(); // ticket -> { since, label }
  const byReason = new Map();
  const byTicket = new Map();
  const add = (ticket, label, from, to) => {
    const ms = Math.min(to, end) - Math.max(from, start);
    if (ms <= 0) return;
    byReason.set(label, (byReason.get(label) ?? 0) + ms);
    byTicket.set(ticket, (byTicket.get(ticket) ?? 0) + ms);
  };
  for (const e of events) {
    const id = String(e.ticket);
    const spell = open.get(id);
    if (spell) add(id, spell.label, spell.since, e.at);
    if (e.type === 'blocked') {
      open.set(id, { since: e.at, label: e.to?.kind === 'flag' ? e.to.reason : 'Waiting on other tickets' });
    } else {
      open.delete(id);
    }
  }
  for (const [id, spell] of open) add(id, spell.label, spell.since, end);

  const ids = [...byTicket.keys()];
  const tickets = new Map((await Ticket.find({ _id: { $in: ids } }, { number: 1, title: 1 }).lean()).map((t) => [String(t._id), t]));
  const totalMs = [...byTicket.values()].reduce((s, ms) => s + ms, 0);
  // Two decimals (36 seconds), so short spells still show as minutes rather than "0 h".
  const hours2 = (ms) => Math.round((ms / HOUR) * 100) / 100;
  return {
    totalHours: hours2(totalMs),
    tickets: ids.length,
    blockedNow: open.size,
    byReason: [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, ms]) => ({ reason, hours: hours2(ms) })),
    topTickets: [...byTicket].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, ms]) => {
      const t = tickets.get(id);
      return { key: t ? `${project.key}-${t.number}` : null, number: t?.number ?? null, title: t?.title ?? '(deleted)', hours: hours2(ms) };
    }),
  };
}

// Open tickets nobody has touched (moved, edited, commented, attached) for `staleDays`.
async function staleTickets(project, staleDays, now) {
  const done = project.statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const open = await Ticket.find(
    { project: project._id, deletedAt: null, status: { $nin: done } },
    { number: 1, title: 1, status: 1, assignee: 1, updatedAt: 1 },
  ).populate('assignee', 'name email').lean();
  if (!open.length) return [];
  const last = await TicketEvent.aggregate([
    { $match: { project: project._id, ticket: { $in: open.map((t) => t._id) } } },
    { $group: { _id: '$ticket', at: { $max: '$at' } } },
  ]);
  const lastAt = new Map(last.map((l) => [String(l._id), l.at]));
  return open
    .map((t) => {
      const activity = new Date(Math.max(t.updatedAt.getTime(), lastAt.get(String(t._id))?.getTime() ?? 0));
      return {
        key: `${project.key}-${t.number}`, number: t.number, title: t.title, status: t.status,
        assignee: t.assignee ? { id: String(t.assignee._id), name: t.assignee.name } : null,
        lastActivityAt: activity, idleDays: round1((now - activity) / DAY),
      };
    })
    .filter((t) => t.idleDays >= staleDays)
    .sort((a, b) => b.idleDays - a.idleDays)
    .slice(0, 100);
}

// Board time travel: the board exactly as it was at `at`, rebuilt by undoing every change
// made since (column, title, priority, type, labels, due date, points, assignee, bin).
export async function boardAt(project, at) {
  const tickets = await Ticket.find({ project: project._id, createdAt: { $lte: at } }).lean();
  const state = new Map(tickets.map((t) => [String(t._id), {
    number: t.number,
    title: t.title,
    type: t.type,
    priority: t.priority,
    labels: [...t.labels],
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
    storyPoints: t.storyPoints,
    assignee: t.assignee ? String(t.assignee) : null,
    status: t.status,
    inBin: Boolean(t.deletedAt),
  }]));
  const later = await TicketEvent.find(
    { project: project._id, at: { $gt: at }, type: { $in: ['updated', 'assigned', 'status_changed', 'deleted', 'restored'] } },
    { ticket: 1, type: 1, field: 1, from: 1, at: 1 },
  ).sort({ at: -1, _id: -1 }).lean();
  for (const e of later) {
    const s = state.get(String(e.ticket));
    if (!s) continue;
    if (e.type === 'updated' && e.field in s) s[e.field] = e.from;
    if (e.type === 'assigned') s.assignee = e.from ? String(e.from) : null;
    if (e.type === 'status_changed') s.status = e.from;
    if (e.type === 'deleted') s.inBin = false;
    if (e.type === 'restored') s.inBin = true;
  }

  const live = [...state.values()].filter((s) => !s.inBin);
  const people = await User.find({ _id: { $in: [...new Set(live.map((s) => s.assignee).filter(Boolean))] } }, 'name').lean();
  const nameOf = new Map(people.map((p) => [String(p._id), p.name]));
  const columns = project.statuses.map((s) => ({ key: s.key, name: s.name, category: s.category, tickets: [] }));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const s of live.sort((a, b) => a.number - b.number)) {
    if (!byKey.has(s.status)) {
      // A column that has since been removed.
      const col = { key: s.status, name: s.status, category: null, removed: true, tickets: [] };
      columns.push(col);
      byKey.set(s.status, col);
    }
    const { inBin, assignee, ...card } = s;
    byKey.get(s.status).tickets.push({
      ...card,
      key: `${project.key}-${s.number}`,
      assignee: assignee ? { id: assignee, name: nameOf.get(assignee) ?? 'Former member' } : null,
    });
  }
  return { at, columns, total: live.length };
}

// Ageing work: how long each card in an "in progress" column has been in progress, compared
// with the team's own 85th-percentile cycle time over the last 90 days. A card older than
// that is taking longer than 85% of recently finished work did. With fewer than
// AGEING_MIN_SAMPLE finished tickets there is no honest "usual", so nothing is flagged.
export const AGEING_MIN_SAMPLE = 5;
const AGEING_WINDOW_DAYS = 90;

export async function projectAgeing(project, now = new Date()) {
  const category = new Map(project.statuses.map((s) => [s.key, s.category]));
  const isDone = (key) => category.get(key) === 'done';
  const isWorking = (key) => category.get(key) === 'in_progress';
  const since = new Date(now.getTime() - AGEING_WINDOW_DAYS * DAY);
  const timelines = [...(await loadTransitions(project, now)).values()];

  // Cycle times of work finished in the window (same rule as the analytics page).
  const cycles = [];
  for (const t of timelines) {
    if (!isDone(t.last) || statusAt(t, now) === null) continue;
    let resolvedAt = null;
    for (let i = 0; i < t.list.length; i += 1) {
      if (isDone(t.list[i].status) && (i === 0 || !isDone(t.list[i - 1].status))) resolvedAt = t.list[i].at;
    }
    if (!resolvedAt || resolvedAt < since) continue;
    const started = t.list.find((x) => x.at <= resolvedAt && isWorking(x.status));
    cycles.push(resolvedAt - (started?.at ?? t.createdAt));
  }
  cycles.sort((a, b) => a - b);
  const p85 = cycles.length >= AGEING_MIN_SAMPLE ? percentile(cycles, 85) : null;

  // Age of each card in progress now: since it last entered in-progress from somewhere else
  // (a ticket reopened from Done starts a new stretch).
  const numbers = new Map((await Ticket.find({ project: project._id, deletedAt: null }, { number: 1 }).lean())
    .map((t) => [String(t._id), t.number]));
  const tickets = [];
  for (const t of timelines) {
    if (!numbers.has(t.id) || !isWorking(statusAt(t, now))) continue;
    let startedAt = null;
    let prev = null;
    for (const x of t.list) {
      if (x.at > now) break;
      if (isWorking(x.status) && !isWorking(prev)) startedAt = x.at;
      if (!isWorking(x.status)) startedAt = null;
      prev = x.status;
    }
    if (!startedAt) continue;
    const ageMs = now - startedAt;
    tickets.push({
      number: numbers.get(t.id),
      startedAt,
      ageHours: Math.round((ageMs / HOUR) * 10) / 10,
      ratio: p85 ? Math.round((ageMs / p85) * 100) / 100 : null,
      ageing: p85 !== null && ageMs > p85,
    });
  }
  tickets.sort((a, b) => b.ageHours - a.ageHours);
  return {
    p85Hours: p85 === null ? null : Math.round((p85 / HOUR) * 10) / 10,
    sample: cycles.length,
    minSample: AGEING_MIN_SAMPLE,
    windowDays: AGEING_WINDOW_DAYS,
    tickets,
  };
}
