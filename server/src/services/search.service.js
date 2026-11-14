import mongoose from 'mongoose';
import { config } from '../config.js';
import { addDays, dayToDate, todayIn } from '../dates.js';
import { Project, Sprint, Ticket, PRIORITIES } from '../models/index.js';
import { serializeTicket } from './ticket.service.js';
import { snoozedTicketIds } from './follow.service.js';
import { slaFilter } from './sla.service.js';
import { compileSearch, hasFilters } from './searchql.service.js';

const PEOPLE = [
  { path: 'assignee', select: 'name email' },
  { path: 'reporter', select: 'name email' },
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const doneKeys = (project) => project.statuses.filter((s) => s.category === 'done').map((s) => s.key);

// "me" means whoever is looking, so a shared "My open bugs" view works for everyone.
const people = (list, user) => list.map((v) => (v === 'me' ? user._id : v === 'none' ? null : new mongoose.Types.ObjectId(v)));

// Turns the validated filters into a MongoDB match. Every condition is ANDed;
// values inside one filter are ORed (status=todo,in_progress means either).
export function buildMatch(project, user, f) {
  const and = [
    { project: project._id },
    { deletedAt: f.deleted ? { $ne: null } : null },
  ];
  // Portal reports waiting in triage are kept off the board and lists until accepted.
  // The bin shows everything deleted, including rejected reports, so they can be restored.
  if (!f.deleted || f.triage) and.push({ triage: f.triage ? true : { $ne: true } });
  if (f.status) and.push({ status: { $in: f.status } });
  if (f.priority) and.push({ priority: { $in: f.priority } });
  if (f.type) and.push({ type: { $in: f.type } });
  if (f.assignee) and.push({ assignee: { $in: people(f.assignee, user) } });
  if (f.reporter) and.push({ reporter: { $in: people(f.reporter, user) } });
  if (f.label) and.push({ labels: { $in: f.label } });
  const done = doneKeys(project);
  if (f.open === true) and.push({ status: { $nin: done } });
  if (f.open === false) and.push({ status: { $in: done } });

  if (f.due) {
    const today = todayIn(config.timeZone);
    const start = dayToDate(today);
    if (f.due === 'overdue') and.push({ dueDate: { $lt: start } }, { status: { $nin: done } });
    if (f.due === 'today') and.push({ dueDate: start });
    if (f.due === 'week') and.push({ dueDate: { $gte: start, $lt: dayToDate(addDays(today, 7)) } });
    if (f.due === 'none') and.push({ dueDate: null });
    if (f.due === 'any') and.push({ dueDate: { $ne: null } });
  }
  if (f.sprint) and.push({ sprint: f.sprint === 'none' ? null : new mongoose.Types.ObjectId(f.sprint) });
  if (f.milestone) and.push({ milestone: f.milestone === 'none' ? null : new mongoose.Types.ObjectId(f.milestone) });
  if (f.scheduled === true) and.push({ $or: [{ dueDate: { $ne: null } }, { startDate: { $ne: null } }] });
  if (f.scheduled === false) and.push({ dueDate: null, startDate: null });
  if (f.sla) and.push(slaFilter(project, f.sla));
  if (f.dueFrom) and.push({ dueDate: { $gte: dayToDate(f.dueFrom) } });
  if (f.dueTo) and.push({ dueDate: { $lte: dayToDate(f.dueTo) } });
  return { $and: and };
}

const SORTS = {
  // The board: columns in the project's own order, cards in their dragged order.
  rank: { statusOrder: 1, rank: 1, number: 1 },
  newest: { createdAt: -1, number: -1 },
  oldest: { createdAt: 1, number: 1 },
  updated: { updatedAt: -1, number: -1 },
  // Most urgent first, then the oldest of those (waiting longest).
  priority: { priorityOrder: -1, createdAt: 1 },
  // Soonest due first; tickets without a due date last.
  due: { dueSort: 1, priorityOrder: -1, number: 1 },
  number: { number: 1 },
  relevance: { score: -1, number: -1 },
};

async function run(project, match, { sort, page, limit, text }) {
  const statusKeys = project.statuses.map((s) => s.key);
  const sortBy = SORTS[sort === 'relevance' && !text ? 'newest' : sort];
  const pipeline = [
    { $match: match },
    {
      $addFields: {
        statusOrder: { $indexOfArray: [statusKeys, '$status'] },
        priorityOrder: { $indexOfArray: [PRIORITIES, '$priority'] },
        dueSort: { $ifNull: ['$dueDate', new Date('9999-12-31T00:00:00Z')] },
        ...(text && { score: { $meta: 'textScore' } }),
      },
    },
    { $sort: sortBy },
    { $unset: ['statusOrder', 'priorityOrder', 'dueSort', ...(text ? ['score'] : [])] },
    { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ];
  const [{ items, total }] = await Ticket.aggregate(pipeline);
  const docs = items.map((d) => Ticket.hydrate(d));
  await Ticket.populate(docs, PEOPLE);
  const planning = await planningInfo(project, docs);
  return { tickets: docs.map((d) => ({ ...serializeTicket(d, project), ...planning(d) })), total: total[0]?.n ?? 0 };
}

// What a card shows about planning (E3): "2/5" sub-tasks done, the epic it belongs to, and for
// an epic its own progress. Two small queries for the whole page, not one per card.
async function planningInfo(project, docs) {
  if (!docs.length) return () => ({});
  const done = doneKeys(project);
  const ids = docs.map((d) => d._id);
  const isDone = { $cond: [{ $in: ['$status', done] }, 1, 0] };
  const [children, epics] = await Promise.all([
    Ticket.aggregate([
      { $match: { deletedAt: null, $or: [{ parent: { $in: ids } }, { epic: { $in: ids } }] } },
      { $project: { group: { $ifNull: ['$parent', '$epic'] }, kind: { $cond: [{ $ne: [{ $ifNull: ['$parent', null] }, null] }, 'sub', 'epic'] }, d: isDone } },
      { $group: { _id: { group: '$group', kind: '$kind' }, total: { $sum: 1 }, done: { $sum: '$d' } } },
    ]),
    Ticket.find({ _id: { $in: docs.map((d) => d.epic).filter(Boolean) } }, { number: 1, title: 1 }).lean(),
  ]);
  const counts = new Map(children.map((c) => [`${c._id.kind}:${c._id.group}`, { total: c.total, done: c.done }]));
  const epicById = new Map(epics.map((e) => [String(e._id), { key: `${project.key}-${e.number}`, title: e.title }]));
  return (d) => ({
    subtaskProgress: counts.get(`sub:${d._id}`) ?? null,
    epicProgress: d.type === 'epic' ? counts.get(`epic:${d._id}`) ?? { total: 0, done: 0 } : null,
    epicInfo: d.epic ? epicById.get(String(d.epic)) ?? null : null,
  });
}

// sprint=active means whichever sprint is running now (none running: nothing matches).
async function resolveSprint(project, f) {
  if (f.sprint !== 'active') return f;
  const running = await Sprint.findOne({ project: project._id, state: 'active' }, { _id: 1 }).lean();
  return { ...f, sprint: String(running?._id ?? new mongoose.Types.ObjectId()) };
}

// The ticket list, the board and search all go through here.
export async function searchTickets(project, user, filters) {
  const f = await resolveSprint(project, filters);
  let base = buildMatch(project, user, f);
  const paging = { sort: f.sort, page: f.page, limit: f.limit };
  let q = f.q?.trim();
  // "type:bug assignee:me due:<7d checkout": the filters narrow the list, the rest is searched as words.
  let lang = null;
  if (q && hasFilters(q)) {
    lang = await compileSearch(project, user, q);
    if (lang.conds.length) base = { $and: [base, ...lang.conds] };
    q = lang.text;
  }
  const meta = (mode) => ({ q: f.q.trim(), mode, ...(lang && { understood: lang.understood, problems: lang.problems }) });
  if (!q) return finish(await run(project, base, paging), f, lang ? meta('filters') : undefined);

  // "TES-12" or "12" jumps straight to that ticket (if there is one; "2026" may also be a word).
  const ref = /^(?:([A-Za-z][A-Za-z0-9]{1,5})-)?(\d{1,7})$/.exec(q);
  if (ref && (!ref[1] || ref[1].toUpperCase() === project.key)) {
    const byKey = await run(project, { $and: [base, { number: Number(ref[2]) }] }, paging);
    if (byKey.total) return finish(byKey, f, meta('key'));
  }
  // Whole-word search, ranked, and it understands plurals ("crash" finds "crashes").
  const words = await run(project, { $text: { $search: q }, ...base }, { ...paging, text: true });
  if (words.total) return finish(words, f, meta('words'));
  // Nothing? Then match the text anywhere, so a half-typed "checko" still finds "checkout".
  const rx = new RegExp(escapeRegex(q), 'i');
  const partial = await run(project, { $and: [base, { $or: [{ title: rx }, { description: rx }, { labels: rx }] }] }, paging);
  return finish(partial, f, meta('partial'));
}

const finish = (result, f, search) => ({
  ...result,
  page: f.page,
  pages: Math.max(1, Math.ceil(result.total / f.limit)),
  ...(search && { search }),
});

// "My work": open tickets assigned to me across every active project I'm in.
// Snoozed tickets are left out until they come back; `snoozed: true` lists only those.
export async function assignedToMe(user, { limit, snoozed = false }) {
  const projects = await Project.find({ 'members.user': user._id, archivedAt: null });
  if (!projects.length) return { tickets: [], total: 0, snoozedCount: 0 };
  const asleep = await snoozedTicketIds(user._id);
  const asleepIds = [...asleep.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const byId = new Map(projects.map((p) => [String(p._id), p]));
  const match = {
    assignee: user._id,
    deletedAt: null,
    $or: projects.map((p) => ({ project: p._id, status: { $nin: doneKeys(p) } })),
  };
  const snoozedCount = asleepIds.length ? await Ticket.countDocuments({ ...match, _id: { $in: asleepIds } }) : 0;
  match._id = snoozed ? { $in: asleepIds } : { $nin: asleepIds };
  const total = await Ticket.countDocuments(match);
  const rows = await Ticket.aggregate([
    { $match: match },
    { $addFields: { priorityOrder: { $indexOfArray: [PRIORITIES, '$priority'] }, dueSort: { $ifNull: ['$dueDate', new Date('9999-12-31T00:00:00Z')] } } },
    { $sort: { dueSort: 1, priorityOrder: -1, createdAt: 1 } },
    { $limit: limit },
    { $unset: ['priorityOrder', 'dueSort'] },
  ]);
  const docs = rows.map((d) => Ticket.hydrate(d));
  await Ticket.populate(docs, PEOPLE);
  const tickets = docs.map((d) => {
    const project = byId.get(String(d.project));
    const status = project.statuses.find((s) => s.key === d.status);
    // The category (to do, in progress, done) lets My work group tickets the same way across projects.
    return { ...serializeTicket(d, project), projectName: project.name, statusName: status?.name ?? d.status, statusCategory: status?.category ?? null, snoozedUntil: asleep.get(String(d._id)) ?? null };
  });
  return { tickets, total, snoozedCount };
}

// Labels in use, most used first, for the filter picker.
export async function projectLabels(project) {
  const rows = await Ticket.aggregate([
    { $match: { project: project._id, deletedAt: null } },
    { $unwind: '$labels' },
    { $group: { _id: '$labels', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 200 },
  ]);
  const used = rows.map((r) => ({ label: r._id, count: r.count }));
  const inUse = new Set(used.map((l) => l.label));
  return [...used, ...(project.suggestedLabels ?? []).filter((l) => !inUse.has(l)).map((label) => ({ label, count: 0 }))];
}
