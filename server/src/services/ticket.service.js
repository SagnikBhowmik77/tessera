import { applyFieldValues, cleanFieldValues } from './fields.service.js';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { HttpError } from '../errors.js';
import { Comment, Project, Ticket, TicketEvent } from '../models/index.js';
import { roleAtLeast } from './project.service.js';
import { emailReporterFixed, excerptOf, notify } from './notification.service.js';
import { extractMentions } from './comment.service.js';
import { analyzeError, errorRecord, findByFingerprint, withSourceMaps } from './bug.service.js';
import { afterStatusChange } from './blocking.service.js';
import { runRules } from './automation.service.js';
import { slaOf } from './sla.service.js';
import { claimSpikeAlert, isMuted, muteJson, recordOccurrence, spikeStats, spikeText } from './errorinsights.service.js';
import { sourceUrl } from '../bugs/sourcelink.js';
import { reproSummary } from './repro.service.js';
import { releaseAt } from './deploy.service.js';

const PEOPLE = [
  { path: 'assignee', select: 'name email' },
  { path: 'reporter', select: 'name email' },
];

export const ticketKey = (project, number) => `${project.key}-${number}`;

export function serializeTicket(ticket, project) {
  const json = ticket.toJSON();
  json.key = ticketKey(project, json.number);
  json.sla = slaOf(project, ticket);
  if (json.error) {
    json.error.muted = muteJson(ticket.error);
    json.error.frames = (json.error.frames ?? []).map((f) => ({ ...f, source: sourceUrl(project.source, f, json.error.language) }));
  }
  json.repro = reproSummary(ticket.repro);
  json.duplicateOf = json.duplicateOf ? ticketKey(project, json.duplicateOf.number) : null;
  return json;
}

const ticketNotFound = () => new HttpError(404, 'ticket_not_found', 'Ticket not found');
const ticketDeleted = () => new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');

const statusOf = (project, key) => project.statuses.find((s) => s.key === key);
function requireStatus(project, key) {
  const status = statusOf(project, key);
  if (!status) throw new HttpError(400, 'unknown_status', `This project has no column "${key}"`);
  return status;
}

// Entering a "done" column stamps resolvedAt; leaving it clears the stamp. Leaving the to-do
// columns for the first time counts as the team's first response (service levels).
export function applyStatus(ticket, project, key, at) {
  ticket.status = key;
  const { category } = statusOf(project, key);
  // Reopened: the merge and deploy that finished it didn't fix it (E8).
  if (category !== 'done') { ticket.mergedAt = null; ticket.shipped = null; ticket.fixEmailPending = false; }
  if (category !== 'todo' && !ticket.respondedAt) ticket.respondedAt = at;
  const done = category === 'done';
  if (done && !ticket.resolvedAt) ticket.resolvedAt = at;
  if (!done) ticket.resolvedAt = null;
}

// Only members who can work on tickets can be assigned (not viewers).
export function assignable(project, userId) {
  if (userId === null || userId === undefined) return null;
  const member = project.members.find((m) => String(m.user) === String(userId));
  if (!member) throw new HttpError(400, 'assignee_not_member', 'The assignee must be a member of this project');
  if (member.role === 'viewer') throw new HttpError(400, 'assignee_is_viewer', "Viewers can't be assigned tickets");
  return member.user;
}

const idOf = (v) => (v && v._id ? v._id : v);
const isMe = (membership, user) => Boolean(user) && String(idOf(user)) === String(membership.user);

// Managers and admins edit any ticket; developers edit tickets they reported or are assigned to.
export const canEdit = (membership, ticket) =>
  roleAtLeast(membership.role, 'manager') || isMe(membership, ticket.reporter) || isMe(membership, ticket.assignee);

