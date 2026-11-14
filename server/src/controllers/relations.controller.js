import * as tickets from '../services/ticket.service.js';
import * as rel from '../services/relations.service.js';
import { publish } from '../realtime.js';

// Epic, sub-tasks, blockers and the blocked flag. Every change answers with the ticket's fresh
// relations and tells everyone with the project open to refresh it (and the board).
const ticketOf = (req) => tickets.findTicket(req.project, req.valid.params.ref);

async function respond(req, res, number) {
  const ticket = await tickets.findTicket(req.project, String(number));
  publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), number });
  res.json({ relations: await rel.getRelations(req.project, ticket) });
}

export async function get(req, res) {
  res.json({ relations: await rel.getRelations(req.project, await ticketOf(req)) });
}

export async function setEpic(req, res) {
  const ticket = await ticketOf(req);
  await rel.setEpic(req.project, req.membership, ticket, req.valid.body.epic);
  await respond(req, res, ticket.number);
}

export async function setParent(req, res) {
  const ticket = await ticketOf(req);
  await rel.setParent(req.project, req.membership, ticket, req.valid.body.parent);
  await respond(req, res, ticket.number);
}

export async function addSubtask(req, res) {
  const parent = await ticketOf(req);
  const ticket = await rel.addSubtask(req.project, req.user, req.membership, parent, req.valid.body);
  publish(String(req.project._id), 'ticket', { action: 'created', actorId: String(req.user._id), ticket });
  res.status(201);
  await respond(req, res, parent.number);
}

export async function addBlocker(req, res) {
  const ticket = await ticketOf(req);
  await rel.addBlocker(req.project, req.membership, ticket, req.valid.body.ticket);
  await respond(req, res, ticket.number);
}

export async function removeBlocker(req, res) {
  const ticket = await ticketOf(req);
  await rel.removeBlocker(req.project, req.membership, ticket, req.valid.params.blocker);
  await respond(req, res, ticket.number);
}

export async function setFlag(req, res) {
  const ticket = await ticketOf(req);
  await rel.setFlag(req.project, req.membership, ticket, req.method === 'DELETE' ? null : req.valid.body.reason);
  await respond(req, res, ticket.number);
}
