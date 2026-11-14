import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { addDays, todayIn } from '../dates.js';
import { Project, Recurrence, Template, User } from '../models/index.js';
import { createTicket, findTicket } from './ticket.service.js';
import { addSubtask } from './relations.service.js';
import { roleAtLeast } from './project.service.js';

// Ticket templates and recurring tickets (E4B).

const MAX_TEMPLATES = 50;
const MAX_RECURRING = 50;
const templateNotFound = () => new HttpError(404, 'template_not_found', 'Template not found');
const recurrenceNotFound = () => new HttpError(404, 'recurrence_not_found', 'Recurring ticket not found');
const duplicate = (e) => (e?.code === 11000 ? new HttpError(409, 'template_exists', 'There is already a template with that name') : e);

export const shapeTemplate = (t) => ({
  id: String(t._id),
  name: t.name,
  title: t.title,
  description: t.description,
  type: t.type,
  priority: t.priority,
  labels: t.labels,
  storyPoints: t.storyPoints ?? null,
  subtasks: t.subtasks,
  updatedAt: t.updatedAt,
});

async function findTemplate(project, id) {
  const t = await Template.findOne({ _id: id, project: project._id });
  if (!t) throw templateNotFound();
  return t;
}

export async function listTemplates(project) {
  return (await Template.find({ project: project._id }).sort({ name: 1 }).lean()).map(shapeTemplate);
}

export async function createTemplate(project, user, body) {
  if (await Template.countDocuments({ project: project._id }) >= MAX_TEMPLATES) {
    throw new HttpError(400, 'too_many_templates', `At most ${MAX_TEMPLATES} templates per project`);
  }
  try {
    return shapeTemplate(await Template.create({ ...body, project: project._id, createdBy: user._id }));
  } catch (e) { throw duplicate(e); }
}

export async function updateTemplate(project, id, body) {
  const t = await findTemplate(project, id);
  Object.assign(t, body);
  try { await t.save(); } catch (e) { throw duplicate(e); }
  return shapeTemplate(t);
}

export async function deleteTemplate(project, id) {
  const t = await findTemplate(project, id);
  const uses = await Recurrence.countDocuments({ template: t._id });
  if (uses) throw new HttpError(409, 'template_in_use', `${uses} recurring ticket${uses === 1 ? ' uses' : 's use'} this template. Delete ${uses === 1 ? 'it' : 'them'} first.`);
  await Template.deleteOne({ _id: t._id });
}

// A new ticket from a template: what the person typed wins, the template fills the rest, and
// the template's sub-tasks are created under it.
export async function createFromTemplate(project, user, membership, templateId, input, options = {}) {
  const t = await findTemplate(project, templateId);
  const { ticket } = await createTicket(project, user, {
    ...input,
    title: input.title?.trim() || t.title,
    description: input.description || t.description,
    type: input.type ?? t.type,
    priority: input.priority ?? t.priority,
    labels: input.labels?.length ? input.labels : t.labels,
    ...(input.storyPoints === undefined && t.storyPoints !== null && { storyPoints: t.storyPoints }),
  }, options);
  let subtasks = 0;
  if (t.subtasks.length && ticket.type !== 'epic') {
    const parent = await findTicket(project, String(ticket.number));
    for (const title of t.subtasks) {
      await addSubtask(project, user, membership, parent, { title });
      subtasks += 1;
    }
  }
  return { ticket, subtasks };
}

// ---------------------------------------------------------------------------------------------
// Schedules. Days are YYYY-MM-DD in the team's time zone. A schedule repeats every `interval`
// days, weeks (same weekday as the first run) or months (same day of the month as the first run,
// or the month's last day when it is shorter).

