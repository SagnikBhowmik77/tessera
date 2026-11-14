import * as tickets from '../services/ticket.service.js';
import { projectLabels, searchTickets } from '../services/search.service.js';
import { projectWorkload } from '../services/workload.service.js';
import * as bulkService from '../services/bulk.service.js';
import * as templates from '../services/template.service.js';
import { HttpError } from '../errors.js';
import { publish } from '../realtime.js';

// Controllers translate HTTP <-> service calls; all rules live in the service.
// Every change is also pushed to everyone with the project open (Socket.IO 'ticket' event);
// `actorId` lets the person who made the change ignore their own echo.
const ticketOf = (req) => tickets.findTicket(req.project, req.valid.params.ref);
const live = (req, action, payload) =>
  publish(String(req.project._id), 'ticket', { action, actorId: String(req.user._id), ...payload });

// The board, the list view and search: { tickets, total, page, pages, search? }.
export async function list(req, res) {
  res.json(await searchTickets(req.project, req.user, req.valid.query));
}

// Bulk edit / delete / restore: { done, failed: [{ key, message }], results }.
export async function bulk(req, res) {
  const result = await bulkService.bulkChange(req.project, req.membership, req.valid.body);
  if (result.done) live(req, 'updated', {});
  res.json(result);
}

// The list as CSV, with the same filters as the list itself.
export async function exportCsv(req, res) {
  const { csv, filename, count, total } = await bulkService.exportTickets(req.project, req.user, req.valid.query);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Export-Count': String(count),
    'X-Export-Total': String(total),
  });
  res.send(csv);
}

// ?dryRun=true checks the file and saves nothing; otherwise creates the tickets.
export async function importCsv(req, res) {
  if (!req.file) throw new HttpError(400, 'no_file', 'Choose a CSV file to import');
  const text = req.file.buffer.toString('utf8');
  const { dryRun, skipInvalid } = req.valid.query;
  if (dryRun) return res.json({ preview: await bulkService.previewImport(req.project, text) });
  const result = await bulkService.importTickets(req.project, req.user, req.membership, text, { skipInvalid });
  if (result.created.length) live(req, 'created', {});
  return res.status(result.created.length ? 201 : 200).json(result);
}

export async function labels(req, res) {
  res.json({ labels: await projectLabels(req.project) });
}

export async function workload(req, res) {
  res.json(await projectWorkload(req.project));
}

// 201 for a new ticket; 200 when a pasted error was grouped onto the ticket that already has it.
export async function create(req, res) {
  const { templateId, ...input } = req.valid.body;
  if (templateId) {
    const { ticket, subtasks } = await templates.createFromTemplate(req.project, req.user, req.membership, templateId, input);
    live(req, 'created', { ticket });
    return res.status(201).json({ ticket, grouped: false, regression: false, subtasks });
  }
  const { ticket, grouped, regression } = await tickets.createTicket(req.project, req.user, req.valid.body);
  live(req, grouped ? 'updated' : 'created', { ticket });
  res.status(grouped ? 200 : 201).json({ ticket, grouped, regression });
}

export async function get(req, res) {
  res.json({ ticket: await tickets.getTicket(req.project, req.valid.params.ref) });
}

export async function update(req, res) {
  const ticket = await tickets.updateTicket(req.project, req.membership, await ticketOf(req), req.valid.body);
  live(req, 'updated', { ticket });
  // A handoff note is a new comment: open drawers refresh their comments.
  if (req.valid.body.handoffNote) {
    publish(String(req.project._id), 'comment', { action: 'added', number: ticket.number, actorId: String(req.user._id) });
  }
  res.json({ ticket });
}

export async function move(req, res) {
  const ticket = await tickets.moveTicket(req.project, req.membership, await ticketOf(req), req.valid.body);
  live(req, 'moved', { ticket });
  res.json({ ticket });
}

export async function remove(req, res) {
  const ticket = await ticketOf(req);
  await tickets.deleteTicket(req.project, req.membership, ticket);
  live(req, 'deleted', { number: ticket.number });
  res.status(204).end();
}

export async function restore(req, res) {
  const ticket = await tickets.restoreTicket(req.project, req.membership, await ticketOf(req));
  live(req, 'restored', { ticket });
  res.json({ ticket });
}

export async function history(req, res) {
  res.json({ events: await tickets.ticketHistory(req.project, await ticketOf(req)) });
}
