import { createHash } from 'node:crypto';
import { HttpError } from '../errors.js';
import { ErrorOccurrence, Ticket, TicketEvent } from '../models/index.js';
import { normalizeMessage } from '../bugs/stacktrace.js';
import { addDays, todayIn } from '../dates.js';

// Bug intelligence II (E5A): the history behind an error's count, and what it tells you:
// how much it hurts (impact), when it came and went (timeline), where it happens
// (environments), how it was fixed before (fix memory), and muting a known, accepted error.

const DAY = 24 * 3600 * 1000;
const keyOf = (project, number) => `${project.key}-${number}`;
const doneKeys = (project) => new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));

// ---------- recording ----------

// "user:<id>" for a teammate, "email:<hash>" for an outside reporter, so distinct people can be
// counted without copying anyone's address into the history.
export function whoOf(actor, contact) {
  if (actor) return `user:${actor}`;
  const email = contact?.email?.trim().toLowerCase();
  return email ? `email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}` : null;
}

export function recordOccurrence(project, ticket, { at, actor = null, contact = null, source = 'app', environment = null, regression = false, muted = false, release = null, appEnvironment = null, page = null, who = null }) {
  return ErrorOccurrence.create({
    project: project._id, ticket: ticket._id, at, source: ['portal', 'sdk'].includes(source) ? source : 'app',
    who: who ?? whoOf(actor, contact), environment: environment ?? null, regression, muted, release, appEnvironment, page,
  });
}

// ---------- muting ----------

export const MUTE_FOR = { '1h': 3600 * 1000, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, forever: null };

export function isMuted(error, now = new Date()) {
  const m = error?.muted;
  if (!m?.at) return false;
  return Boolean(m.forever || (m.until && new Date(m.until) > now));
}

// While muted, reports are still counted and kept, but they don't reopen the ticket,
// notify anyone, run automation rules or (E5B) raise spike alerts.
export async function muteError(project, ticket, actor, { for: span, reason }) {
  if (!ticket.error) throw new HttpError(400, 'not_an_error', 'Only tickets made from an error can be muted');
  if (ticket.deletedAt) throw new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');
  if (!(span in MUTE_FOR)) throw new HttpError(400, 'bad_span', 'Mute for 1h, 1d, 7d, 30d or forever');
  const at = new Date();
  const forever = span === 'forever';
  ticket.error.muted = { at, by: actor, until: forever ? null : new Date(at.getTime() + MUTE_FOR[span]), forever, reason: reason?.trim() || null };
  ticket.markModified('error');
  await ticket.save();
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor, type: 'error_muted', at,
    to: { until: ticket.error.muted.until, forever, reason: ticket.error.muted.reason },
  });
}

export async function unmuteError(project, ticket, actor) {
  if (!ticket.error?.muted?.at) return false;
  const wasActive = isMuted(ticket.error);
  ticket.error.muted = null;
  ticket.markModified('error');
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor, type: 'error_unmuted', at: new Date(), to: { early: wasActive } });
  return true;
}

export function muteJson(error, now = new Date()) {
  const m = error?.muted;
  if (!m?.at) return null;
  return { active: isMuted(error, now), at: m.at, until: m.until ?? null, forever: Boolean(m.forever), reason: m.reason ?? null, by: m.by ? String(m.by._id ?? m.by) : null };
}

// ---------- impact ----------

const PRIORITY_POINTS = { low: 0, medium: 5, high: 12, critical: 20 };
const curve = (n, step, max) => Math.min(max, Math.round(step * Math.log2(1 + n)));

