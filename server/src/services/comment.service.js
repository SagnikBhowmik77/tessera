import { emitTicketEvents } from './hooks.js';
import mongoose from 'mongoose';
import { HttpError } from '../errors.js';
import { Comment, Ticket, TicketEvent, Tracker } from '../models/index.js';
import { roleAtLeast } from './project.service.js';
import { emailReporterReply, excerptOf, notify } from './notification.service.js';

// Mentions are written as @[Name](userId) by the app's @-picker.
const MENTION = /@\[[^\]\n]{1,80}\]\(([a-f0-9]{24})\)/g;

// Only real members of the project count as mentions (others are ignored, not errors,
// so an old comment still saves after someone leaves the project).
export function extractMentions(project, body) {
  const members = new Set(project.members.map((m) => String(m.user)));
  const ids = new Set([...body.matchAll(MENTION)].map((m) => m[1]).filter((id) => members.has(id)));
  return [...ids].map((id) => new mongoose.Types.ObjectId(id));
}

const ticketDeleted = () => new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');
const commentNotFound = () => new HttpError(404, 'comment_not_found', 'Comment not found');

const PEOPLE = [{ path: 'author', select: 'name email' }, { path: 'pinnedBy', select: 'name email' }];

async function populate(comment) {
  await comment.populate(PEOPLE);
  return comment.toJSON();
}

// Top-level comments oldest first, each with its replies oldest first.
export async function listComments(ticket) {
  const all = (await Comment.find({ ticket: ticket._id }).sort({ createdAt: 1, _id: 1 }).populate(PEOPLE))
    .map((c) => c.toJSON());
  const roots = all.filter((c) => !c.parent).map((c) => ({ ...c, replies: [] }));
  const byId = new Map(roots.map((r) => [r.id, r]));
  for (const c of all) if (c.parent) byId.get(c.parent)?.replies.push(c);
  // A deleted thread starter with no replies has nothing left to show.
  return roots.filter((r) => !r.deletedAt || r.replies.length);
}

export async function addComment(project, membership, ticket, { body, parentId, visibility = 'internal', trackerId = null }) {
  if (ticket.deletedAt) throw ticketDeleted();
  // A reply to the reporter is an email to someone outside the team: only on tickets that came
  // with a contact address, only from people who work on tickets, and as its own thread.
  const toReporter = visibility === 'reporter';
  if (toReporter) {
    if (!roleAtLeast(membership.role, 'developer')) throw new HttpError(403, 'forbidden', 'Viewers cannot reply to reporters');
    if (parentId) throw new HttpError(400, 'reporter_reply_in_thread', 'Replies to the reporter start their own thread');
  }
  // Which reporter (E11): the one picked, else the first. Without a tracker, the ticket's contact.
  const tracker = !toReporter ? null : trackerId
    ? await Tracker.findOne({ _id: trackerId, ticket: ticket._id }).lean()
    : await Tracker.findOne({ ticket: ticket._id }).sort({ createdAt: 1 }).lean();
  if (toReporter && trackerId && !tracker) throw new HttpError(400, 'no_reporter', 'That reporter is not on this ticket');
  const to = tracker ?? (ticket.contact?.email ? { email: ticket.contact.email, name: ticket.contact.name } : null);
  if (toReporter && !to) throw new HttpError(400, 'no_reporter', 'This ticket has no outside reporter to reply to');
  let parent = null;
  if (parentId) {
    const target = await Comment.findOne({ _id: parentId, ticket: ticket._id }).lean();
    if (!target) throw new HttpError(400, 'parent_not_found', 'The comment you are replying to is not on this ticket');
    parent = target.parent ?? target._id;
  }
  const comment = await Comment.create({
    project: project._id,
    ticket: ticket._id,
    author: membership.user,
    parent,
    body,
    visibility,
    tracker: tracker?._id ?? null,
    mentions: extractMentions(project, body),
  });
  if (toReporter) {
    await comment.populate('author', 'name');
    // A reporter who left no email reads it on their tracking page instead.
    if (to.email) {
      comment.sentTo = to.email;
      comment.sentAt = new Date();
      await comment.save();
      emailReporterReply(project, ticket, comment.author?.name ?? 'The team', body, to);
    }
  }
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor: membership.user, type: 'commented',
    to: { comment: comment._id }, at: comment.createdAt,
  });
  emitTicketEvents(project, ticket, [{ type: 'commented', comment: { id: String(comment._id), body: comment.body, visibility: comment.visibility, author: String(membership.user) } }]);
  // Someone other than the reporter answering is the team's first response (service levels).
  if (!ticket.respondedAt && String(membership.user) !== String(ticket.reporter?._id ?? ticket.reporter)) {
    await Ticket.updateOne({ _id: ticket._id, respondedAt: null }, { $set: { respondedAt: comment.createdAt } });
  }
  // Mentioned people get "mentioned you"; the reporter and assignee get "new comment"
  // unless they were mentioned already. The author is never notified about themselves.
  const mentioned = comment.mentions.map(String);
  // Reporter, assignee and anyone who pressed Watch.
  const watchers = [...new Set([ticket.reporter, ticket.assignee, ...(ticket.watchers ?? [])].filter(Boolean).map((u) => String(u._id ?? u)))]
    .filter((id) => !mentioned.includes(id));
  const base = commentNotice(project, ticket, membership, comment);
  await notify([
    ...mentioned.map((user) => ({ ...base, user, type: 'mention' })),
    ...watchers.map((user) => ({ ...base, user, type: 'comment' })),
  ]);
  return populate(comment);
}

