import { HttpError } from '../errors.js';
import { Deployment, ErrorOccurrence, Incident, PokerRound, Retro, RETRO_COLUMNS, Ticket, TicketEvent, User } from '../models/index.js';
import { createTicket, findTicket, moveTicket, ticketKey } from './ticket.service.js';
import { roleAtLeast } from './project.service.js';
import { publish } from '../realtime.js';

// Live collaboration II (E10): planning poker, retro boards and incident mode. Everything is
// stored, so a page opened later (or after a restart) shows the same state; changes are pushed
// to everyone with the project open.

const id = (x) => String(x?._id ?? x);
const names = async (ids) => new Map((await User.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(id))] } }, { name: 1 }).lean()).map((u) => [id(u), u.name]));
const working = (membership) => roleAtLeast(membership.role, 'developer');
const need = (ok, msg = 'Only people who work on tickets can do this') => { if (!ok) throw new HttpError(403, 'forbidden', msg); };

// ---------- planning poker ----------

export const POKER_VALUES = ['0', '1', '2', '3', '5', '8', '13', '21', '?'];

async function pokerJson(project, round, viewer) {
  const ticket = await Ticket.findById(round.ticket, { number: 1, title: 1, storyPoints: 1 }).lean();
  const who = await names([...round.votes.map((v) => v.user), round.startedBy]);
  const revealed = round.status !== 'voting';
  const numbers = round.votes.map((v) => Number(v.value)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    id: id(round), status: round.status, startedBy: who.get(id(round.startedBy)) ?? null, accepted: round.accepted,
    ticket: ticket && { key: ticketKey(project, ticket.number), number: ticket.number, title: ticket.title, storyPoints: ticket.storyPoints },
    // Before the reveal everyone sees who voted, never what (except their own vote).
    votes: round.votes.map((v) => ({ user: id(v.user), name: who.get(id(v.user)) ?? 'Former member', value: revealed || id(v.user) === id(viewer) ? v.value : null })),
    stats: revealed && numbers.length ? {
      min: numbers[0], max: numbers.at(-1), median: numbers[Math.floor((numbers.length - 1) / 2)],
      consensus: numbers.length === round.votes.length && numbers[0] === numbers.at(-1),
      unsure: round.votes.filter((v) => v.value === '?').length,
    } : null,
    values: POKER_VALUES,
  };
}

export async function listPoker(project, viewer) {
  const rounds = await PokerRound.find({ project: project._id, status: { $in: ['voting', 'revealed'] } }).sort({ createdAt: -1 }).limit(20);
  return Promise.all(rounds.map((r) => pokerJson(project, r, viewer)));
}

const pokerChanged = (project, round) => publish(String(project._id), 'poker', { action: 'updated', id: id(round) });

export async function startPoker(project, membership, user, ref) {
  need(working(membership));
  const ticket = await findTicket(project, ref);
  if (ticket.deletedAt) throw new HttpError(409, 'ticket_deleted', 'This ticket is deleted');
  await PokerRound.updateMany({ project: project._id, ticket: ticket._id, status: { $in: ['voting', 'revealed'] } }, { $set: { status: 'cancelled' } });
  const round = await PokerRound.create({ project: project._id, ticket: ticket._id, startedBy: user._id });
  pokerChanged(project, round);
  return pokerJson(project, round, user._id);
}

async function round(project, roundId) {
  const r = await PokerRound.findOne({ _id: roundId, project: project._id });
  if (!r) throw new HttpError(404, 'round_not_found', 'That estimate round is not in this project');
  return r;
}

export async function vote(project, membership, user, roundId, value) {
  need(working(membership));
  if (!POKER_VALUES.includes(value)) throw new HttpError(400, 'bad_value', `Vote one of ${POKER_VALUES.join(', ')}`);
  const r = await round(project, roundId);
  if (r.status !== 'voting') throw new HttpError(409, 'round_closed', 'Votes are already shown for this round');
  const mine = r.votes.find((v) => id(v.user) === id(user._id));
  if (mine) { mine.value = value; mine.at = new Date(); } else r.votes.push({ user: user._id, value, at: new Date() });
  await r.save();
  pokerChanged(project, r);
  return pokerJson(project, r, user._id);
}

export async function reveal(project, membership, user, roundId) {
  need(working(membership));
  const r = await round(project, roundId);
  if (!r.votes.length) throw new HttpError(409, 'no_votes', 'Nobody has voted yet');
  r.status = 'revealed';
  await r.save();
  pokerChanged(project, r);
  return pokerJson(project, r, user._id);
}

