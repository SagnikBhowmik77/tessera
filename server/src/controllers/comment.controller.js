import { findTicket } from '../services/ticket.service.js';
import * as comments from '../services/comment.service.js';
import * as attachments from '../services/attachment.service.js';
import { publish } from '../realtime.js';

// Controllers translate HTTP <-> service calls; all rules live in the services.
// Changes are pushed live to everyone with the project open.
const ticketOf = (req) => findTicket(req.project, req.valid.params.ref);
const live = (req, event, action, number, payload = {}) =>
  publish(String(req.project._id), event, { action, number, actorId: String(req.user._id), ...payload });

export async function listComments(req, res) {
  res.json({ comments: await comments.listComments(await ticketOf(req)) });
}

export async function addComment(req, res) {
  const ticket = await ticketOf(req);
  const comment = await comments.addComment(req.project, req.membership, ticket, req.valid.body);
  live(req, 'comment', 'added', ticket.number, { comment });
  res.status(201).json({ comment });
}

export async function editComment(req, res) {
  const ticket = await ticketOf(req);
  const comment = await comments.editComment(req.project, req.membership, ticket, req.valid.params.commentId, req.valid.body);
  live(req, 'comment', 'edited', ticket.number, { comment });
  res.json({ comment });
}

export async function deleteComment(req, res) {
  const ticket = await ticketOf(req);
  await comments.deleteComment(req.membership, ticket, req.valid.params.commentId);
  live(req, 'comment', 'deleted', ticket.number, { commentId: req.valid.params.commentId });
  res.status(204).end();
}

export async function listAttachments(req, res) {
  res.json({ attachments: await attachments.listAttachments(await ticketOf(req)) });
}

export async function upload(req, res) {
  const ticket = await ticketOf(req);
  const attachment = await attachments.uploadAttachment(req.project, req.membership, ticket, req.file);
  live(req, 'attachment', 'added', ticket.number, { attachment });
  res.status(201).json({ attachment });
}

export async function download(req, res) {
  await attachments.sendAttachment(await ticketOf(req), req.valid.params.attachmentId, res);
}

export async function removeAttachment(req, res) {
  const ticket = await ticketOf(req);
  await attachments.deleteAttachment(req.project, req.membership, ticket, req.valid.params.attachmentId);
  live(req, 'attachment', 'removed', ticket.number, { attachmentId: req.valid.params.attachmentId });
  res.status(204).end();
}

// Pin or unpin a comment as one of the ticket's decisions.
export async function pin(req, res) {
  const ticket = await ticketOf(req);
  const on = req.method === 'PUT';
  const comment = await comments.pinComment(req.project, req.membership, ticket, req.valid.params.commentId, on);
  live(req, 'comment', 'edited', ticket.number, { comment });
  res.json({ comment });
}
