import { HttpError } from '../errors.js';
import { Ticket, TicketEvent } from '../models/index.js';
import { canEdit, createTicket, findTicket, ticketKey } from './ticket.service.js';
import { refreshBlocked } from './blocking.service.js';

// Planning links between tickets: epic, sub-tasks (one level), "blocked by", and a manual
// "blocked" flag. All in one project. Every change goes into the ticket's history.

const MAX_BLOCKERS = 20;
const doneKeys = (project) => new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));

function requireEditor(membership, ticket) {
  if (ticket.deletedAt) throw new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');
  if (!canEdit(membership, ticket)) {
    throw new HttpError(403, 'forbidden', 'You can change tickets you reported or are assigned to. Managers can change any ticket.');
  }
}

const brief = (project, t, done) => t && ({
  id: String(t._id),
  number: t.number,
  key: ticketKey(project, t.number),
  title: t.title,
  type: t.type,
  status: t.status,
  done: done.has(t.status),
  deleted: Boolean(t.deletedAt),
  storyPoints: t.storyPoints ?? null,
});

const ref = (project, t) => (t ? { id: String(t._id), key: ticketKey(project, t.number) } : null);

async function logChange(project, ticket, actor, field, from, to) {
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor, type: 'relation_changed', field, from, to });
}

// Blocked time from the history: every 'blocked' event starts (or re-reasons) a spell, and
// 'unblocked' ends it. A spell still open counts up to now.
async function blockedTime(ticket, now = new Date()) {
  const events = await TicketEvent.find({ ticket: ticket._id, type: { $in: ['blocked', 'unblocked'] } }, { type: 1, at: 1 })
    .sort({ at: 1, _id: 1 }).lean();
  let since = null;
  let ms = 0;
  let spells = 0;
  for (const e of events) {
    if (e.type === 'blocked') {
      if (!since) { since = e.at; spells += 1; }
    } else if (since) {
      ms += e.at - since;
      since = null;
    }
  }
  if (since) ms += now - since;
  return { hours: Math.round((ms / 3600e3) * 100) / 100, spells };
}

export async function getRelations(project, ticket) {
  const done = doneKeys(project);
  const [epic, parent, subtasks, members, blockers, blocks, time] = await Promise.all([
    ticket.epic ? Ticket.findById(ticket.epic).lean() : null,
    ticket.parent ? Ticket.findById(ticket.parent).lean() : null,
    Ticket.find({ parent: ticket._id, deletedAt: null }).sort({ number: 1 }).lean(),
    ticket.type === 'epic' ? Ticket.find({ epic: ticket._id, deletedAt: null }).sort({ number: 1 }).lean() : [],
    Ticket.find({ _id: { $in: ticket.blockedBy } }).sort({ number: 1 }).lean(),
    Ticket.find({ blockedBy: ticket._id, deletedAt: null }).sort({ number: 1 }).lean(),
    blockedTime(ticket),
  ]);
  const progressOf = (list) => ({
    total: list.length,
    done: list.filter((t) => done.has(t.status)).length,
    points: list.reduce((s, t) => s + (t.storyPoints ?? 0), 0),
    pointsDone: list.filter((t) => done.has(t.status)).reduce((s, t) => s + (t.storyPoints ?? 0), 0),
  });
  return {
    epic: brief(project, epic, done),
    parent: brief(project, parent, done),
    subtasks: subtasks.map((t) => brief(project, t, done)),
    subtaskProgress: progressOf(subtasks),
    epicTickets: members.map((t) => brief(project, t, done)),
    epicProgress: ticket.type === 'epic' ? progressOf(members) : null,
    blockedBy: blockers.map((t) => brief(project, t, done)),
    blocks: blocks.map((t) => brief(project, t, done)),
    flag: ticket.flag?.reason ? { reason: ticket.flag.reason, at: ticket.flag.at } : null,
    blocked: ticket.blockedSince ? { since: ticket.blockedSince, reason: ticket.blockedReason } : null,
    blockedTime: time,
  };
}

// Put a ticket in an epic (or take it out with null).
export async function setEpic(project, membership, ticket, epicRef) {
  requireEditor(membership, ticket);
  if (ticket.type === 'epic') throw new HttpError(400, 'epic_in_epic', 'An epic can\'t be inside another epic');
  if (ticket.parent) throw new HttpError(400, 'subtask_epic', 'A sub-task follows its parent\'s epic. Set the epic on the parent instead.');
  let epic = null;
  if (epicRef !== null) {
    epic = await findTicket(project, epicRef);
    if (epic.type !== 'epic') throw new HttpError(400, 'not_an_epic', `${ticketKey(project, epic.number)} is not an epic`);
    if (epic.deletedAt) throw new HttpError(400, 'epic_deleted', 'That epic is in the bin');
  }
  if (String(ticket.epic ?? '') === String(epic?._id ?? '')) return;
  const before = ticket.epic ? await Ticket.findById(ticket.epic, { number: 1 }).lean() : null;
  await Ticket.updateOne({ _id: ticket._id }, { $set: { epic: epic?._id ?? null } });
  await logChange(project, ticket, membership.user, 'epic', ref(project, before), ref(project, epic));
}

