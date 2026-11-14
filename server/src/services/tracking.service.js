import { randomBytes } from 'node:crypto';
import { HttpError } from '../errors.js';
import { Comment, Project, Ticket, TicketEvent, Tracker } from '../models/index.js';
import { publish } from '../realtime.js';
import { emitTicketEvents } from './hooks.js';
import { roleAtLeast } from './project.service.js';
import { emailReporterMerged, notify } from './notification.service.js';
import { findTicket, getTicket, moveFromIntegration, ticketKey } from './ticket.service.js';

// Client-facing (E11): each outside reporter gets a private link to follow their report, talk to
// the team, and say whether the fix worked. Merged duplicates keep every reporter's link working.

const newToken = () => randomBytes(18).toString('base64url');
const id = (x) => String(x?._id ?? x);

export async function createTracker(project, ticketId, { name, email, title }) {
  return Tracker.create({ project: project._id, ticket: ticketId, token: newToken(), name: name || null, email: email || null, title: title.slice(0, 200) });
}

async function load(token) {
  const tracker = await Tracker.findOne({ token });
  const project = tracker && await Project.findOne({ _id: tracker.project, archivedAt: null });
  const ticket = project && await Ticket.findOne({ _id: tracker.ticket, project: project._id });
  if (!ticket) throw new HttpError(404, 'tracker_not_found', 'This tracking link does not exist or was removed');
  return { tracker, project, ticket };
}

function stateOf(project, ticket) {
  if (ticket.deletedAt) return 'closed';
  if (ticket.triage) return 'received';
  const category = project.statuses.find((s) => s.key === ticket.status)?.category;
  return category === 'done' ? 'fixed' : category === 'in_progress' ? 'in_progress' : 'accepted';
}

// Mentions become plain names: the reporter has no account to follow them to.
const plain = (body) => body.replace(/@\[([^\]\n]{1,80})\]\([a-f0-9]{24}\)/g, '@$1');

// An answer counts for the latest fix only: after a reopen and a new fix, they can answer again.
const currentAnswer = (tracker, ticket) => (tracker.answer && ticket.resolvedAt && tracker.answer.at >= ticket.resolvedAt ? tracker.answer : null);

export async function trackView(token) {
  const { tracker, project, ticket } = await load(token);
  const messages = await Comment.find({
    ticket: ticket._id, visibility: 'reporter', deletedAt: null,
    // Older replies (before trackers) were matched by the address they were sent to.
    $or: [{ tracker: tracker._id }, ...(tracker.email ? [{ tracker: null, sentTo: tracker.email }] : [])],
  }).sort({ createdAt: 1 }).populate('author', 'name').lean();
  await Tracker.updateOne({ _id: tracker._id }, { $set: { lastSeenAt: new Date() } });
  const state = stateOf(project, ticket);
  return {
    project: { name: project.name },
    reference: ticketKey(project, ticket.number),
    title: tracker.title,
    reportedAt: tracker.createdAt,
    state,
    merged: tracker.mergedFrom != null,
    live: state === 'fixed' && ticket.shipped ? { release: ticket.shipped.release, at: ticket.shipped.at } : null,
    waitingForRelease: state === 'fixed' && Boolean(ticket.fixEmailPending),
    messages: messages.map((c) => ({
      id: id(c), from: c.fromReporter ? 'you' : 'team', name: c.fromReporter ? tracker.name : c.author?.name ?? 'The team', body: plain(c.body), at: c.createdAt,
    })),
    answer: currentAnswer(tracker, ticket),
    canAnswer: state === 'fixed',
    canWrite: state !== 'closed',
  };
}

const leadsOf = (project) => project.members.filter((m) => m.role === 'admin' || m.role === 'manager').map((m) => m.user);
// The assignee hears first; with nobody assigned, the project's managers.
const ownersOf = (project, ticket) => (ticket.assignee ? [ticket.assignee] : leadsOf(project));

export async function reporterMessage(token, body) {
  const { tracker, project, ticket } = await load(token);
  if (ticket.deletedAt) throw new HttpError(409, 'report_closed', 'This report is closed');
  const recent = await Comment.countDocuments({ tracker: tracker._id, fromReporter: true, createdAt: { $gt: new Date(Date.now() - 3_600_000) } });
  if (recent >= 10) throw new HttpError(429, 'rate_limited', 'You have sent 10 messages in the last hour. Please wait a little.');
  const who = tracker.name || 'The reporter';
  const comment = await Comment.create({
    project: project._id, ticket: ticket._id, author: null, body, visibility: 'reporter', tracker: tracker._id, fromReporter: true,
    external: { source: 'reporter', login: who, url: null },
  });
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: null, source: 'reporter', type: 'commented', to: { comment: comment._id }, at: comment.createdAt });
  await notify(ownersOf(project, ticket).map((user) => ({
    user, project: project._id, ticket: ticket._id, actor: null, type: 'reporter_message',
    ticketKey: ticketKey(project, ticket.number), ticketTitle: ticket.title, excerpt: `${who}: ${body.slice(0, 180)}`,
  })));
  emitTicketEvents(project, ticket, [{ type: 'commented', comment: { id: id(comment), body, visibility: 'reporter', author: null, reporter: who } }]);
  publish(id(project._id), 'comment', { action: 'created', number: ticket.number });
  return trackView(token);
}

