import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { parseCsv, toCsv, unsafe } from '../csv.js';
import { todayIn } from '../dates.js';
import { Milestone, Sprint, Ticket, User, TICKET_TYPES, PRIORITIES } from '../models/index.js';
import { createTicket, deleteTicket, findTicket, restoreTicket, updateTicket } from './ticket.service.js';
import { searchTickets } from './search.service.js';
import { setTicketMilestone, setTicketSprint } from './sprint.service.js';
import { setEpic } from './relations.service.js';
import { cleanFieldValues, fieldText } from './fields.service.js';

// Bulk work (E4A): one change applied to many tickets, CSV export of a filtered list, and CSV
// import. Every ticket goes through the same service calls as a single edit, so permissions,
// WIP limits and history are exactly the same; a ticket that can't be changed is reported, not
// silently skipped, and the others still go through.

const MAX_EXPORT = 5000;
export const MAX_IMPORT_ROWS = 500;

// Runs `fn` on each ticket; anything a ticket refuses becomes a line in `failed`.
async function each(project, numbers, fn) {
  const results = [];
  for (const number of numbers) {
    const key = `${project.key}-${number}`;
    try {
      const ticket = await findTicket(project, String(number));
      await fn(ticket);
      results.push({ key, number, ok: true });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      results.push({ key, number, ok: false, code: err.code, message: err.message });
    }
  }
  return { done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results };
}

export async function bulkChange(project, membership, { tickets, action, changes = {} }) {
  if (action === 'delete') return each(project, tickets, (t) => deleteTicket(project, membership, t));
  if (action === 'restore') return each(project, tickets, (t) => restoreTicket(project, membership, t));
  const { addLabels = [], removeLabels = [], sprint, milestone, overrideWip, ...fields } = changes;
  return each(project, tickets, async (ticket) => {
    if (ticket.deletedAt) throw new HttpError(409, 'ticket_deleted', 'It is in the bin. Restore it first.');
    const edit = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (addLabels.length || removeLabels.length) {
      const next = [...new Set([...ticket.labels.filter((l) => !removeLabels.includes(l)), ...addLabels])];
      if (next.length > 20) throw new HttpError(400, 'too_many_labels', 'It would have more than 20 labels');
      edit.labels = next;
    }
    if (Object.keys(edit).length) await updateTicket(project, membership, ticket, { ...edit, ...(overrideWip && { overrideWip }) });
    const fresh = () => findTicket(project, String(ticket.number));
    if (sprint !== undefined) await setTicketSprint(project, membership, await fresh(), sprint);
    if (milestone !== undefined) await setTicketMilestone(project, membership, await fresh(), milestone);
  });
}

// ---------------------------------------------------------------------------------------------
// Export

const COLUMNS = [
  'Key', 'Title', 'Type', 'Status', 'Priority', 'Assignee', 'Assignee email', 'Reporter', 'Labels', 'Story points',
  'Start date', 'Due date', 'Sprint', 'Milestone', 'Epic', 'Created', 'Updated', 'Resolved', 'Description',
];

// Every ticket matching the list's filters (all pages, up to 5,000), as CSV text.
export async function exportTickets(project, user, filters) {
  const rows = [];
  let total = 0;
  for (let page = 1; rows.length < MAX_EXPORT; page++) {
    const result = await searchTickets(project, user, { ...filters, page, limit: 500 });
    total = result.total;
    rows.push(...result.tickets);
    if (page >= result.pages) break;
  }
  const [sprints, milestones] = await Promise.all([
    Sprint.find({ project: project._id }, { name: 1 }).lean(),
    Milestone.find({ project: project._id }, { name: 1 }).lean(),
  ]);
  const sprintName = new Map(sprints.map((s) => [String(s._id), s.name]));
  const milestoneName = new Map(milestones.map((m) => [String(m._id), m.name]));
  const statusName = new Map(project.statuses.map((s) => [s.key, s.name]));
  const iso = (d) => (d ? new Date(d).toISOString() : '');
  const defs = project.customFields ?? [];
  const csv = toCsv([
    [...COLUMNS, ...defs.map((d) => d.name)],
    ...rows.slice(0, MAX_EXPORT).map((t) => [
      t.key, t.title, t.type, statusName.get(t.status) ?? t.status, t.priority,
      t.assignee?.name ?? '', t.assignee?.email ?? '', t.reporter?.name ?? '', t.labels.join(', '), t.storyPoints ?? '',
      t.startDate ?? '', t.dueDate ?? '', sprintName.get(t.sprint) ?? '', milestoneName.get(t.milestone) ?? '', t.epicInfo?.key ?? '',
      iso(t.createdAt), iso(t.updatedAt), iso(t.resolvedAt), t.description,
      ...defs.map((d) => fieldText(d, t.fields?.[d.key])),
    ]),
  ]);
  return { csv, count: Math.min(rows.length, MAX_EXPORT), total, filename: `${project.key}-tickets-${todayIn(config.timeZone)}.csv` };
}