// A 0-100 score from four things the team can check, each with its own share:
// reports in the last 7 days (up to 40), distinct people in the last 30 days (up to 25),
// times it came back after being fixed (up to 15), and the ticket's priority (up to 20).
export function impactScore({ recent, people, comebacks, priority }) {
  const parts = [
    { key: 'frequency', label: 'Reports in the last 7 days', value: recent, points: curve(recent, 10, 40), max: 40 },
    { key: 'reach', label: 'People affected in the last 30 days', value: people, points: curve(people, 8, 25), max: 25 },
    { key: 'comebacks', label: 'Came back after a fix', value: comebacks, points: Math.min(15, Math.round(comebacks * 7.5)), max: 15 },
    { key: 'priority', label: 'Priority', value: priority, points: PRIORITY_POINTS[priority] ?? 0, max: 20 },
  ];
  const score = Math.min(100, parts.reduce((s, p) => s + p.points, 0));
  const level = score >= 60 ? 'severe' : score >= 35 ? 'high' : score >= 15 ? 'moderate' : 'low';
  return { score, level, parts };
}

// Counts for many tickets in one query (the error list), keyed by ticket id.
export async function impactInputs(projectId, ticketIds, now = new Date()) {
  if (!ticketIds.length) return new Map();
  const rows = await ErrorOccurrence.aggregate([
    { $match: { project: projectId, ticket: { $in: ticketIds } } },
    {
      $group: {
        _id: '$ticket',
        tracked: { $sum: 1 },
        recent: { $sum: { $cond: [{ $gte: ['$at', new Date(+now - 7 * DAY)] }, 1, 0] } },
        people: { $addToSet: { $cond: [{ $and: [{ $gte: ['$at', new Date(+now - 30 * DAY)] }, { $ne: ['$who', null] }] }, '$who', '$$REMOVE'] } },
        comebacks: { $sum: { $cond: ['$regression', 1, 0] } },
        browsers: { $push: '$environment.browser' },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), {
    tracked: r.tracked, recent: r.recent, people: r.people.length, comebacks: r.comebacks, browsers: r.browsers.filter(Boolean),
  }]));
}

// ---------- environments ----------

const family = (browser) => (browser ? browser.replace(/\s+\d+$/, '') : null);