// Who hears about a change: the new assignee, and the reporter when their ticket is finished.
// (notify() itself skips the person who made the change.)
// `note` goes with an assignment that has no handoff (e.g. "Automation rule: Route bugs").
export async function notifyFromEvents(project, ticket, actor, events, { handoff = null, note = null } = {}) {
  const base = {
    project: project._id, ticket: ticket._id, actor,
    ticketKey: ticketKey(project, ticket.number), ticketTitle: ticket.title,
  };
  const items = [];
  for (const e of events) {
    // A handoff note travels with the assignment (in the inbox and the email).
    if (e.type === 'assigned' && e.to) items.push({ ...base, user: e.to, type: 'assigned', ...(handoff ? { excerpt: excerptOf(handoff) } : note ? { excerpt: note } : {}) });
    const finished = e.type === 'status_changed'
      && statusOf(project, e.to)?.category === 'done' && statusOf(project, e.from)?.category !== 'done';
    if (finished && ticket.reporter) items.push({ ...base, user: idOf(ticket.reporter), type: 'resolved' });
    // Someone outside the team reported it through the portal: tell them it's fixed.
    if (finished && (ticket.contact?.email || ticket.otherReporters?.length)) {
      // Held until the next production deploy, when the team asked for that (E8).
      if (project.deploys?.emailAfterDeploy) { ticket.fixEmailPending = true; await Ticket.updateOne({ _id: ticket._id }, { $set: { fixEmailPending: true } }); }
      else emailReporterFixed(project, ticket);
    }
    // Watchers hear about every move between columns.
    if (e.type === 'status_changed') {
      const excerpt = `${statusOf(project, e.from)?.name ?? e.from} → ${statusOf(project, e.to)?.name ?? e.to}`;
      for (const w of ticket.watchers ?? []) items.push({ ...base, user: idOf(w), type: 'status_changed', excerpt });
    }
  }
  // Someone already told about this change another way (assigned, resolved) gets one notice, not two.
  const told = new Set(items.filter((i) => i.type !== 'status_changed').map((i) => String(i.user)));
  const final = items.filter((i) => i.type !== 'status_changed' || !told.has(String(i.user)));
  if (final.length) await notify(final);
}

// Closing a ticket from an integration (a GitHub commit or merged pull request): straight
// to the first "done" column. Returns false when it was already done.
export async function closeFromIntegration(project, ticket, source) {
  if (statusOf(project, ticket.status)?.category === 'done') return false;
  const moved = await moveFromIntegration(project, ticket, project.statuses.find((s) => s.category === 'done').key, source);
  // Finished by a merged pull request or a commit on the main branch: merged, not yet live (E8).
  if (moved && (source === 'github' || source === 'gitlab')) {
    ticket.mergedAt = new Date();
    await ticket.save();
  }
  return moved;
}

// Moving a ticket for an integration (GitHub branch / pull request / issue, E7). WIP limits don't
// stop it: the work already happened elsewhere.
export async function moveFromIntegration(project, ticket, to, source) {
  if (ticket.status === to) return false;
  const from = ticket.status;
  const at = new Date();
  ticket.rank = await bottomRank(project._id, to, ticket._id);
  applyStatus(ticket, project, to, at);
  ticket.triage = false;
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: null, source, type: 'status_changed', from, to, at });
  await afterStatusChange(project, ticket, null, at);
  await notifyFromEvents(project, ticket, null, [{ type: 'status_changed', from, to }]);
  await runRules(project, ticket, [{ type: 'status_changed', from, to }]);
  return true;
}

// Triage inbox: a portal report accepted onto the board.
export async function acceptTriage(project, membership, ticket) {
  if (ticket.deletedAt) throw ticketDeleted();
  if (!ticket.triage) throw new HttpError(409, 'not_in_triage', 'This ticket is already on the board');
  ticket.triage = false;
  ticket.rank = await bottomRank(project._id, ticket.status, ticket._id);
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: membership.user, type: 'triaged' });
  await ticket.populate(PEOPLE);
  return serializeTicket(ticket, project);
}