// ---------------------------------------------------------------------------------------------
// Import

// Header names we understand (case and spacing don't matter). Anything else is reported as ignored.
const HEADERS = {
  title: ['title', 'summary', 'name'],
  type: ['type', 'issue type', 'ticket type'],
  status: ['status', 'state', 'column'],
  priority: ['priority'],
  assignee: ['assignee email', 'assignee', 'assigned to', 'owner'],
  labels: ['labels', 'label', 'tags'],
  storyPoints: ['story points', 'points', 'estimate'],
  startDate: ['start date', 'start'],
  dueDate: ['due date', 'due'],
  description: ['description', 'details', 'body'],
  epic: ['epic', 'epic link', 'epic key'],
  sprint: ['sprint'],
  milestone: ['milestone'],
};
const norm = (h) => h.trim().toLowerCase().replace(/[\s_]+/g, ' ');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// 2026-11-30, or 30/11/2026 and 30-11-2026 (day first, as written in India).
function parseDay(text) {
  let iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  if (!iso) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || !d.toISOString().startsWith(iso) ? null : iso;
}

async function lookups(project) {
  const workerIds = project.members.filter((m) => m.role !== 'viewer').map((m) => m.user._id ?? m.user);
  const [sprints, milestones, epics, workers] = await Promise.all([
    Sprint.find({ project: project._id, state: { $ne: 'closed' } }, { name: 1 }).lean(),
    Milestone.find({ project: project._id, closedAt: null }, { name: 1 }).lean(),
    Ticket.find({ project: project._id, type: 'epic', deletedAt: null }, { number: 1, title: 1 }).lean(),
    User.find({ _id: { $in: workerIds } }, { name: 1, email: 1 }).lean(),
  ]);
  return { sprints, milestones, epics, workers };
}

