import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { addDays, startOfDayIn, todayIn } from '../dates.js';
import { Sprint, Ticket, TicketEvent, User } from '../models/index.js';
import { boardAt, projectAnalytics } from './flow.service.js';
import { slaOf } from './sla.service.js';
import { MIN_FINISHED, monteCarlo, pct } from '../flow/montecarlo.js';

// Flow analytics II (E9). Everything comes from the ticket history and today's board; the
// forecast is a Monte Carlo simulation of the team's own daily throughput, and every number
// says what it is made of. When there isn't enough history, it says so instead of guessing.

const DAY = 24 * 3600 * 1000;
const tz = () => config.timeZone;
const dayOf = (d) => todayIn(tz(), new Date(d));
const round1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const doneKeys = (project) => new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));
const catOf = (project, key) => project.statuses.find((s) => s.key === key)?.category ?? null;
const keyOf = (project, n) => `${project.key}-${n}`;

// ---------- throughput and the Monte Carlo forecast ----------

// Tickets finished per calendar day (team time zone) over the last `days` days, today excluded.
export async function dailyThroughput(project, days = 42, now = new Date()) {
  const done = doneKeys(project);
  const today = dayOf(now);
  const first = addDays(today, -days);
  const since = startOfDayIn(first, tz());
  const until = startOfDayIn(today, tz());
  const events = await TicketEvent.find({ project: project._id, type: 'status_changed', at: { $gte: since, $lt: until } }, { from: 1, to: 1, at: 1 }).lean();
  const counts = new Map();
  for (const e of events) if (done.has(e.to) && !done.has(e.from)) counts.set(dayOf(e.at), (counts.get(dayOf(e.at)) ?? 0) + 1);
  const samples = [];
  for (let d = first; d < today; d = addDays(d, 1)) samples.push(counts.get(d) ?? 0);
  return samples;
}

// The forecast itself is pure arithmetic, shared with the landing page demo.
export { monteCarlo };

async function scopeItems(project, scope) {
  const done = [...doneKeys(project)];
  const base = { project: project._id, deletedAt: null, triage: { $ne: true }, status: { $nin: done }, type: { $ne: 'epic' } };
  if (!scope || scope === 'open') return { label: 'all open tickets', count: await Ticket.countDocuments(base) };
  if (scope === 'sprint') {
    const sprint = await Sprint.findOne({ project: project._id, state: 'active' }).lean();
    if (!sprint) throw new HttpError(400, 'no_active_sprint', 'There is no running sprint');
    return { label: `open tickets in ${sprint.name}`, count: await Ticket.countDocuments({ ...base, sprint: sprint._id }) };
  }
  const m = /^epic:(\d+)$/.exec(scope);
  if (m) {
    const epic = await Ticket.findOne({ project: project._id, number: Number(m[1]), type: 'epic' }).lean();
    if (!epic) throw new HttpError(404, 'epic_not_found', 'No such epic');
    return { label: `open tickets in ${keyOf(project, epic.number)}`, count: await Ticket.countDocuments({ ...base, epic: epic._id }) };
  }
  throw new HttpError(400, 'bad_scope', 'Scope is open, sprint or epic:<number>');
}

export { MIN_FINISHED };

export async function forecast(project, { scope = 'open', add = 0, factor = 1, days = null, now = new Date() } = {}) {
  const samples = await dailyThroughput(project, 42, now);
  const total = samples.reduce((s, x) => s + x, 0);
  const sc = await scopeItems(project, scope);
  const items = Math.max(0, sc.count + add);
  const sample = { days: samples.length, finished: total, zeroDays: samples.filter((x) => !x).length, perDay: round1(total / samples.length) };
  if (total < MIN_FINISHED) {
    return { scope: sc.label, items, sample, enough: false, reason: `Only ${total} ticket${total === 1 ? '' : 's'} finished in the last ${samples.length} days; a forecast needs at least ${MIN_FINISHED}.` };
  }
  const sim = monteCarlo({ samples, items: items || null, days, factor });
  const date = (d) => addDays(dayOf(now), d);
  return {
    scope: sc.label, items, add, factor, sample, enough: true,
    ...(sim.whenDone && { whenDone: Object.fromEntries(Object.entries(sim.whenDone).map(([k, d]) => [k, { days: d, date: date(d) }])) }),
    ...(sim.howMany && { howMany: { days, ...sim.howMany } }),
  };
}

// ---------- next best ticket ----------