const commentNotice = (project, ticket, membership, comment) => ({
  project: project._id, ticket: ticket._id, actor: membership.user, comment: comment._id,
  ticketKey: `${project.key}-${ticket.number}`, ticketTitle: ticket.title, excerpt: excerptOf(comment.body),
});

async function findComment(ticket, commentId) {
  const comment = await Comment.findOne({ _id: commentId, ticket: ticket._id });
  if (!comment || comment.deletedAt) throw commentNotFound();
  return comment;
}

const isAuthor = (membership, comment) => comment.author && String(comment.author) === String(membership.user);

// Only the author edits their words.
export async function editComment(project, membership, ticket, commentId, { body }) {
  const comment = await findComment(ticket, commentId);
  if (!isAuthor(membership, comment)) throw new HttpError(403, 'forbidden', 'You can only edit your own comments');
  if (comment.body !== body) {
    const before = new Set(comment.mentions.map(String));
    comment.body = body;
    comment.mentions = extractMentions(project, body);
    comment.editedAt = new Date();
    await comment.save();
    // Only people newly mentioned by the edit hear about it.
    const added = comment.mentions.map(String).filter((id) => !before.has(id));
    const base = commentNotice(project, ticket, membership, comment);
    await notify(added.map((user) => ({ ...base, user, type: 'mention' })));
  }
  return populate(comment);
}

// Pin (or unpin) a comment as one of the ticket's decisions. Anyone who works on tickets can.
export async function pinComment(project, membership, ticket, commentId, on) {
  if (!roleAtLeast(membership.role, 'developer')) throw new HttpError(403, 'forbidden', 'Viewers cannot pin decisions');
  const comment = await findComment(ticket, commentId);
  if (Boolean(comment.pinnedAt) !== on) {
    comment.pinnedAt = on ? new Date() : null;
    comment.pinnedBy = on ? membership.user : null;
    await comment.save();
    await TicketEvent.create({
      project: project._id, ticket: ticket._id, actor: membership.user, type: on ? 'decision_pinned' : 'decision_unpinned',
      to: { comment: comment._id, excerpt: excerptOf(comment.body) },
    });
  }
  return populate(comment);
}

// Authors delete their own; managers and admins can remove any (moderation).
export async function deleteComment(membership, ticket, commentId) {
  const comment = await findComment(ticket, commentId);
  if (!isAuthor(membership, comment) && !roleAtLeast(membership.role, 'manager')) {
    throw new HttpError(403, 'forbidden', 'You can delete your own comments. Managers can delete any comment.');
  }
  comment.deletedAt = new Date();
  comment.body = '';
  comment.mentions = [];
  // A deleted comment can't stay a decision.
  comment.pinnedAt = null;
  comment.pinnedBy = null;
  await comment.save();
}