// Managers and admins delete any ticket; developers only tickets they reported.
const canDelete = (membership, ticket) => roleAtLeast(membership.role, 'manager') || isMe(membership, ticket.reporter);

export async function bottomRank(projectId, status, excludeId = null) {
  const last = await Ticket.findOne({ project: projectId, status, deletedAt: null, _id: { $ne: excludeId } })
    .sort({ rank: -1 })
    .select('rank')
    .lean();
  return generateKeyBetween(last?.rank ?? null, null);
}

export async function findTicket(project, ref) {
  const match = /^(?:([A-Za-z][A-Za-z0-9]{1,5})-)?(\d+)$/.exec(ref);
  if (!match || (match[1] && match[1].toUpperCase() !== project.key)) throw ticketNotFound();
  const ticket = await Ticket.findOne({ project: project._id, number: Number(match[2]) });
  if (!ticket) throw ticketNotFound();
  return ticket;
}

export async function getTicket(project, ref) {
  const ticket = await findTicket(project, ref);
  await ticket.populate(PEOPLE);
  return serializeTicket(ticket, project);
}

// WIP limits: a column at its limit takes no more cards. Managers can override, and the
// override is written into the history so the analytics stay honest about it.
// Returns true when an override was used.
export async function checkWip(project, membership, status, excludeId, override) {
  const column = statusOf(project, status);
  if (!column?.wipLimit) return false;
  const count = await Ticket.countDocuments({ project: project._id, status, deletedAt: null, _id: { $ne: excludeId } });
  if (count < column.wipLimit) return false;
  if (override) {
    if (!membership || !roleAtLeast(membership.role, 'manager')) {
      throw new HttpError(403, 'forbidden', 'Only managers can go over a WIP limit');
    }
    return true;
  }
  throw new HttpError(409, 'wip_limit',
    `${column.name} is at its limit of ${column.wipLimit}. Finish something there first, or ask a manager to override.`,
    { status, limit: column.wipLimit, count });
}

const firstTodo = (project) => (project.statuses.find((s) => s.category === 'todo') ?? project.statuses[0]).key;

// The same error was reported again: count it on the existing ticket instead of opening a
// duplicate. If that ticket was already done, the bug has come back: reopen it and tell
// whoever owns it (a "regression"). A muted error is counted and kept, nothing more.
async function recordRecurrence(project, actor, ticket, analysis, { source = 'app', contact = null, occurrence = {} } = {}) {
  const at = new Date();
  const muted = isMuted(ticket.error, at);
  ticket.error.occurrences += 1;
  ticket.error.lastSeenAt = at;
  if (analysis.error.environment) ticket.error.environment = analysis.error.environment;
  // An outside reporter of a known error is told when it's fixed, like the first one.
  let willEmail = false;
  const email = contact?.email?.toLowerCase();
  if (email) {
    const known = [ticket.contact?.email, ...ticket.otherReporters.map((r) => r.email)].map((e) => e?.toLowerCase());
    if (known.includes(email)) willEmail = true;
    else if (!ticket.contact?.email) { ticket.contact = contact; willEmail = true; }
    else if (ticket.otherReporters.length < 25) { ticket.otherReporters.push(contact); willEmail = true; }
  }
  ticket.markModified('error');
  const regression = !muted && statusOf(project, ticket.status)?.category === 'done';
  // Which release brought it back: the one the report named, or the last production deploy (E8).
  const cameBackIn = regression ? await releaseAt(project, at, occurrence.release ?? null) : null;
  const events = [{ type: 'error_recurred', to: { occurrences: ticket.error.occurrences, ...(muted && { muted: true }), ...(cameBackIn && { release: cameBackIn }) } }];
  if (regression) {
    const from = ticket.status;
    const to = firstTodo(project);
    ticket.rank = await bottomRank(project._id, to, ticket._id);
    applyStatus(ticket, project, to, at);
    events.push({ type: 'status_changed', from, to });
  }
  await ticket.save();
  await TicketEvent.insertMany(events.map((e) => ({ project: project._id, ticket: ticket._id, actor, at, ...e })));
  await recordOccurrence(project, ticket, { at, actor, contact, source, environment: analysis.error.environment, regression, muted, ...occurrence });
  if (!muted) await alertIfSpiking(project, ticket, at);
  if (regression) await afterStatusChange(project, ticket, actor, at);
  const owner = idOf(ticket.assignee) ?? idOf(ticket.reporter);
  if (regression && owner) {
    await notify([{
      user: owner, project: project._id, ticket: ticket._id, actor, type: 'regression',
      ticketKey: ticketKey(project, ticket.number), ticketTitle: ticket.title, ...(cameBackIn && { excerpt: `came back in release ${cameBackIn}` }),
    }]);
  }
  if (regression) await runRules(project, ticket, events);
  await ticket.populate(PEOPLE);
  return { ticket: serializeTicket(ticket, project), grouped: true, regression, willEmail };
}