export async function nextBest(project, user, now = new Date()) {
  const done = [...doneKeys(project)];
  const me = String(user._id);
  const tickets = await Ticket.find({
    project: project._id, deletedAt: null, triage: { $ne: true }, status: { $nin: done }, type: { $ne: 'epic' },
    $or: [{ assignee: user._id }, { assignee: null }],
  }).lean();
  const ids = tickets.map((t) => t._id);
  const waiting = await Ticket.find({ project: project._id, deletedAt: null, status: { $nin: done }, blockedBy: { $in: ids } }, { number: 1, blockedBy: 1 }).lean();
  const sprint = await Sprint.findOne({ project: project._id, state: 'active' }, { _id: 1 }).lean();
  const today = dayOf(now);
  const scored = tickets.map((t) => {
    const reasons = [];
    let score = 0;
    const cat = catOf(project, t.status);
    if (cat === 'in_progress' && String(t.assignee) === me) { score += 40; reasons.push('you already started it'); }
    const unblocks = waiting.filter((w) => w.blockedBy.some((b) => String(b) === String(t._id))).map((w) => keyOf(project, w.number));
    if (unblocks.length) { score += Math.min(30, 15 * unblocks.length); reasons.push(`unblocks ${unblocks.join(', ')}`); }
    if (t.dueDate) {
      const due = t.dueDate.toISOString().slice(0, 10);
      if (due < today) { score += 35; reasons.push(`overdue since ${due}`); } else if (due <= addDays(today, 2)) { score += 20; reasons.push(`due ${due}`); } else if (due <= addDays(today, 7)) { score += 10; reasons.push(`due ${due}`); }
    }
    const sla = slaOf(project, t, now);
    const states = [sla?.response?.state, sla?.resolve?.state];
    if (states.includes('breached')) { score += 30; reasons.push('past its service-level target'); } else if (states.includes('at_risk')) { score += 20; reasons.push('close to its service-level target'); }
    score += { critical: 30, high: 18, medium: 6, low: 0 }[t.priority] ?? 0;
    if (['critical', 'high'].includes(t.priority)) reasons.push(`${t.priority} priority`);
    if (sprint && String(t.sprint) === String(sprint._id)) { score += 10; reasons.push('in the running sprint'); }
    if (t.blockedSince) { score -= 50; reasons.push(`blocked${t.blockedReason ? `: ${t.blockedReason}` : ''}`); }
    if (!t.assignee) { score -= 5; reasons.push('nobody owns it yet'); }
    return { key: keyOf(project, t.number), number: t.number, title: t.title, priority: t.priority, status: t.status, mine: String(t.assignee) === me, score, reasons };
  });
  return scored.sort((a, b) => b.score - a.score || a.number - b.number).slice(0, 5);
}

// ---------- insights: WIP suggestions, estimates, rework, work mix, bottlenecks ----------