const utc = (day) => new Date(`${day}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400e3);
function addMonths(day, n) {
  const d = utc(day);
  const dom = d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dom, last));
  return first.toISOString().slice(0, 10);
}
const monthsBetween = (a, b) => (utc(b).getUTCFullYear() - utc(a).getUTCFullYear()) * 12 + utc(b).getUTCMonth() - utc(a).getUTCMonth();

export function occurrence(s, k) {
  if (s.every === 'day') return addDays(s.anchor, k * s.interval);
  if (s.every === 'week') return addDays(s.anchor, k * 7 * s.interval);
  return addMonths(s.anchor, k * s.interval);
}

// Index of the first run on or after `day`.
export function indexOnOrAfter(s, day) {
  if (day <= s.anchor) return 0;
  const gap = s.every === 'month' ? monthsBetween(s.anchor, day) : daysBetween(s.anchor, day) / (s.every === 'week' ? 7 : 1);
  let k = Math.max(0, Math.floor(gap / s.interval) - 1);
  while (occurrence(s, k) < day) k += 1;
  return k;
}
export const nextOnOrAfter = (s, day) => occurrence(s, indexOnOrAfter(s, day));

const today = () => todayIn(config.timeZone);
const prettyDay = (day) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(utc(day));

// Only people who can be assigned (developers and up) can get recurring tickets.
function checkAssignee(project, assigneeId) {
  if (!assigneeId) return null;
  const m = project.members.find((x) => String(x.user) === String(assigneeId));
  if (!m) throw new HttpError(400, 'assignee_not_member', 'The assignee must be a member of this project');
  if (m.role === 'viewer') throw new HttpError(400, 'assignee_is_viewer', "Viewers can't be assigned tickets");
  return m.user;
}

async function shapeRecurrence(r) {
  const [template, assignee] = await Promise.all([
    Template.findById(r.template, { name: 1, title: 1 }).lean(),
    r.assignee ? User.findById(r.assignee, { name: 1 }).lean() : null,
  ]);
  return {
    id: String(r._id),
    template: template ? { id: String(template._id), name: template.name, title: template.title } : null,
    assignee: assignee ? { id: String(assignee._id), name: assignee.name } : null,
    schedule: { every: r.schedule.every, interval: r.schedule.interval, anchor: r.schedule.anchor },
    dueInDays: r.dueInDays ?? null,
    nextRun: r.nextRun,
    active: r.active,
    pausedReason: r.pausedReason ?? null,
    lastRun: r.lastRun?.day ? { day: r.lastRun.day, at: r.lastRun.at, number: r.lastRun.number, missed: r.lastRun.missed ?? 0 } : null,
  };
}

async function findRecurrence(project, id) {
  const r = await Recurrence.findOne({ _id: id, project: project._id });
  if (!r) throw recurrenceNotFound();
  return r;
}

export async function listRecurring(project) {
  const rows = await Recurrence.find({ project: project._id }).sort({ createdAt: 1 }).lean();
  return Promise.all(rows.map(shapeRecurrence));
}

export async function createRecurring(project, user, { templateId, assigneeId = null, every, interval = 1, firstDay, dueInDays = null }) {
  if (await Recurrence.countDocuments({ project: project._id }) >= MAX_RECURRING) {
    throw new HttpError(400, 'too_many_recurring', `At most ${MAX_RECURRING} recurring tickets per project`);
  }
  const template = await findTemplate(project, templateId);
  const assignee = checkAssignee(project, assigneeId);
  const schedule = { every, interval, anchor: firstDay };
  const r = await Recurrence.create({
    project: project._id, template: template._id, assignee, schedule, dueInDays,
    nextRun: nextOnOrAfter(schedule, today()), createdBy: user._id,
  });
  return shapeRecurrence(r);
}

// Change the schedule, assignee or due offset; pause or resume. Resuming starts from today
// (no burst of catch-up tickets) and makes the person resuming it its owner.
export async function updateRecurring(project, user, id, changes) {
  const r = await findRecurrence(project, id);
  if (changes.templateId !== undefined) r.template = (await findTemplate(project, changes.templateId))._id;
  if (changes.assigneeId !== undefined) r.assignee = checkAssignee(project, changes.assigneeId);
  if (changes.dueInDays !== undefined) r.dueInDays = changes.dueInDays;
  const scheduleChanged = ['every', 'interval', 'firstDay'].some((k) => changes[k] !== undefined);
  if (scheduleChanged) {
    r.schedule = {
      every: changes.every ?? r.schedule.every,
      interval: changes.interval ?? r.schedule.interval,
      anchor: changes.firstDay ?? r.schedule.anchor,
    };
  }
  const resuming = changes.active === true && !r.active;
  if (resuming) {
    r.active = true;
    r.pausedReason = null;
    r.createdBy = user._id;
  } else if (changes.active === false) {
    r.active = false;
  }
  if (scheduleChanged || resuming) r.nextRun = nextOnOrAfter(r.schedule, today());
  await r.save();
  return shapeRecurrence(r);
}

export async function deleteRecurring(project, id) {
  const r = await findRecurrence(project, id);
  await Recurrence.deleteOne({ _id: r._id });
}

// Makes the ticket for one run, as the person who set the schedule up.
async function makeTicket(project, r, day, actorId) {
  const membership = project.members.find((m) => String(m.user) === String(actorId));
  if (!membership || !roleAtLeast(membership.role, 'developer')) {
    throw new HttpError(409, 'owner_gone', 'The person who set this up can no longer create tickets in this project. Resume it to take it over.');
  }
  const template = await Template.findById(r.template);
  if (!template) throw new HttpError(409, 'template_gone', 'Its template was deleted');
  const user = await User.findById(actorId);
  if (!user) throw new HttpError(409, 'owner_gone', 'The person who set this up no longer has an account. Resume it to take it over.');
  // A former member stays unassigned rather than failing the run.
  const assignee = r.assignee && project.members.some((m) => String(m.user) === String(r.assignee) && m.role !== 'viewer') ? String(r.assignee) : undefined;
  const { ticket } = await createFromTemplate(project, user, membership, template._id, {
    title: `${template.title} · ${prettyDay(day)}`,
    labels: [],
    ...(assignee && { assigneeId: assignee }),
    ...(r.dueInDays !== null && r.dueInDays !== undefined && { dueDate: utc(addDays(day, r.dueInDays)) }),
  }, { source: 'recurring' });
  return ticket;
}

// "Create one now" (doesn't move the schedule).
export async function runNow(project, user, id) {
  const r = await findRecurrence(project, id);
  const day = today();
  const ticket = await makeTicket(project, r, day, user._id);
  await Recurrence.updateOne({ _id: r._id }, { $set: { lastRun: { day, at: new Date(), number: ticket.number, missed: 0 } } });
  return ticket;
}

// The scheduler: every recurring ticket whose day has come gets one ticket, for its latest due
// run. If the server was asleep across several runs, they are folded into that one ticket and
// counted in `lastRun.missed`, so nothing is lost silently and nobody gets a burst of copies.
// Claiming `nextRun` first means two server instances can never create the same run twice.
export async function runDueRecurrences(day = today(), now = new Date()) {
  const due = await Recurrence.find({ active: true, nextRun: { $lte: day } }).limit(200).lean();
  const created = [];
  for (const r of due) {
    const s = r.schedule;
    const last = indexOnOrAfter(s, addDays(day, 1)) - 1;
    const first = indexOnOrAfter(s, r.nextRun);
    const next = occurrence(s, last + 1);
    const claimed = await Recurrence.findOneAndUpdate({ _id: r._id, nextRun: r.nextRun, active: true }, { $set: { nextRun: next } });
    if (!claimed || last < first) continue;
    const runDay = occurrence(s, last);
    try {
      const project = await Project.findById(r.project);
      if (!project) { await Recurrence.deleteOne({ _id: r._id }); continue; }
      if (project.archivedAt) throw new HttpError(409, 'project_archived', 'The project is archived');
      const ticket = await makeTicket(project, r, runDay, r.createdBy);
      await Recurrence.updateOne({ _id: r._id }, { $set: { lastRun: { day: runDay, at: now, number: ticket.number, missed: last - first } } });
      created.push({ recurrence: String(r._id), project: String(project._id), number: ticket.number, day: runDay, missed: last - first });
    } catch (err) {
      // Stop and say why, instead of failing again every few minutes.
      const reason = err instanceof HttpError ? err.message : 'Something went wrong creating the ticket';
      if (!(err instanceof HttpError)) console.error('Recurring ticket failed:', err);
      await Recurrence.updateOne({ _id: r._id }, { $set: { active: false, pausedReason: reason } });
    }
  }
  return created;
}

// Checks at start-up (catching up on anything due while the server slept) and every 10 minutes.
export function startRecurringScheduler({ onCreated } = {}) {
  const tick = () => runDueRecurrences()
    .then((created) => { for (const c of created) onCreated?.(c); })
    .catch((err) => console.error('Recurring tickets check failed:', err.message));
  tick();
  setInterval(tick, 10 * 60 * 1000).unref();
}