export async function revote(project, membership, user, roundId) {
  need(working(membership));
  const r = await round(project, roundId);
  r.status = 'voting';
  r.votes = [];
  await r.save();
  pokerChanged(project, r);
  return pokerJson(project, r, user._id);
}

export async function accept(project, membership, user, roundId, points) {
  need(working(membership));
  const r = await round(project, roundId);
  if (r.status !== 'revealed') throw new HttpError(409, 'not_revealed', 'Show the votes before choosing the estimate');
  const ticket = await Ticket.findById(r.ticket);
  const from = ticket.storyPoints;
  ticket.storyPoints = points;
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: user._id, type: 'updated', field: 'storyPoints', from, to: points, at: new Date() });
  r.status = 'done';
  r.accepted = points;
  await r.save();
  pokerChanged(project, r);
  publish(String(project._id), 'ticket', { action: 'updated', actorId: id(user._id), number: ticket.number });
  return pokerJson(project, r, user._id);
}

// ---------- retro boards ----------

async function retroJson(project, retro, viewer) {
  const who = await names(retro.items.map((i) => i.author));
  const used = retro.items.reduce((s, i) => s + i.votes.filter((v) => id(v) === id(viewer)).length, 0);
  return {
    id: id(retro), title: retro.title, status: retro.status, votesPerPerson: retro.votesPerPerson, votesLeft: Math.max(0, retro.votesPerPerson - used),
    columns: RETRO_COLUMNS,
    items: retro.items.map((i) => ({
      id: id(i), column: i.column, text: i.text, author: who.get(id(i.author)) ?? null, mine: id(i.author) === id(viewer),
      votes: i.votes.length, voted: i.votes.some((v) => id(v) === id(viewer)), ticket: i.ticket ? ticketKey(project, i.ticket) : null,
    })).sort((a, b) => b.votes - a.votes),
    createdAt: retro.createdAt,
  };
}

const retroChanged = (project, retro) => publish(String(project._id), 'retro', { action: 'updated', id: id(retro) });

export async function listRetros(project) {
  const rows = await Retro.find({ project: project._id }).sort({ createdAt: -1 }).limit(30).lean();
  return rows.map((r) => ({ id: id(r), title: r.title, status: r.status, items: r.items.length, createdAt: r.createdAt }));
}

export async function getRetro(project, retroId) {
  const r = await Retro.findOne({ _id: retroId, project: project._id });
  if (!r) throw new HttpError(404, 'retro_not_found', 'That retro is not in this project');
  return r;
}
export const showRetro = async (project, retroId, viewer) => retroJson(project, await getRetro(project, retroId), viewer);

export async function createRetro(project, membership, user, { title, votesPerPerson = 3 }) {
  need(working(membership));
  const r = await Retro.create({ project: project._id, title, votesPerPerson, createdBy: user._id });
  publish(String(project._id), 'retro', { action: 'created', id: id(r) });
  return retroJson(project, r, user._id);
}

export async function addRetroItem(project, membership, user, retroId, { column, text }) {
  const r = await getRetro(project, retroId);
  if (r.status !== 'open') throw new HttpError(409, 'retro_closed', 'This retro is closed');
  if (r.items.length >= 300) throw new HttpError(400, 'too_many_items', 'A retro keeps at most 300 notes');
  r.items.push({ column, text, author: user._id });
  await r.save();
  retroChanged(project, r);
  return retroJson(project, r, user._id);
}

export async function voteRetroItem(project, user, retroId, itemId) {
  const r = await getRetro(project, retroId);
  if (r.status !== 'open') throw new HttpError(409, 'retro_closed', 'This retro is closed');
  const item = r.items.id(itemId);
  if (!item) throw new HttpError(404, 'item_not_found', 'That note is not on this retro');
  const mine = item.votes.findIndex((v) => id(v) === id(user._id));
  if (mine >= 0) item.votes.splice(mine, 1);
  else {
    const used = r.items.reduce((s, i) => s + i.votes.filter((v) => id(v) === id(user._id)).length, 0);
    if (used >= r.votesPerPerson) throw new HttpError(409, 'no_votes_left', `Everyone has ${r.votesPerPerson} votes; take one back first`);
    item.votes.push(user._id);
  }
  await r.save();
  retroChanged(project, r);
  return retroJson(project, r, user._id);
}