// A sudden jump in reports (E5B): tell the owner, or the managers when nobody owns it. Once per spike.
async function alertIfSpiking(project, ticket, at) {
  const stats = await spikeStats(ticket._id, at);
  if (!stats.spiking || !(await claimSpikeAlert(ticket._id, at))) return;
  ticket.error.spikeAlertedAt = at;
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: null, type: 'error_spike', at, to: { lastHour: stats.lastHour, baseline: stats.baseline } });
  const owner = idOf(ticket.assignee);
  const people = owner ? [owner] : project.members.filter((m) => roleAtLeast(m.role, 'manager')).map((m) => m.user);
  await notify(people.map((user) => ({
    user, project: project._id, ticket: ticket._id, actor: null, type: 'crash_spike',
    ticketKey: ticketKey(project, ticket.number), ticketTitle: ticket.title, excerpt: spikeText(stats),
  })));
}

// Returns { ticket, grouped, regression }. With `errorText`, a known error is grouped onto
// its existing ticket instead of creating a new one.
// `user` is null for reports from the public portal; those arrive in the triage inbox
// (triage: true) with the outside reporter's contact details instead of a reporter account.
export async function createTicket(project, user, input, { source = 'app', triage = false, contact = null, quiet = false, occurrence = {} } = {}) {
  const actor = user?._id ?? null;
  let analysis = null;
  if (input.errorText) {
    analysis = await withSourceMaps(project, analyzeError(input.errorText, input.userAgent), occurrence.release ?? null);
    const existing = await findByFingerprint(project, analysis.error.fingerprint);
    if (existing) return recordRecurrence(project, actor, existing, analysis, { source, contact, occurrence });
  }
  const status = input.status ?? firstTodo(project);
  requireStatus(project, status);
  const assignee = assignable(project, input.assigneeId);
  const membership = user ? project.members.find((m) => String(m.user) === String(user._id)) : null;
  // Triage reports are not on the board yet, so they don't count against WIP limits.
  const wipOverride = triage ? false : await checkWip(project, membership, status, null, input.overrideWip);

  // The project's counter hands out numbers atomically, so simultaneous tickets never share one.
  const { ticketCounter: number } = await Project.findOneAndUpdate(
    { _id: project._id },
    { $inc: { ticketCounter: 1 } },
    { returnDocument: 'after', projection: { ticketCounter: 1 } },
  );
  const at = new Date();
  const ticket = new Ticket({
    project: project._id,
    number,
    type: input.type ?? (analysis ? 'bug' : 'task'),
    title: input.title ?? analysis.suggested.title,
    description: input.description || (analysis?.suggested.description ?? ''),
    priority: input.priority,
    error: analysis ? errorRecord(analysis, at) : null,
    assignee,
    reporter: actor,
    labels: input.labels,
    dueDate: input.dueDate ?? null,
    startDate: input.startDate ?? null,
    fields: Object.fromEntries(Object.entries(input.fields ? cleanFieldValues(project, input.fields) : {}).filter(([, v]) => v !== null)),
    storyPoints: input.storyPoints ?? null,
    rank: await bottomRank(project._id, status),
    source,
    triage,
    contact,
  });
  applyStatus(ticket, project, status, at);
  await ticket.save();
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor, source, type: 'created', at: ticket.createdAt,
    to: { status, assignee, priority: ticket.priority, type: ticket.type, ...(wipOverride && { wipOverride: true }) },
  });
  if (analysis) await recordOccurrence(project, ticket, { at, actor, contact, source, environment: analysis.error.environment, ...occurrence });
  if (!quiet) await notifyFromEvents(project, ticket, actor, [{ type: 'assigned', to: assignee }]);
  await runRules(project, ticket, [{ type: 'created' }]);
  await ticket.populate(PEOPLE);
  return { ticket: serializeTicket(ticket, project), grouped: false, regression: false, willEmail: Boolean(contact?.email) };
}