// Where it happens, most affected first. Reports with no browser/OS are counted apart, not guessed.
function tallyField(rows, field) {
  const m = new Map();
  for (const r of rows) if (r[field]) m.set(r[field], (m.get(r[field]) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function environmentsOf(rows) {
  const tally = (pick) => {
    const m = new Map();
    for (const r of rows) {
      const k = pick(r.environment);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  const known = rows.filter((r) => r.environment?.browser || r.environment?.os).length;
  return {
    total: rows.length,
    unknown: rows.length - known,
    browsers: tally((e) => family(e?.browser)),
    versions: tally((e) => e?.browser ?? null),
    os: tally((e) => e?.os ?? null),
    combos: tally((e) => (e?.browser || e?.os ? [e.browser, e.os].filter(Boolean).join(' on ') : null)),
    // From apps using the SDK (E6A).
    releases: tallyField(rows, 'release'),
    appEnvironments: tallyField(rows, 'appEnvironment'),
    pages: tallyField(rows, 'page'),
  };
}

// Most common browser family in a list of "Chrome 130"-style names (for the error list).
export function topBrowser(browsers) {
  const m = new Map();
  for (const b of browsers) m.set(family(b), (m.get(family(b)) ?? 0) + 1);
  const [name, count] = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return name ? { name, share: count / browsers.length } : null;
}

// ---------- timeline ----------

// Calendar days in the team's time zone, like the rest of the app's charts.
const dayKey = (d) => todayIn(undefined, new Date(d));

// Reports per day (team's time zone) from the first report, at most the last 90 days, with what happened
// to the ticket on the way: created, fixed, came back, commits/PRs linked, muted, unmuted.
export function timelineOf(project, ticket, rows, events, now = new Date()) {
  const done = doneKeys(project);
  const first = Math.min(+ticket.createdAt, ...rows.map((r) => +r.at));
  const startMs = Math.max(first, +now - 89 * DAY);
  const startDay = dayKey(startMs);
  const counts = new Map();
  for (const r of rows) counts.set(dayKey(r.at), (counts.get(dayKey(r.at)) ?? 0) + 1);
  const days = [];
  for (let d = startDay; d <= dayKey(now); d = addDays(d, 1)) days.push({ date: d, count: counts.get(d) ?? 0 });

  const markers = [];
  for (const e of events) {
    if (dayKey(e.at) < startDay) continue;
    if (e.type === 'created') markers.push({ at: e.at, kind: 'created', label: 'Ticket created' });
    else if (e.type === 'status_changed' && done.has(e.to) && !done.has(e.from)) {
      markers.push({ at: e.at, kind: 'fixed', label: `Moved to ${project.statuses.find((s) => s.key === e.to)?.name ?? e.to}` });
    } else if (e.type === 'status_changed' && done.has(e.from) && !done.has(e.to)) {
      const rec = events.find((x) => x.type === 'error_recurred' && +x.at === +e.at);
      markers.push({ at: e.at, kind: rec ? 'regressed' : 'reopened', label: rec ? `Came back: reopened by a new report${rec.to?.release ? ` (release ${rec.to.release})` : ''}` : 'Reopened' });
    } else if (e.type === 'linked') {
      markers.push({ at: e.at, kind: 'linked', label: `${e.to?.kind === 'pull_request' ? 'Pull request' : 'Commit'} ${e.to?.ref ?? ''} linked`.trim(), url: e.to?.url ?? null });
    } else if (e.type === 'error_muted') markers.push({ at: e.at, kind: 'muted', label: 'Muted', until: e.to?.forever ? null : e.to?.until ?? null });
    else if (e.type === 'error_unmuted') markers.push({ at: e.at, kind: 'unmuted', label: 'Unmuted' });
    else if (e.type === 'error_spike') markers.push({ at: e.at, kind: 'spiked', label: `Spike: ${e.to?.lastHour} reports in an hour, alert sent` });
  }
  return { days, markers: markers.map((m) => ({ ...m, day: dayKey(m.at) })), truncated: first < startMs };
}

// ---------- fix memory ----------

const linkJson = (l) => ({ kind: l.kind, ref: l.ref, title: l.title, url: l.url, author: l.author ?? null });

// Every time this ticket was finished: who finished it, the commits/PRs linked during that round,
// and whether (and when) it came back. Newest first.
export function pastFixes(project, events) {
  const done = doneKeys(project);
  const fixes = [];
  let links = [];
  for (const e of events) {
    if (e.type === 'linked') links.push({ kind: e.to?.kind, ref: e.to?.ref, title: e.to?.title, url: e.to?.url });
    if (e.type !== 'status_changed') continue;
    if (done.has(e.to) && !done.has(e.from)) {
      fixes.push({
        at: e.at, by: e.actor ? { id: String(e.actor._id ?? e.actor), name: e.actor.name ?? null } : null,
        source: e.source ?? 'app', links, cameBackAt: null,
      });
      links = [];
    } else if (done.has(e.from) && !done.has(e.to) && fixes.length && !fixes.at(-1).cameBackAt) {
      fixes.at(-1).cameBackAt = e.at;
    }
  }
  return fixes.reverse();
}

const frameKey = (f) => `${(f.file || '').split(/[?#]/)[0].split(/[\\/]/).pop().replace(/[.-][0-9a-f]{6,}(?=\.)/gi, '')}:${f.fn || '?'}`;
const ownFrames = (frames) => {
  const app = (frames ?? []).filter((f) => f.inApp);
  return (app.length ? app : frames ?? []).slice(0, 3).map(frameKey);
};

// Finished crash tickets that look like this one: same language and error type and sharing one
// of the top in-app frames, or the same message once numbers and ids are taken out.
export async function relatedFixes(project, error, { exclude = null, limit = 3 } = {}) {
  if (!error?.type && !error?.message) return [];
  const candidates = await Ticket.find({
    project: project._id, deletedAt: null, status: { $in: [...doneKeys(project)] }, error: { $ne: null },
    'error.language': error.language, ...(exclude && { _id: { $ne: exclude } }),
  }).sort({ resolvedAt: -1 }).limit(300).lean();
  const mine = new Set(ownFrames(error.frames));
  const myMessage = normalizeMessage(error.message);
  const matches = [];
  for (const t of candidates) {
    if (t.error.fingerprint === error.fingerprint) continue;
    const sameType = Boolean(error.type) && t.error.type === error.type;
    const shared = ownFrames(t.error.frames).filter((k) => mine.has(k));
    const sameMessage = Boolean(myMessage) && normalizeMessage(t.error.message) === myMessage;
    if (!(sameType && shared.length) && !sameMessage) continue;
    const [file, fn] = (shared[0] ?? '').split(':');
    const because = [
      sameType && `same ${error.type}`,
      shared.length > 0 && `both fail in ${fn === '?' ? file : `${fn} (${file})`}`,
      sameMessage && 'same message',
    ].filter(Boolean);
    matches.push({ t, score: shared.length * 2 + (sameType ? 1 : 0) + (sameMessage ? 2 : 0), because });
  }
  matches.sort((a, b) => b.score - a.score || +new Date(b.t.resolvedAt) - +new Date(a.t.resolvedAt));
  return matches.slice(0, limit).map(({ t, because }) => ({
    key: keyOf(project, t.number), number: t.number, title: t.title, resolvedAt: t.resolvedAt,
    because, links: (t.links ?? []).map(linkJson),
  }));
}

// ---------- everything the drawer shows ----------

export async function errorInsights(project, ticket, now = new Date()) {
  if (!ticket.error) throw new HttpError(404, 'not_an_error', 'This ticket was not made from an error');
  const [rows, events] = await Promise.all([
    ErrorOccurrence.find({ ticket: ticket._id }).sort({ at: 1 }).lean(),
    TicketEvent.find({ ticket: ticket._id, type: { $in: ['created', 'status_changed', 'linked', 'error_recurred', 'error_muted', 'error_unmuted', 'error_spike'] } })
      .sort({ at: 1, _id: 1 }).populate('actor', 'name').lean(),
  ]);
  const recent = rows.filter((r) => +r.at >= +now - 7 * DAY).length;
  const people = new Set(rows.filter((r) => r.who && +r.at >= +now - 30 * DAY).map((r) => r.who)).size;
  const comebacks = rows.filter((r) => r.regression).length;
  return {
    impact: impactScore({ recent, people, comebacks, priority: ticket.priority }),
    // Reports from before this history was kept (E5) are in the count but have no rows.
    history: { tracked: rows.length, untracked: Math.max(0, ticket.error.occurrences - rows.length), since: rows[0]?.at ?? null },
    environments: environmentsOf(rows),
    timeline: timelineOf(project, ticket, rows, events, now),
    fixes: pastFixes(project, events),
    related: await relatedFixes(project, ticket.error, { exclude: ticket._id }),
    mute: muteJson(ticket.error, now),
    spike: { ...(await spikeStats(ticket._id, now)), alertedAt: ticket.error.spikeAlertedAt ?? null },
  };
}

// ---------- crash spikes (E5B) ----------

const HOUR = 3600 * 1000;
// A spike: at least 5 reports in the last hour, and at least 4 times the usual hourly rate over the
// 7 days before it. Reports that arrived while muted don't count either way.
export const SPIKE = { minReports: 5, factor: 4, quietHours: 24 };

export async function spikeStats(ticketId, now = new Date()) {
  const hourAgo = new Date(+now - HOUR);
  const [lastHour, prior] = await Promise.all([
    ErrorOccurrence.countDocuments({ ticket: ticketId, muted: false, at: { $gt: hourAgo, $lte: now } }),
    ErrorOccurrence.countDocuments({ ticket: ticketId, muted: false, at: { $gt: new Date(+hourAgo - 7 * DAY), $lte: hourAgo } }),
  ]);
  const baseline = Math.round((prior / (7 * 24)) * 100) / 100;
  return { lastHour, baseline, spiking: lastHour >= SPIKE.minReports && lastHour >= SPIKE.factor * baseline };
}

export const spikeText = ({ lastHour, baseline }) => `${lastHour} reports in the last hour, usually ${baseline < 0.1 ? 'almost none' : `about ${baseline} an hour`}`;

// Claims the alert, so one spike alerts once (and the same error at most once a day).
export async function claimSpikeAlert(ticketId, at) {
  const res = await Ticket.updateOne(
    { _id: ticketId, $or: [{ 'error.spikeAlertedAt': null }, { 'error.spikeAlertedAt': { $lt: new Date(+at - SPIKE.quietHours * HOUR) } }] },
    { $set: { 'error.spikeAlertedAt': at } },
  );
  return res.modifiedCount === 1;
}

// ---------- comparing two crashes (E5B) ----------

function side(project, t, rows) {
  const done = doneKeys(project);
  const env = environmentsOf(rows);
  return {
    key: keyOf(project, t.number), number: t.number, title: t.title, status: t.status, resolved: done.has(t.status),
    language: t.error.language, type: t.error.type, message: t.error.message,
    occurrences: t.error.occurrences, firstSeenAt: t.error.firstSeenAt, lastSeenAt: t.error.lastSeenAt,
    frames: (t.error.frames ?? []).map((f) => ({ fn: f.fn, file: f.file, line: f.line, inApp: f.inApp, key: frameKey(f) })),
    browsers: env.browsers.slice(0, 5), os: env.os.slice(0, 5), reports: env.total,
  };
}

// Side by side, with the frames both crashes pass through marked, and plain sentences on what is
// the same and what differs. It describes; it doesn't decide whether they are one bug.
export async function compareErrors(project, ta, tb) {
  if (!ta.error || !tb.error) throw new HttpError(400, 'not_an_error', 'Both tickets must have been made from an error');
  if (String(ta._id) === String(tb._id)) throw new HttpError(400, 'same_ticket', 'Pick two different crashes');
  const rows = await ErrorOccurrence.find({ ticket: { $in: [ta._id, tb._id] } }).lean();
  const a = side(project, ta, rows.filter((r) => String(r.ticket) === String(ta._id)));
  const b = side(project, tb, rows.filter((r) => String(r.ticket) === String(tb._id)));
  const inB = new Set(b.frames.map((f) => f.key));
  const shared = [...new Set(a.frames.filter((f) => inB.has(f.key)).map((f) => f.key))];
  const sharedSet = new Set(shared);
  for (const s of [a, b]) for (const f of s.frames) f.shared = sharedSet.has(f.key);
  const ownShared = a.frames.filter((f) => f.inApp && f.shared);
  const topA = a.frames.find((f) => f.inApp) ?? a.frames[0];
  const topB = b.frames.find((f) => f.inApp) ?? b.frames[0];
  const describe = (f) => (f ? `${f.fn ?? 'an anonymous function'} (${(f.file ?? '?').split(/[\\/]/).pop()})` : 'an unknown place');
  const sameMessage = normalizeMessage(a.message) === normalizeMessage(b.message);
  const browsersBoth = a.browsers.map((x) => x.name).filter((n) => b.browsers.some((y) => y.name === n));
  const points = [
    a.language === b.language ? null : `Different languages: ${a.language} and ${b.language}.`,
    a.type === b.type ? `Both are ${a.type ?? 'untyped errors'}.` : `Different errors: ${a.type ?? 'untyped'} and ${b.type ?? 'untyped'}.`,
    sameMessage ? 'Same message once numbers, ids and quoted values are taken out.' : 'Different messages.',
    topA && topB && topA.key === topB.key ? `Both fail in ${describe(topA)}.` : `They fail in different places: ${describe(topA)} and ${describe(topB)}.`,
    ownShared.length ? `They share ${ownShared.length} frame${ownShared.length === 1 ? '' : 's'} of your code.` : 'No frames of your code in common.',
    // Only said when both have reports with browser details; otherwise there's nothing to compare.
    a.browsers.length && b.browsers.length ? (browsersBoth.length ? `Both seen in ${browsersBoth.join(', ')}.` : 'Seen in different browsers so far.') : null,
  ].filter(Boolean);
  return { a, b, shared, points };
}