// "Fixed" or "Still broken" from the fixed email or the tracking page. Still broken reopens it.
export async function reporterAnswer(token, value) {
  const { tracker, project, ticket } = await load(token);
  if (stateOf(project, ticket) !== 'fixed') throw new HttpError(409, 'not_fixed', 'This report is not marked as fixed yet');
  tracker.answer = { value, at: new Date() };
  await tracker.save();
  const who = tracker.name || 'The reporter';
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: null, source: 'reporter', type: 'reporter_answer', to: { value, name: who } });
  if (value === 'broken') {
    const to = (project.statuses.find((s) => s.category === 'todo') ?? project.statuses[0]).key;
    await moveFromIntegration(project, ticket, to, 'reporter');
    await notify(ownersOf(project, ticket).map((user) => ({
      user, project: project._id, ticket: ticket._id, actor: null, type: 'reporter_answer',
      ticketKey: ticketKey(project, ticket.number), ticketTitle: ticket.title, excerpt: `${who} says it is still broken. It was reopened.`,
    })));
    publish(id(project._id), 'ticket', { action: 'updated', actorId: null, number: ticket.number });
  }
  return trackView(token);
}

// The team's view of who reported it (people who work on tickets only: these are outside
// people's addresses).
export async function listTrackers(project, membership, ticket) {
  if (!roleAtLeast(membership.role, 'developer')) throw new HttpError(403, 'forbidden', 'Only people who work on tickets can see reporters');
  const rows = await Tracker.find({ ticket: ticket._id }).sort({ createdAt: 1 }).lean();
  return rows.map((t) => ({
    id: id(t), name: t.name, email: t.email, title: t.title, reportedAt: t.createdAt, lastSeenAt: t.lastSeenAt,
    mergedFrom: t.mergedFrom ? ticketKey(project, t.mergedFrom) : null, answer: currentAnswer(t, ticket),
  }));
}

// Two reports of the same problem become one. Every reporter of the duplicate moves over (and
// keeps their link, now following the surviving ticket); the duplicate is closed and points at it.
export async function mergeDuplicate(project, membership, user, source, intoRef) {
  if (!roleAtLeast(membership.role, 'developer')) throw new HttpError(403, 'forbidden', 'Only people who work on tickets can merge them');
  const target = await findTicket(project, intoRef);
  if (id(target) === id(source)) throw new HttpError(400, 'same_ticket', 'A ticket cannot be merged into itself');
  if (source.deletedAt || target.deletedAt) throw new HttpError(409, 'ticket_deleted', 'Restore the ticket first');
  if (source.duplicateOf) throw new HttpError(409, 'already_merged', 'This ticket was already merged');
  if (target.duplicateOf) throw new HttpError(409, 'target_merged', 'That ticket was itself merged into another one; merge into that one');

  const known = new Set([target.contact?.email, ...target.otherReporters.map((r) => r.email)].filter(Boolean).map((e) => e.toLowerCase()));
  for (const person of [source.contact, ...source.otherReporters].filter((p) => p?.email)) {
    if (known.has(person.email.toLowerCase())) continue;
    known.add(person.email.toLowerCase());
    if (!target.contact?.email) target.contact = { name: person.name, email: person.email };
    else if (target.otherReporters.length < 25) target.otherReporters.push({ name: person.name, email: person.email });
  }
  if (target.error && source.error) {
    target.error.occurrences += source.error.occurrences ?? 0;
    target.markModified('error');
  }
  await target.save();
  const moved = await Tracker.find({ ticket: source._id }).lean();
  await Tracker.updateMany({ ticket: source._id }, { $set: { ticket: target._id, mergedFrom: source.number } });

  // Its people now belong to the target, so closing the duplicate emails nobody.
  source.contact = null;
  source.otherReporters = [];
  source.duplicateOf = { ticket: target._id, number: target.number };
  if (!source.labels.includes('duplicate')) source.labels.push('duplicate');
  await source.save();
  const at = new Date();
  await TicketEvent.insertMany([
    { project: project._id, ticket: source._id, actor: user._id, type: 'merged', to: { into: ticketKey(project, target.number) }, at },
    { project: project._id, ticket: target._id, actor: user._id, type: 'merged', from: { ticket: ticketKey(project, source.number), reporters: moved.length }, at },
  ]);
  const done = project.statuses.find((s) => s.category === 'done').key;
  if (project.statuses.find((s) => s.key === source.status)?.category !== 'done') await moveFromIntegration(project, source, done, 'merge');

  for (const t of moved) if (t.email) emailReporterMerged(project, target, t);
  publish(id(project._id), 'ticket', { action: 'updated', actorId: id(user._id), number: source.number });
  publish(id(project._id), 'ticket', { action: 'updated', actorId: id(user._id), number: target.number });
  return { ticket: await getTicket(project, String(target.number)), reportersMoved: moved.length };
}
