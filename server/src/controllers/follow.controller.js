import * as tickets from '../services/ticket.service.js';
import * as follow from '../services/follow.service.js';
import { projectAgeing } from '../services/flow.service.js';

// Per-person ticket following: catch-up on open, Watch, snooze. Nothing here changes the
// ticket for anyone else, so none of it is broadcast to the project.
const ticketOf = (req) => tickets.findTicket(req.project, req.valid.params.ref);

export async function visit(req, res) {
  res.json(await follow.visitTicket(req.project, req.user, await ticketOf(req)));
}

export async function watch(req, res) {
  res.json(await follow.setWatching(await ticketOf(req), req.user, true));
}

export async function unwatch(req, res) {
  res.json(await follow.setWatching(await ticketOf(req), req.user, false));
}

export async function snooze(req, res) {
  res.json(await follow.snoozeTicket(req.project, await ticketOf(req), req.user, req.valid.body.until));
}

export async function unsnooze(req, res) {
  res.json(await follow.unsnoozeTicket(await ticketOf(req), req.user));
}

export async function ageing(req, res) {
  res.json(await projectAgeing(req.project));
}