// Make a ticket a sub-task of another (or a top-level ticket again with null). One level only.
export async function setParent(project, membership, ticket, parentRef) {
  requireEditor(membership, ticket);
  let parent = null;
  if (parentRef !== null) {
    parent = await findTicket(project, parentRef);
    if (String(parent._id) === String(ticket._id)) throw new HttpError(400, 'parent_self', 'A ticket can\'t be its own sub-task');
    if (ticket.type === 'epic' || parent.type === 'epic') throw new HttpError(400, 'parent_epic', 'Epics group tickets with "Add to epic", not as sub-tasks');
    if (parent.parent) throw new HttpError(400, 'parent_nested', 'Sub-tasks are one level deep: that ticket is already a sub-task');
    if (await Ticket.exists({ parent: ticket._id, deletedAt: null })) {
      throw new HttpError(400, 'parent_has_children', 'This ticket has sub-tasks of its own, so it can\'t become a sub-task');
    }
    if (parent.deletedAt) throw new HttpError(400, 'parent_deleted', 'That ticket is in the bin');
  }
  if (String(ticket.parent ?? '') === String(parent?._id ?? '')) return;
  const before = ticket.parent ? await Ticket.findById(ticket.parent, { number: 1 }).lean() : null;
  // A sub-task belongs to its parent's epic, not to one of its own.
  await Ticket.updateOne({ _id: ticket._id }, { $set: { parent: parent?._id ?? null, ...(parent && { epic: null }) } });
  await logChange(project, ticket, membership.user, 'parent', ref(project, before), ref(project, parent));
}

// A new sub-task under this ticket, assigned like any new ticket.
export async function addSubtask(project, user, membership, parent, { title, assigneeId }) {
  if (parent.deletedAt) throw new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');
  if (parent.type === 'epic') throw new HttpError(400, 'parent_epic', 'Epics group tickets with "Add to epic", not as sub-tasks');
  if (parent.parent) throw new HttpError(400, 'parent_nested', 'Sub-tasks are one level deep: this ticket is already a sub-task');
  const { ticket } = await createTicket(project, user, { title, type: 'task', priority: parent.priority, labels: [], ...(assigneeId && { assigneeId }) });
  const created = await Ticket.findById(ticket.id);
  await Ticket.updateOne({ _id: created._id }, { $set: { parent: parent._id } });
  await logChange(project, created, membership.user, 'parent', null, ref(project, parent));
  return { ...ticket, parent: String(parent._id) };
}

// Would `blocker` (directly or through its own blockers) end up waiting on `ticket`?
async function wouldCycle(ticket, blocker) {
  const seen = new Set();
  let frontier = [blocker._id];
  while (frontier.length) {
    if (frontier.some((id) => String(id) === String(ticket._id))) return true;
    const next = await Ticket.find({ _id: { $in: frontier } }, { blockedBy: 1 }).lean();
    frontier = next.flatMap((t) => t.blockedBy).filter((id) => !seen.has(String(id)));
    for (const id of frontier) seen.add(String(id));
    if (seen.size > 2000) break;
  }
  return false;
}

export async function addBlocker(project, membership, ticket, blockerRef) {
  requireEditor(membership, ticket);
  const blocker = await findTicket(project, blockerRef);
  const bKey = ticketKey(project, blocker.number);
  if (String(blocker._id) === String(ticket._id)) throw new HttpError(400, 'block_self', 'A ticket can\'t block itself');
  if (ticket.blockedBy.some((id) => String(id) === String(blocker._id))) return;
  if (ticket.blockedBy.length >= MAX_BLOCKERS) throw new HttpError(400, 'too_many_blockers', `At most ${MAX_BLOCKERS} blockers per ticket`);
  if (await wouldCycle(ticket, blocker)) {
    throw new HttpError(400, 'block_cycle', `${bKey} already waits on ${ticketKey(project, ticket.number)} (directly or through other tickets), so that would be a loop`);
  }
  await Ticket.updateOne({ _id: ticket._id }, { $addToSet: { blockedBy: blocker._id } });
  await logChange(project, ticket, membership.user, 'blocked_by', null, ref(project, blocker));
  await refreshBlocked(project, [ticket._id], membership.user);
}

export async function removeBlocker(project, membership, ticket, blockerRef) {
  requireEditor(membership, ticket);
  const blocker = await findTicket(project, blockerRef);
  if (!ticket.blockedBy.some((id) => String(id) === String(blocker._id))) return;
  await Ticket.updateOne({ _id: ticket._id }, { $pull: { blockedBy: blocker._id } });
  await logChange(project, ticket, membership.user, 'blocked_by', ref(project, blocker), null);
  await refreshBlocked(project, [ticket._id], membership.user);
}

// Flag as blocked by hand ("waiting for the payment provider"), or clear the flag with null.
export async function setFlag(project, membership, ticket, reason) {
  requireEditor(membership, ticket);
  const text = reason?.trim() || null;
  if ((ticket.flag?.reason ?? null) === text) return;
  await Ticket.updateOne({ _id: ticket._id }, { $set: { flag: text ? { reason: text, by: membership.user, at: new Date() } : null } });
  await refreshBlocked(project, [ticket._id], membership.user);
}