export async function removeRetroItem(project, membership, user, retroId, itemId) {
  const r = await getRetro(project, retroId);
  const item = r.items.id(itemId);
  if (!item) throw new HttpError(404, 'item_not_found', 'That note is not on this retro');
  if (id(item.author) !== id(user._id) && !roleAtLeast(membership.role, 'manager')) throw new HttpError(403, 'forbidden', 'You can remove your own notes');
  item.deleteOne();
  await r.save();
  retroChanged(project, r);
  return retroJson(project, r, user._id);
}

export async function closeRetro(project, membership, user, retroId) {
  need(roleAtLeast(membership.role, 'manager'), 'Managers close retros');
  const r = await getRetro(project, retroId);
  r.status = 'closed';
  await r.save();
  retroChanged(project, r);
  return retroJson(project, r, user._id);
}

export async function ticketFromRetroItem(project, membership, user, retroId, itemId) {
  need(working(membership));
  const r = await getRetro(project, retroId);
  const item = r.items.id(itemId);
  if (!item) throw new HttpError(404, 'item_not_found', 'That note is not on this retro');
  if (item.ticket) throw new HttpError(409, 'already_ticketed', `Already ${ticketKey(project, item.ticket)}`);
  const { ticket } = await createTicket(project, user, { title: item.text.slice(0, 200), description: `From the retro "${r.title}".`, type: 'task', labels: ['retro'] });
  item.ticket = ticket.number;
  await r.save();
  retroChanged(project, r);
  return retroJson(project, r, user._id);
}

// ---------- incident mode ----------

const SEV_PRIORITY = { sev1: 'critical', sev2: 'high', sev3: 'medium' };

async function incidentJson(project, inc) {
  const who = await names([inc.commander, ...inc.timeline.map((e) => e.author)]);
  const ticket = await Ticket.findById(inc.ticket, { number: 1 }).lean();
  return {
    id: id(inc), title: inc.title, severity: inc.severity, status: inc.status,
    commander: inc.commander ? { id: id(inc.commander), name: who.get(id(inc.commander)) ?? 'Former member' } : null,
    startedAt: inc.startedAt, resolvedAt: inc.resolvedAt, ticket: ticket ? ticketKey(project, ticket.number) : null,
    timeline: inc.timeline.map((e) => ({ at: e.at, kind: e.kind, text: e.text, author: e.author ? who.get(id(e.author)) ?? 'Former member' : null })),
    rootCause: inc.rootCause, lessons: inc.lessons, followUps: inc.followUps.map((n) => ticketKey(project, n)),
  };
}
const incidentChanged = (project, inc) => publish(String(project._id), 'incident', { action: 'updated', id: id(inc) });

export async function listIncidents(project) {
  const rows = await Incident.find({ project: project._id }).sort({ startedAt: -1 }).limit(30);
  return Promise.all(rows.map((r) => incidentJson(project, r)));
}

async function incident(project, incidentId) {
  const inc = await Incident.findOne({ _id: incidentId, project: project._id });
  if (!inc) throw new HttpError(404, 'incident_not_found', 'That incident is not in this project');
  return inc;
}
export const showIncident = async (project, incidentId) => incidentJson(project, await incident(project, incidentId));

// Starting an incident opens a critical ticket labelled "incident" (so the status page shows it)
// with whoever started it as commander.
export async function startIncident(project, membership, user, { title, severity = 'sev2' }) {
  need(working(membership));
  const { ticket } = await createTicket(project, user, { title: `Incident: ${title}`.slice(0, 200), type: 'bug', priority: SEV_PRIORITY[severity], labels: ['incident'], assigneeId: String(user._id) });
  const at = new Date();
  const inc = await Incident.create({
    project: project._id, ticket: ticket.id, title, severity, commander: user._id, startedAt: at,
    timeline: [{ at, kind: 'started', text: `Incident started (${severity.toUpperCase()})`, author: user._id }],
  });
  incidentChanged(project, inc);
  return incidentJson(project, inc);
}