export async function insights(project, now = new Date()) {
  const to = dayOf(now);
  const from = addDays(to, -29);
  const a = await projectAnalytics(project, { from, to, staleDays: 7 });
  const finished = a.throughput.reduce((s, d) => s + d.count, 0);
  const perDay = finished / a.throughput.length;
  const done = doneKeys(project);
  const live = await Ticket.find({ project: project._id, deletedAt: null, triage: { $ne: true }, status: { $nin: [...done] } }, { status: 1, blockedSince: 1 }).lean();
  const nowCount = new Map();
  const blockedNow = new Map();
  for (const t of live) {
    nowCount.set(t.status, (nowCount.get(t.status) ?? 0) + 1);
    if (t.blockedSince) blockedNow.set(t.status, (blockedNow.get(t.status) ?? 0) + 1);
  }

  // WIP limits from Little's law: to finish `perDay` tickets a day with a typical `d` days in a
  // column, about perDay * d tickets need to be in it at once. Holding many more means waiting.
  const wip = [];
  if (finished >= MIN_FINISHED) {
    for (const s of project.statuses.filter((x) => x.category === 'in_progress')) {
      const counts = a.cfd.days.map((d) => d.counts[s.key] ?? 0);
      const inCol = a.timeInStatus.find((x) => x.key === s.key);
      const days = inCol?.averageHours ? inCol.averageHours / 24 : null;
      if (days === null) continue;
      const suggested = Math.max(1, Math.ceil(perDay * days));
      const med = median(counts);
      wip.push({
        status: s.key, name: s.name, limit: s.wipLimit ?? null, now: nowCount.get(s.key) ?? 0, medianWip: med, maxWip: Math.max(...counts),
        daysInColumn: round1(days), suggested,
        reason: `Finishing ${round1(perDay)} tickets a day with about ${round1(days)} days in ${s.name} needs about ${suggested} there at once (Little's law). It held a median of ${med}${med > suggested ? ', so work waits there' : ''}.`,
      });
    }
  }

  // Estimate accuracy: did bigger estimates take longer?
  const doneTickets = await Ticket.find({ project: project._id, deletedAt: null, resolvedAt: { $gte: new Date(+now - 90 * DAY) }, storyPoints: { $ne: null } }, { storyPoints: 1, resolvedAt: 1, createdAt: 1, number: 1 }).lean();
  const starts = await TicketEvent.find({ ticket: { $in: doneTickets.map((t) => t._id) }, type: 'status_changed' }, { ticket: 1, from: 1, at: 1 }).sort({ at: 1 }).lean();
  const startOf = new Map();
  for (const e of starts) if (catOf(project, e.from) === 'todo' && !startOf.has(String(e.ticket))) startOf.set(String(e.ticket), e.at);
  const pairs = doneTickets.map((t) => ({ points: t.storyPoints, days: (+t.resolvedAt - +(startOf.get(String(t._id)) ?? t.createdAt)) / DAY })).filter((p) => p.days >= 0);
  const byPoints = new Map();
  for (const p of pairs) { if (!byPoints.has(p.points)) byPoints.set(p.points, []); byPoints.get(p.points).push(p.days); }
  const rho = spearman(pairs.map((p) => p.points), pairs.map((p) => p.days));
  const estimates = {
    tickets: pairs.length,
    groups: [...byPoints].sort((x, y) => x[0] - y[0]).map(([points, ds]) => ({ points, tickets: ds.length, medianDays: round1(median(ds)), minDays: round1(Math.min(...ds)), maxDays: round1(Math.max(...ds)) })),
    rho: rho === null ? null : Math.round(rho * 100) / 100,
    verdict: pairs.length < MIN_FINISHED ? `Only ${pairs.length} finished ticket${pairs.length === 1 ? '' : 's'} with story points in 90 days; not enough to judge.`
      : rho >= 0.5 ? 'Bigger estimates did take longer.' : rho >= 0.2 ? 'Bigger estimates took a little longer, loosely.' : 'Estimates said little about how long work took.',
  };

  // Rework: finished in the last 30 days and then reopened.
  const since30 = new Date(+now - 30 * DAY);
  const moves = await TicketEvent.find({ project: project._id, type: { $in: ['status_changed', 'error_recurred'] }, at: { $gte: since30 } }, { ticket: 1, type: 1, from: 1, to: 1, at: 1, source: 1 }).sort({ at: 1 }).lean();
  const finishedIds = new Set();
  const reopened = new Map();
  for (const e of moves) {
    if (e.type !== 'status_changed') continue;
    if (done.has(e.to) && !done.has(e.from)) finishedIds.add(String(e.ticket));
    if (done.has(e.from) && !done.has(e.to) && finishedIds.has(String(e.ticket))) {
      const crash = moves.some((x) => x.type === 'error_recurred' && String(x.ticket) === String(e.ticket) && +x.at === +e.at);
      reopened.set(String(e.ticket), crash ? 'crash' : e.source === 'github' ? 'github' : 'hand');
    }
  }
  const why = [...reopened.values()];
  const rework = {
    finished: finishedIds.size, reopened: reopened.size,
    rate: finishedIds.size ? Math.round((reopened.size / finishedIds.size) * 100) : null,
    byCrash: why.filter((w) => w === 'crash').length, byHand: why.filter((w) => w === 'hand').length, byGithub: why.filter((w) => w === 'github').length,
  };

  // Work mix: what the finished work was, by type and label, per week (last 12 weeks).
  const mixTickets = await Ticket.find({ project: project._id, deletedAt: null, resolvedAt: { $gte: new Date(+now - 84 * DAY) } }, { type: 1, labels: 1, resolvedAt: 1 }).lean();
  const weeks = [];
  for (let w = 11; w >= 0; w -= 1) {
    const start = new Date(+now - (w + 1) * 7 * DAY);
    const end = new Date(+now - w * 7 * DAY);
    const these = mixTickets.filter((t) => t.resolvedAt >= start && t.resolvedAt < end);
    weeks.push({ week: dayOf(start), bug: these.filter((t) => t.type === 'bug').length, feature: these.filter((t) => t.type === 'feature').length, task: these.filter((t) => t.type === 'task').length });
  }
  const labelCount = new Map();
  for (const t of mixTickets) for (const l of t.labels ?? []) labelCount.set(l, (labelCount.get(l) ?? 0) + 1);
  const mix = { weeks, total: mixTickets.length, labels: [...labelCount].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([label, count]) => ({ label, count })) };

  return { window: { from, to, finished, perDay: round1(perDay) }, wip, estimates, rework, mix, bottlenecks: explain(project, a, nowCount, blockedNow, wip) };
}