// Values as they are stored in the history: plain, comparable, readable.
function plain(field, value) {
  if (value === undefined || value === null) return null;
  if (field === 'dueDate' || field === 'startDate') return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return [...value];
  return value;
}
const same = (field, a, b) => JSON.stringify(plain(field, a)) === JSON.stringify(plain(field, b));

const EDITABLE = ['title', 'description', 'type', 'priority', 'labels', 'startDate', 'dueDate', 'storyPoints'];

export async function updateTicket(project, membership, ticket, changes) {
  if (ticket.deletedAt) throw ticketDeleted();
  // Without edit rights a developer may still pick up an unassigned ticket ("assign to me").
  const selfAssignOnly = Object.keys(changes).every((k) => k === 'assigneeId' || changes[k] === undefined)
    && changes.assigneeId !== undefined && String(changes.assigneeId) === String(membership.user) && !ticket.assignee;
  if (!canEdit(membership, ticket) && !selfAssignOnly) {
    throw new HttpError(403, 'forbidden', 'You can edit tickets you reported or are assigned to. Managers can edit any ticket.');
  }
  // Edit conflict protection (E10): if someone else changed a field you are saving since you
  // started editing, nothing is overwritten; you get their change and decide.
  if (changes.expectedUpdatedAt) {
    const since = new Date(changes.expectedUpdatedAt);
    const later = await TicketEvent.find({ ticket: ticket._id, at: { $gt: since }, actor: { $ne: membership.user }, type: { $in: ['updated', 'assigned', 'status_changed'] } })
      .populate('actor', 'name').sort({ at: 1 }).lean();
    const fieldOf = (e) => (e.type === 'updated' ? e.field : e.type === 'assigned' ? 'assigneeId' : 'status');
    const clash = later.filter((e) => changes[fieldOf(e)] !== undefined);
    if (clash.length) {
      const who = [...new Set(clash.map((e) => e.actor?.name ?? 'Someone'))];
      const fields = [...new Set(clash.map(fieldOf))];
      throw new HttpError(409, 'edit_conflict', `${who.join(' and ')} changed the ${fields.join(' and ')} while you were editing`, {
        by: who, fields, at: clash.at(-1).at,
        current: Object.fromEntries(fields.map((f) => [f, f === 'assigneeId' ? (ticket.assignee ? String(ticket.assignee._id ?? ticket.assignee) : null) : ticket[f] ?? null])),
        updatedAt: ticket.updatedAt,
      });
    }
  }

  // An epic groups tickets; a ticket in an epic or a sub-task can't become one, and an epic with
  // tickets in it can't stop being one (its tickets would lose their grouping).
  if (changes.type !== undefined && changes.type !== ticket.type) {
    if (changes.type === 'epic' && ticket.sprint) {
      throw new HttpError(409, 'epic_conflict', 'Epics span sprints. Take this ticket out of its sprint before making it an epic.');
    }
    if (changes.type === 'epic' && (ticket.epic || ticket.parent || await Ticket.exists({ parent: ticket._id, deletedAt: null }))) {
      throw new HttpError(409, 'epic_conflict', 'Only a ticket outside any epic, with no sub-tasks, can become an epic');
    }
    if (ticket.type === 'epic' && await Ticket.exists({ epic: ticket._id, deletedAt: null })) {
      throw new HttpError(409, 'epic_conflict', 'Move the tickets out of this epic before changing its type');
    }
  }
  // A start date after the due date makes no sense on a timeline (checked against stored values too).
  const start = changes.startDate !== undefined ? changes.startDate : ticket.startDate;
  const due = changes.dueDate !== undefined ? changes.dueDate : ticket.dueDate;
  if (start && due && start > due && (changes.startDate !== undefined || changes.dueDate !== undefined)) {
    throw new HttpError(400, 'dates_order', 'The start date must be on or before the due date');
  }
  const at = new Date();
  const events = [];
  for (const field of EDITABLE) {
    if (changes[field] === undefined || same(field, ticket[field], changes[field])) continue;
    events.push({ type: 'updated', field, from: plain(field, ticket[field]), to: plain(field, changes[field]) });
    ticket[field] = changes[field];
  }
  if (changes.fields) events.push(...applyFieldValues(project, ticket, changes.fields));
  // A new priority means a new service-level target: alert again if that one is missed too.
  if (events.some((e) => e.field === 'priority')) ticket.slaAlerted = { response: null, resolve: null };
  let handoff = null;
  if (changes.assigneeId !== undefined) {
    const assignee = assignable(project, changes.assigneeId);
    if (String(assignee) !== String(idOf(ticket.assignee))) {
      events.push({ type: 'assigned', from: idOf(ticket.assignee) ?? null, to: assignee });
      ticket.assignee = assignee;
      if (changes.handoffNote && assignee) handoff = changes.handoffNote;
    }
  }
  if (changes.handoffNote && !handoff) {
    throw new HttpError(400, 'handoff_without_reassign', 'A handoff note goes with handing the ticket to someone else');
  }
  if (changes.status !== undefined && changes.status !== ticket.status) {
    requireStatus(project, changes.status);
    const override = await checkWip(project, membership, changes.status, ticket._id, changes.overrideWip);
    events.push({ type: 'status_changed', from: ticket.status, to: changes.status, ...(override && { field: 'wip_override' }) });
    ticket.rank = await bottomRank(project._id, changes.status, ticket._id);
    applyStatus(ticket, project, changes.status, at);
  }

  if (events.length) {
    await ticket.save();
    await TicketEvent.insertMany(events.map((e) => ({
      project: project._id, ticket: ticket._id, actor: membership.user, at, ...e,
    })));
    if (handoff) {
      // Saved as a comment on the ticket, so the context stays with it for everyone.
      const note = await Comment.create({
        project: project._id, ticket: ticket._id, author: membership.user, kind: 'handoff',
        body: handoff, mentions: extractMentions(project, handoff),
      });
      await TicketEvent.create({
        project: project._id, ticket: ticket._id, actor: membership.user, type: 'commented', to: { comment: note._id, kind: 'handoff' }, at,
      });
    }
    if (events.some((e) => e.type === 'status_changed')) await afterStatusChange(project, ticket, membership.user, at);
    await notifyFromEvents(project, ticket, membership.user, events, { handoff });
    await runRules(project, ticket, events);
  }
  await ticket.populate(PEOPLE);
  return serializeTicket(ticket, project);
}

