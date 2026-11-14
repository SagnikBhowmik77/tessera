import * as bugs from '../services/bug.service.js';
import { findTicket } from '../services/ticket.service.js';
import { compareErrors, errorInsights, muteError, muteJson, unmuteError } from '../services/errorinsights.service.js';
import * as repros from '../services/repro.service.js';
import { remapTicket } from '../services/sourcemap.service.js';
import * as deep from '../services/githubdeep.service.js';
import { publish } from '../realtime.js';

// Bug intelligence endpoints (all rules live in bug.service.js and bugs/*).

export async function parse(req, res) {
  res.json(await bugs.previewError(req.project, req.valid.body));
}

export async function similar(req, res) {
  res.json({ similar: await bugs.similarTickets(req.project, req.valid.body) });
}

export async function errors(req, res) {
  res.json({ errors: await bugs.errorGroups(req.project) });
}

// E5A: everything the drawer's error panel shows, and muting.
export async function insights(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  res.json({ insights: await errorInsights(req.project, ticket) });
}

export async function mute(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  await muteError(req.project, ticket, req.user._id, req.valid.body);
  publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), number: ticket.number });
  res.json({ mute: muteJson(ticket.error) });
}

export async function unmute(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  if (await unmuteError(req.project, ticket, req.user._id)) {
    publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), number: ticket.number });
  }
  res.json({ mute: null });
}

// E5B: two crashes side by side.
export async function compare(req, res) {
  const [a, b] = await Promise.all([findTicket(req.project, req.valid.query.a), findTicket(req.project, req.valid.query.b)]);
  res.json(await compareErrors(req.project, a, b));
}

// E5B: reproduction steps and attempts. Every change answers with the fresh state.
const reproChanged = async (req, res, ticket) => {
  publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), number: ticket.number });
  res.json({ repro: await repros.getRepro(ticket) });
};
export async function repro(req, res) {
  res.json({ repro: await repros.getRepro(await findTicket(req.project, req.valid.params.ref)) });
}
export async function reproSteps(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  await repros.setSteps(req.project, ticket, req.user._id, req.valid.body.steps);
  await reproChanged(req, res, ticket);
}
export async function reproAttempt(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  await repros.addAttempt(req.project, ticket, req.user._id, req.valid.body);
  await reproChanged(req, res, ticket);
}
export async function reproRemove(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  await repros.removeAttempt(req.project, req.membership, ticket, req.user._id, req.valid.params.attemptId);
  await reproChanged(req, res, ticket);
}

// E6B: map an older crash again with source maps uploaded since.
export async function unminify(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  const result = await remapTicket(req.project, ticket, req.user._id);
  if (result.mapped) publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), number: ticket.number });
  res.json(result);
}

// E7: GitHub for one ticket.
const fresh = async (req, res, ticket, extra) => {
  publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), number: ticket.number });
  res.json(extra);
};
export async function githubRefresh(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  const refreshed = await deep.refreshTicketPrs(req.project, ticket);
  await fresh(req, res, ticket, { refreshed, links: ticket.links });
}
export async function githubSuspect(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  await fresh(req, res, ticket, { suspect: await deep.suspectFor(req.project, ticket) });
}
export async function githubIssue(req, res) {
  const ticket = await findTicket(req.project, req.valid.params.ref);
  await fresh(req, res, ticket, { githubIssue: await deep.createIssue(req.project, ticket) });
}
