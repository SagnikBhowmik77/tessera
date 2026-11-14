import * as sprints from '../services/sprint.service.js';
import * as tickets from '../services/ticket.service.js';
import { publish } from '../realtime.js';

// Sprints, milestones and the retro report. Every change tells everyone with the project open
// to refresh their planning views (and the board, when tickets moved).
const changed = (req, ticketsMoved = false) => {
  const room = String(req.project._id);
  const actorId = String(req.user._id);
  publish(room, 'planning', { action: 'updated', actorId });
  if (ticketsMoved) publish(room, 'ticket', { action: 'updated', actorId });
};

export async function list(req, res) {
  res.json(await sprints.listSprints(req.project));
}

export async function create(req, res) {
  const sprint = await sprints.createSprint(req.project, req.valid.body);
  changed(req);
  res.status(201).json({ sprint });
}

export async function update(req, res) {
  const sprint = await sprints.updateSprint(req.project, req.valid.params.sprintId, req.valid.body);
  changed(req);
  res.json({ sprint });
}

export async function remove(req, res) {
  await sprints.deleteSprint(req.project, req.user._id, req.valid.params.sprintId);
  changed(req, true);
  res.status(204).end();
}

export async function start(req, res) {
  const sprint = await sprints.startSprint(req.project, req.user._id, req.valid.params.sprintId);
  changed(req);
  res.json({ sprint });
}

export async function complete(req, res) {
  const result = await sprints.completeSprint(req.project, req.user._id, req.valid.params.sprintId, req.valid.body);
  changed(req, true);
  res.json(result);
}

export async function report(req, res) {
  res.json({ report: await sprints.sprintReport(req.project, req.valid.params.sprintId) });
}

export async function milestones(req, res) {
  res.json({ milestones: await sprints.listMilestones(req.project) });
}

export async function createMilestone(req, res) {
  const milestone = await sprints.createMilestone(req.project, req.valid.body);
  changed(req);
  res.status(201).json({ milestone });
}

export async function updateMilestone(req, res) {
  const milestone = await sprints.updateMilestone(req.project, req.valid.params.milestoneId, req.valid.body);
  changed(req);
  res.json({ milestone });
}

export async function removeMilestone(req, res) {
  await sprints.deleteMilestone(req.project, req.user._id, req.valid.params.milestoneId);
  changed(req, true);
  res.status(204).end();
}

// PUT /tickets/:ref/sprint and /tickets/:ref/milestone. Answers with the fresh ticket.
async function setOnTicket(req, res, fn, value) {
  const ticket = await tickets.findTicket(req.project, req.valid.params.ref);
  await fn(req.project, req.membership, ticket, value);
  const fresh = await tickets.findTicket(req.project, String(ticket.number));
  const room = String(req.project._id);
  const actorId = String(req.user._id);
  publish(room, 'ticket', { action: 'updated', actorId, number: ticket.number });
  publish(room, 'planning', { action: 'updated', actorId });
  res.json({ ticket: tickets.serializeTicket(fresh, req.project) });
}

export const setTicketSprint = (req, res) => setOnTicket(req, res, sprints.setTicketSprint, req.valid.body.sprint);
export const setTicketMilestone = (req, res) => setOnTicket(req, res, sprints.setTicketMilestone, req.valid.body.milestone);