export async function updateIncident(project, membership, user, incidentId, { note, commanderId, severity, rootCause, lessons, followUp }) {
  need(working(membership));
  const inc = await incident(project, incidentId);
  const at = new Date();
  if (note) inc.timeline.push({ at, kind: 'note', text: note, author: user._id });
  if (commanderId && commanderId !== id(inc.commander)) {
    const m = project.members.find((x) => id(x.user) === commanderId && x.role !== 'viewer');
    if (!m) throw new HttpError(400, 'not_a_member', 'The commander must be someone who works on tickets in this project');
    inc.commander = commanderId;
    const n = (await names([commanderId])).get(commanderId);
    inc.timeline.push({ at, kind: 'commander', text: `${n} is now the incident commander`, author: user._id });
  }
  if (severity && severity !== inc.severity) {
    inc.timeline.push({ at, kind: 'severity', text: `Severity changed from ${inc.severity.toUpperCase()} to ${severity.toUpperCase()}`, author: user._id });
    inc.severity = severity;
  }
  if (rootCause !== undefined) inc.rootCause = rootCause;
  if (lessons !== undefined) inc.lessons = lessons;
  if (followUp) {
    const t = await findTicket(project, followUp);
    if (!inc.followUps.includes(t.number)) inc.followUps.push(t.number);
  }
  await inc.save();
  incidentChanged(project, inc);
  return incidentJson(project, inc);
}

export async function resolveIncident(project, membership, user, incidentId, { summary }) {
  need(working(membership));
  const inc = await incident(project, incidentId);
  if (inc.status === 'resolved') throw new HttpError(409, 'already_resolved', 'This incident is already resolved');
  const at = new Date();
  inc.status = 'resolved';
  inc.resolvedAt = at;
  inc.timeline.push({ at, kind: 'resolved', text: summary ? `Resolved: ${summary}` : 'Resolved', author: user._id });
  await inc.save();
  // Its ticket is finished too, so the status page shows the incident as over.
  const ticket = await Ticket.findById(inc.ticket);
  const done = project.statuses.find((s) => s.category === 'done').key;
  if (ticket && !ticket.deletedAt && ticket.status !== done) await moveTicket(project, membership, ticket, { status: done });
  incidentChanged(project, inc);
  return incidentJson(project, inc);
}

const fmt = (d) => `${new Date(d).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
const minutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} minutes` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

// A postmortem written from the record: what the timeline, the deploys and the crash reports say.
// The parts only people know (root cause, lessons) come from what the team wrote; empty ones say so.
export async function postmortem(project, incidentId) {
  const inc = await incident(project, incidentId);
  const j = await incidentJson(project, inc);
  const end = inc.resolvedAt ?? new Date();
  const [deploys, reports, newCrashes] = await Promise.all([
    Deployment.find({ project: project._id, at: { $gte: inc.startedAt, $lte: end } }).sort({ at: 1 }).lean(),
    ErrorOccurrence.countDocuments({ project: project._id, at: { $gte: inc.startedAt, $lte: end } }),
    Ticket.countDocuments({ project: project._id, error: { $ne: null }, createdAt: { $gte: inc.startedAt, $lte: end } }),
  ]);
  const lines = [
    `# Postmortem: ${inc.title}`,
    '',
    `- **Severity:** ${inc.severity.toUpperCase()}`,
    `- **Commander:** ${j.commander?.name ?? 'nobody'}`,
    `- **Started:** ${fmt(inc.startedAt)}`,
    `- **Resolved:** ${inc.resolvedAt ? fmt(inc.resolvedAt) : 'not yet'}`,
    `- **Duration:** ${minutes(+end - +inc.startedAt)}${inc.resolvedAt ? '' : ' so far'}`,
    `- **Ticket:** ${j.ticket}`,
    '',
    '## Impact',
    `- ${reports} crash report${reports === 1 ? '' : 's'} arrived during the incident; ${newCrashes} new crash${newCrashes === 1 ? '' : 'es'} were opened.`,
    deploys.length ? `- ${deploys.length} deploy${deploys.length === 1 ? '' : 's'} during the incident: ${deploys.map((d) => `${d.release ?? '?'} to ${d.environment} (${d.status}, ${fmt(d.at)})`).join('; ')}.` : '- No deploys during the incident.',
    '',
    '## Timeline',
    ...j.timeline.map((e) => `- ${fmt(e.at)}: ${e.text}${e.author ? ` (${e.author})` : ''}`),
    '',
    '## Root cause',
    inc.rootCause?.trim() || '_Not written yet._',
    '',
    '## Lessons',
    inc.lessons?.trim() || '_Not written yet._',
    '',
    '## Follow-up tickets',
    j.followUps.length ? j.followUps.map((k) => `- ${k}`).join('\n') : '_None linked yet._',
  ];
  return lines.join('\n');
}