// Renumbers a column evenly (keeping its order). Only needed in the rare case two cards
// ended up with the same rank, e.g. two people dropping into the same slot at once.
async function rebalance(projectId, status, excludeId) {
  const column = await Ticket.find({ project: projectId, status, deletedAt: null, _id: { $ne: excludeId } })
    .sort({ rank: 1, number: 1 })
    .select('_id number')
    .lean();
  const ranks = generateNKeysBetween(null, null, column.length);
  await Ticket.bulkWrite(column.map((t, i) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { rank: ranks[i] } } } })));
  return new Map(column.map((t, i) => [t.number, ranks[i]]));
}

// Drag and drop on the board. Any developer may move any card: moving work along is
// everyone's job. Reordering inside a column is not workflow, so only column changes are logged.
export async function moveTicket(project, membership, ticket, { status, after = null, before = null, overrideWip }) {
  if (ticket.deletedAt) throw ticketDeleted();
  requireStatus(project, status);
  const wipOverride = status !== ticket.status && await checkWip(project, membership, status, ticket._id, overrideWip);

  const stale = () => new HttpError(409, 'stale_board', 'The board changed while you were dragging. Refresh and try again.');
  const neighbour = async (number) => {
    if (number === null) return null;
    const n = await Ticket.findOne({ project: project._id, number, deletedAt: null }).select('rank status').lean();
    if (!n || n.status !== status || String(n._id) === String(ticket._id)) throw stale();
    return n.rank;
  };
  let above = await neighbour(after);
  let below = await neighbour(before);
  if (above !== null && below !== null && above >= below) {
    const ranks = await rebalance(project._id, status, ticket._id);
    above = ranks.get(after);
    below = ranks.get(before);
    if (above >= below) throw stale();
  }
  ticket.rank = above === null && below === null
    ? await bottomRank(project._id, status, ticket._id)
    : generateKeyBetween(above, below);

  const at = new Date();
  const changedColumn = status !== ticket.status;
  const from = ticket.status;
  if (changedColumn) applyStatus(ticket, project, status, at);
  await ticket.save();
  if (changedColumn) {
    await TicketEvent.create({
      project: project._id, ticket: ticket._id, actor: membership.user, type: 'status_changed', from, to: status, at,
      ...(wipOverride && { field: 'wip_override' }),
    });
    await afterStatusChange(project, ticket, membership.user, at);
    await notifyFromEvents(project, ticket, membership.user, [{ type: 'status_changed', from, to: status }]);
    await runRules(project, ticket, [{ type: 'status_changed', from, to: status }]);
  }
  await ticket.populate(PEOPLE);
  return serializeTicket(ticket, project);
}