// Reads the CSV and checks every row without saving anything.
export async function previewImport(project, text) {
  let table;
  try {
    table = parseCsv(text);
  } catch (err) {
    throw new HttpError(400, 'csv_invalid', `This file isn't valid CSV: ${err.message}`);
  }
  if (table.length < 2) throw new HttpError(400, 'csv_empty', 'The file needs a header row and at least one ticket');
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new HttpError(400, 'csv_too_big', `Import at most ${MAX_IMPORT_ROWS} tickets at a time`);

  // Which column feeds which field. "Assignee email" wins over "Assignee" when both are there.
  const header = table[0].map(norm);
  const column = {};
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = names.map((n) => header.indexOf(n)).find((x) => x >= 0);
    if (i !== undefined) column[field] = i;
  }
  if (column.title === undefined) throw new HttpError(400, 'csv_no_title', 'The file needs a "Title" column');
  // Custom fields are read from columns with the field's name.
  const fieldColumns = (project.customFields ?? []).map((d) => ({ def: d, i: header.indexOf(norm(d.name)) })).filter((x) => x.i >= 0 && !Object.values(column).includes(x.i));
  for (const f of fieldColumns) column[`field:${f.def.key}`] = f.i;
  const usedIdx = new Set(Object.values(column));
  const used = table[0].filter((_, i) => usedIdx.has(i)).map((h) => h.trim());
  const ignored = table[0].filter((h, i) => h.trim() && !usedIdx.has(i)).map((h) => h.trim());

  const { sprints, milestones, epics, workers } = await lookups(project);
  const rows = table.slice(1).map((cells, i) => {
    const get = (field) => (column[field] === undefined ? '' : unsafe((cells[column[field]] ?? '').trim()));
    const errors = [];
    const out = { line: i + 2 };

    out.title = get('title');
    if (!out.title) errors.push('Title is empty');
    else if (out.title.length > 200) errors.push('Title is longer than 200 characters');

    const type = get('type').toLowerCase();
    out.type = type || 'task';
    if (type && !TICKET_TYPES.includes(type)) errors.push(`Type "${get('type')}" is not one of ${TICKET_TYPES.join(', ')}`);

    const priority = get('priority').toLowerCase();
    out.priority = priority || 'medium';
    if (priority && !PRIORITIES.includes(priority)) errors.push(`Priority "${get('priority')}" is not one of ${PRIORITIES.join(', ')}`);

    const status = get('status');
    if (status) {
      const s = project.statuses.find((x) => same(x.key, status) || same(x.name, status));
      if (s) out.status = s.key; else errors.push(`No column called "${status}"`);
    }

    const assignee = get('assignee');
    if (assignee) {
      const byEmail = workers.filter((u) => u.email && same(u.email, assignee));
      const matches = byEmail.length ? byEmail : workers.filter((u) => same(u.name, assignee));
      if (matches.length === 1) out.assignee = { id: String(matches[0]._id), name: matches[0].name };
      else if (matches.length > 1) errors.push(`More than one member is called "${assignee}"; use their email`);
      else errors.push(`"${assignee}" is not a member who can be assigned`);
    }

    out.labels = [...new Set(get('labels').split(/[,;]/).map((l) => l.trim().toLowerCase()).filter(Boolean))];
    if (out.labels.length > 20) errors.push('More than 20 labels');
    if (out.labels.some((l) => l.length > 30)) errors.push('A label is longer than 30 characters');

    const points = get('storyPoints');
    if (points) {
      const n = Number(points);
      if (Number.isFinite(n) && n >= 0 && n <= 100) out.storyPoints = n; else errors.push(`Story points "${points}" must be a number from 0 to 100`);
    }

    for (const [field, label] of [['startDate', 'Start'], ['dueDate', 'Due']]) {
      const v = get(field);
      if (!v) continue;
      const day = parseDay(v);
      if (day) out[field] = day; else errors.push(`${label} date "${v}" should look like 2026-11-30 or 30/11/2026`);
    }
    if (out.startDate && out.dueDate && out.startDate > out.dueDate) errors.push('Start date is after the due date');

    out.description = get('description');
    if (out.description.length > 20_000) errors.push('Description is longer than 20,000 characters');

    const epic = get('epic');
    if (epic) {
      const match = epics.filter((e) => same(`${project.key}-${e.number}`, epic) || same(e.title, epic));
      if (out.type === 'epic') errors.push('An epic can\'t be inside another epic');
      else if (match.length === 1) out.epic = `${project.key}-${match[0].number}`;
      else errors.push(match.length ? `More than one epic is called "${epic}"; use its key` : `No epic "${epic}" in this project`);
    }
    const sprint = get('sprint');
    if (sprint) {
      const match = sprints.filter((s) => same(s.name, sprint));
      if (out.type === 'epic') errors.push('Epics span sprints, so they can\'t be planned into one');
      else if (match.length === 1) out.sprint = { id: String(match[0]._id), name: match[0].name };
      else errors.push(`No planned or running sprint called "${sprint}"`);
    }
    const milestone = get('milestone');
    if (milestone) {
      const match = milestones.filter((m) => same(m.name, milestone));
      if (match.length === 1) out.milestone = { id: String(match[0]._id), name: match[0].name };
      else errors.push(`No open milestone called "${milestone}"`);
    }
    const values = {};
    for (const { def } of fieldColumns) { const v = get(`field:${def.key}`); if (v) values[def.key] = v; }
    try {
      out.fields = cleanFieldValues(project, values);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      errors.push(err.message);
    }
    out.errors = errors;
    return out;
  });
  const invalid = rows.filter((r) => r.errors.length).length;
  return { columns: { used, ignored }, rows, valid: rows.length - invalid, invalid };
}

// Creates the valid rows in file order. Without `skipInvalid`, any invalid row stops the whole
// import before anything is saved. Imported tickets send no notification each (one person
// importing 300 rows shouldn't mean 300 emails); their history says they were imported.
export async function importTickets(project, user, membership, text, { skipInvalid = false } = {}) {
  const preview = await previewImport(project, text);
  if (preview.invalid && !skipInvalid) {
    throw new HttpError(400, 'import_invalid', `${preview.invalid} row${preview.invalid === 1 ? ' has' : 's have'} problems. Fix them, or import only the valid rows.`);
  }
  const created = [];
  const failed = [];
  for (const row of preview.rows.filter((r) => !r.errors.length)) {
    try {
      const { ticket } = await createTicket(project, user, {
        title: row.title, type: row.type, priority: row.priority, description: row.description, labels: row.labels,
        ...(row.fields && Object.keys(row.fields).length && { fields: row.fields }),
        ...(row.status && { status: row.status }),
        ...(row.assignee && { assigneeId: row.assignee.id }),
        ...(row.storyPoints !== undefined && { storyPoints: row.storyPoints }),
        ...(row.startDate && { startDate: new Date(`${row.startDate}T00:00:00Z`) }),
        ...(row.dueDate && { dueDate: new Date(`${row.dueDate}T00:00:00Z`) }),
      }, { source: 'import', quiet: true });
      const fresh = () => findTicket(project, String(ticket.number));
      if (row.epic) await setEpic(project, membership, await fresh(), row.epic);
      if (row.sprint) await setTicketSprint(project, membership, await fresh(), row.sprint.id);
      if (row.milestone) await setTicketMilestone(project, membership, await fresh(), row.milestone.id);
      created.push({ line: row.line, key: ticket.key, title: ticket.title });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      failed.push({ line: row.line, title: row.title, message: err.message });
    }
  }
  return { created, failed, skipped: preview.invalid };
}