function spearman(xs, ys) {
  if (xs.length < 3) return null;
  const rank = (v) => {
    const sorted = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j += 1;
      for (let k = i; k <= j; k += 1) r[sorted[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((s, x) => s + x, 0) / rx.length;
  const my = ry.reduce((s, x) => s + x, 0) / ry.length;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < rx.length; i += 1) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// Plain-language reasons work is slow, each from a rule that can be checked against the numbers.
function explain(project, a, nowCount, blockedNow, wip) {
  const out = [];
  for (const s of project.statuses.filter((x) => x.category === 'in_progress')) {
    const n = nowCount.get(s.key) ?? 0;
    if (s.wipLimit && n > s.wipLimit) out.push({ severity: 'high', status: s.key, text: `${s.name} holds ${n} tickets, over its limit of ${s.wipLimit}.` });
    const blocked = blockedNow.get(s.key) ?? 0;
    if (blocked && n && blocked / n >= 0.3) out.push({ severity: 'medium', status: s.key, text: `${blocked} of ${n} tickets in ${s.name} are blocked.` });
  }
  const timed = a.timeInStatus.filter((x) => x.averageHours && project.statuses.find((s) => s.key === x.key)?.category === 'in_progress').sort((x, y) => y.averageHours - x.averageHours);
  const totalHours = timed.reduce((s, x) => s + x.averageHours, 0);
  if (timed.length > 1 && timed[0].averageHours / totalHours >= 0.5) {
    out.push({ severity: 'medium', status: timed[0].key, text: `Of the time tickets spend in progress, ${Math.round((timed[0].averageHours / totalHours) * 100)}% is in ${timed[0].name} (about ${round1(timed[0].averageHours / 24)} days on average).` });
  }
  for (const w of wip) if (w.medianWip > w.suggested * 1.5 && w.medianWip >= 3) out.push({ severity: 'medium', status: w.status, text: `${w.name} usually holds ${w.medianWip} tickets but the team's pace only needs about ${w.suggested}: work queues there.` });
  // A column that grew steadily over the last two weeks.
  const last = a.cfd.days.slice(-14);
  if (last.length >= 7) {
    for (const s of project.statuses.filter((x) => x.category === 'in_progress')) {
      const first = last[0].counts[s.key] ?? 0;
      const end = last.at(-1).counts[s.key] ?? 0;
      if (end - first >= 3 && end >= first * 1.5) out.push({ severity: 'low', status: s.key, text: `${s.name} grew from ${first} to ${end} tickets over the last ${last.length} days.` });
    }
  }
  return out;
}

// ---------- automatic standup ----------

export async function standup(project, now = new Date()) {
  // Since the start of the previous working day (Monday looks back to Friday).
  const today = dayOf(now);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const back = weekday === 1 ? 3 : weekday === 0 ? 2 : 1;
  const since = startOfDayIn(addDays(today, -back), tz());
  const done = doneKeys(project);
  const people = project.members.filter((m) => m.role !== 'viewer').map((m) => String(m.user?._id ?? m.user));
  const users = await User.find({ _id: { $in: people } }, { name: 1 }).lean();
  const events = await TicketEvent.find({ project: project._id, at: { $gte: since }, actor: { $in: people }, type: { $in: ['status_changed', 'commented', 'created'] } }, { actor: 1, ticket: 1, type: 1, from: 1, to: 1 }).lean();
  const tickets = await Ticket.find({ project: project._id, deletedAt: null, $or: [{ _id: { $in: events.map((e) => e.ticket) } }, { assignee: { $in: people } }] }, { number: 1, title: 1, status: 1, assignee: 1, blockedSince: 1, blockedReason: 1 }).lean();
  const byId = new Map(tickets.map((t) => [String(t._id), t]));
  const label = (t) => `${keyOf(project, t.number)} ${t.title}`;
  const rows = users.map((u) => {
    const id = String(u._id);
    const mine = events.filter((e) => String(e.actor) === id);
    const finished = [...new Set(mine.filter((e) => e.type === 'status_changed' && done.has(e.to) && !done.has(e.from)).map((e) => String(e.ticket)))];
    const moved = [...new Set(mine.filter((e) => e.type === 'status_changed' && !done.has(e.to)).map((e) => String(e.ticket)))].filter((x) => !finished.includes(x));
    const comments = mine.filter((e) => e.type === 'commented').length;
    const assigned = tickets.filter((t) => String(t.assignee) === id && catOf(project, t.status) === 'in_progress');
    const blocked = tickets.filter((t) => String(t.assignee) === id && t.blockedSince && !done.has(t.status));
    return {
      id, name: u.name,
      finished: finished.map((x) => byId.get(x)).filter(Boolean).map(label),
      moved: moved.map((x) => byId.get(x)).filter(Boolean).map(label),
      comments,
      today: assigned.filter((t) => !t.blockedSince).map(label),
      blocked: blocked.map((t) => `${label(t)}${t.blockedReason ? ` (${t.blockedReason})` : ''}`),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const text = rows.map((r) => [
    `*${r.name}*`,
    `Since ${addDays(today, -back)}: ${r.finished.length ? `finished ${r.finished.join('; ')}` : 'nothing finished'}${r.moved.length ? `; moved ${r.moved.join('; ')}` : ''}${r.comments ? `; ${r.comments} comment${r.comments === 1 ? '' : 's'}` : ''}.`,
    `Today: ${r.today.length ? r.today.join('; ') : 'nothing in progress'}.`,
    r.blocked.length ? `Blocked: ${r.blocked.join('; ')}.` : null,
  ].filter(Boolean).join('\n')).join('\n\n');
  return { since: addDays(today, -back), people: rows, text };
}

// ---------- compare two dates ----------

export async function compareDates(project, from, to) {
  if (!(from < to)) throw new HttpError(400, 'bad_range', 'The first date must be before the second');
  const [a, b] = await Promise.all([boardAt(project, from), boardAt(project, to)]);
  const flat = (board) => new Map(board.columns.flatMap((c) => c.tickets.map((t) => [t.key, { ...t, status: c.key, category: c.category }])));
  const A = flat(a);
  const B = flat(b);
  const added = [...B.values()].filter((t) => !A.has(t.key));
  const removed = [...A.values()].filter((t) => !B.has(t.key));
  const moved = [...B.values()].filter((t) => A.has(t.key) && A.get(t.key).status !== t.status).map((t) => ({ key: t.key, title: t.title, from: A.get(t.key).status, to: t.status, finished: t.category === 'done' && A.get(t.key).category !== 'done' }));
  const reassigned = [...B.values()].filter((t) => A.has(t.key) && (A.get(t.key).assignee?.id ?? null) !== (t.assignee?.id ?? null)).map((t) => ({ key: t.key, title: t.title, from: A.get(t.key).assignee?.name ?? null, to: t.assignee?.name ?? null }));
  const count = (m, key) => [...m.values()].filter((t) => t.status === key).length;
  return {
    from, to,
    columns: project.statuses.map((s) => ({ key: s.key, name: s.name, from: count(A, s.key), to: count(B, s.key) })),
    added: added.map((t) => ({ key: t.key, title: t.title, status: t.status })),
    removed: removed.map((t) => ({ key: t.key, title: t.title })),
    moved, reassigned,
    finished: moved.filter((m) => m.finished).length,
  };
}

// ---------- Project Mosaic: one tile per ticket ----------

export async function mosaic(project, now = new Date()) {
  const rows = await Ticket.find({ project: project._id, deletedAt: null, triage: { $ne: true } }, { number: 1, title: 1, type: 1, status: 1, priority: 1, createdAt: 1, resolvedAt: 1, blockedSince: 1, epic: 1, error: 1 }).sort({ number: 1 }).limit(2000).lean();
  const epics = new Map(rows.filter((t) => t.type === 'epic').map((t) => [String(t._id), t.number]));
  return rows.filter((t) => t.type !== 'epic').map((t) => ({
    key: keyOf(project, t.number), title: t.title, type: t.type, priority: t.priority, status: t.status, category: catOf(project, t.status),
    ageDays: round1(((t.resolvedAt ?? now) - t.createdAt) / DAY), blocked: Boolean(t.blockedSince), crash: Boolean(t.error),
    epic: t.epic ? (epics.has(String(t.epic)) ? keyOf(project, epics.get(String(t.epic))) : null) : null,
  }));
}