// Deleting moves a ticket to the bin, where it can be restored (an "Undo" in the app).
export async function deleteTicket(project, membership, ticket) {
  if (ticket.deletedAt) throw ticketDeleted();
  if (!canDelete(membership, ticket)) {
    throw new HttpError(403, 'forbidden', 'You can delete tickets you reported. Managers can delete any ticket.');
  }
  ticket.deletedAt = new Date();
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: membership.user, type: 'deleted', at: ticket.deletedAt });
  await afterStatusChange(project, ticket, membership.user, ticket.deletedAt);
}

export async function restoreTicket(project, membership, ticket) {
  if (!ticket.deletedAt) throw new HttpError(409, 'not_deleted', 'This ticket is not deleted');
  if (!canDelete(membership, ticket)) {
    throw new HttpError(403, 'forbidden', 'You can restore tickets you reported. Managers can restore any ticket.');
  }
  ticket.deletedAt = null;
  // Its column may have moved on; it comes back at the bottom.
  ticket.rank = await bottomRank(project._id, ticket.status, ticket._id);
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: membership.user, type: 'restored' });
  await afterStatusChange(project, ticket, membership.user);
  await ticket.populate(PEOPLE);
  return serializeTicket(ticket, project);
}

export async function ticketHistory(project, ticket) {
  const events = await TicketEvent.find({ ticket: ticket._id }).sort({ at: 1, _id: 1 }).populate('actor', 'name email');
  return events.map((e) => {
    const json = e.toJSON();
    json.id = String(json._id);
    delete json._id;
    delete json.project;
    delete json.ticket;
    return json;
  });
}
