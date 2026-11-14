import { generateNKeysBetween } from 'fractional-indexing';
import { HttpError } from '../errors.js';
import { Attachment, Comment, Milestone, Project, Sprint, Ticket, TicketEvent, User } from '../models/index.js';

// Project backup and export (E14): one JSON file with the project's settings, people (by email),
// sprints, milestones, tickets and comments, which can be imported as a new project. Left out on
// purpose: every secret (portal, GitHub, GitLab, crash keys, webhooks, share links), outside
// reporters' contact details and replies to them, and the attachments' bytes (listed by name and size).

export const BACKUP_FORMAT = 'tessera-backup';
export const BACKUP_VERSION = 1;
const id = (x) => String(x?._id ?? x);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export async function exportProject(project) {
  await project.populate('members.user', 'name email');
  const [tickets, comments, sprints, milestones, files] = await Promise.all([
    Ticket.find({ project: project._id, deletedAt: null }).populate('assignee reporter', 'email').sort({ number: 1 }).lean(),
    Comment.find({ project: project._id, deletedAt: null }).populate('author', 'name email').sort({ createdAt: 1 }).lean(),
    Sprint.find({ project: project._id }).lean(),
    Milestone.find({ project: project._id }).lean(),
    Attachment.find({ project: project._id }, { ticket: 1, name: 1, size: 1, contentType: 1 }).lean(),
  ]);
  const numberOf = new Map(tickets.map((t) => [id(t), t.number]));
  const sprintName = new Map(sprints.map((s) => [id(s), s.name]));
  const milestoneName = new Map(milestones.map((m) => [id(m), m.name]));
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    project: {
      name: project.name, key: project.key, description: project.description,
      statuses: project.statuses.map(({ key, name, category, wipLimit }) => ({ key, name, category, wipLimit: wipLimit ?? null })),
      customFields: project.toJSON().customFields ?? [], suggestedLabels: project.suggestedLabels ?? [],
    },
    members: project.members.filter((m) => m.user).map((m) => ({ email: m.user.email, name: m.user.name, role: m.role })),
    sprints: sprints.map((s) => ({ name: s.name, goal: s.goal ?? '', state: s.state, startDate: day(s.startDate), endDate: day(s.endDate) })),
    milestones: milestones.map((m) => ({ name: m.name, description: m.description ?? '', dueDate: day(m.dueDate) })),
    tickets: tickets.map((t) => ({
      number: t.number, title: t.title, description: t.description ?? '', type: t.type, priority: t.priority, status: t.status, labels: t.labels ?? [],
      storyPoints: t.storyPoints ?? null, dueDate: day(t.dueDate), startDate: day(t.startDate), fields: t.fields ?? {},
      assignee: t.assignee?.email ?? null, reporter: t.reporter?.email ?? null, triage: Boolean(t.triage),
      epic: t.epic ? numberOf.get(id(t.epic)) ?? null : null, parent: t.parent ? numberOf.get(id(t.parent)) ?? null : null,
      sprint: t.sprint ? sprintName.get(id(t.sprint)) ?? null : null, milestone: t.milestone ? milestoneName.get(id(t.milestone)) ?? null : null,
      createdAt: t.createdAt, resolvedAt: t.resolvedAt ?? null,
    })),
    comments: comments.filter((c) => numberOf.has(id(c.ticket)) && c.visibility !== 'reporter').map((c) => ({
      ticket: numberOf.get(id(c.ticket)), author: c.author?.email ?? null, authorName: c.author?.name ?? c.external?.login ?? null, body: c.body, createdAt: c.createdAt,
    })),
    attachments: files.filter((f) => numberOf.has(id(f.ticket))).map((f) => ({ ticket: numberOf.get(id(f.ticket)), name: f.name, size: f.size, contentType: f.contentType })),
  };
}

const KEY = /^[A-Z][A-Z0-9]{1,5}$/;

// Imports a backup as a NEW project. People are matched by email to existing accounts and keep
// their role; anyone without an account is left out (their tickets become unassigned).
export async function importProject(user, backup, { key, name }) {
  if (backup?.format !== BACKUP_FORMAT) throw new HttpError(422, 'not_a_backup', 'This is not a Tessera backup file');
  if (backup.version !== BACKUP_VERSION) throw new HttpError(422, 'unsupported_version', `This backup is version ${backup.version}; this Tessera reads version ${BACKUP_VERSION}`);
  const projectKey = String(key || backup.project?.key || '').toUpperCase();
  if (!KEY.test(projectKey)) throw new HttpError(400, 'bad_key', 'Key is 2 to 6 letters or digits and starts with a letter');
  const tickets = Array.isArray(backup.tickets) ? backup.tickets : [];
  if (tickets.length > 20_000) throw new HttpError(413, 'too_big', 'At most 20,000 tickets per import');
  if (new Set(tickets.map((t) => t.number)).size !== tickets.length || tickets.some((t) => !Number.isInteger(t.number) || t.number < 1)) throw new HttpError(422, 'bad_backup', 'Ticket numbers in the backup are missing or repeated');
  const statuses = Array.isArray(backup.project?.statuses) && backup.project.statuses.length >= 2 ? backup.project.statuses : undefined;

  const emails = [...new Set([...(backup.members ?? []).map((m) => m.email), ...tickets.flatMap((t) => [t.assignee, t.reporter]), ...(backup.comments ?? []).map((c) => c.author)].filter(Boolean).map((e) => String(e).toLowerCase()))];
  const users = new Map((await User.find({ email: { $in: emails } }, { email: 1 }).lean()).map((u) => [u.email, u._id]));
  const members = [{ user: user._id, role: 'admin' }];
  for (const m of backup.members ?? []) {
    const uid = users.get(String(m.email).toLowerCase());
    if (uid && id(uid) !== id(user._id) && ['admin', 'manager', 'developer', 'viewer'].includes(m.role)) members.push({ user: uid, role: m.role });
  }
  const memberIds = new Set(members.map((m) => id(m.user)));
  const person = (email) => { const uid = email ? users.get(String(email).toLowerCase()) : null; return uid && memberIds.has(id(uid)) ? uid : null; };

  let project;
  try {
    project = await Project.create({
      name: String(name || backup.project?.name || 'Imported project').slice(0, 80), key: projectKey, description: String(backup.project?.description ?? '').slice(0, 2000),
      owner: user._id, members, ...(statuses && { statuses }),
      ...(Array.isArray(backup.project?.customFields) && { customFields: backup.project.customFields }),
      ...(Array.isArray(backup.project?.suggestedLabels) && { suggestedLabels: backup.project.suggestedLabels }),
    });
  } catch (err) {
    if (err.code === 11000) throw new HttpError(409, 'key_taken', 'You already have a project with this key. Pick another key for the import.');
    if (err.name === 'ValidationError') throw new HttpError(422, 'bad_backup', `The backup's project settings are not valid: ${Object.values(err.errors)[0]?.message}`);
    throw err;
  }
  try {
    const sprintId = new Map();
    for (const s of backup.sprints ?? []) sprintId.set(s.name, (await Sprint.create({ project: project._id, name: s.name, goal: s.goal ?? '', state: s.state ?? 'planned', startDate: s.startDate, endDate: s.endDate }))._id);
    const milestoneId = new Map();
    for (const m of backup.milestones ?? []) milestoneId.set(m.name, (await Milestone.create({ project: project._id, name: m.name, description: m.description ?? '', dueDate: m.dueDate }))._id);
    const known = new Set(project.statuses.map((s) => s.key));
    const first = (project.statuses.find((s) => s.category === 'todo') ?? project.statuses[0]).key;
    const ranks = tickets.length ? generateNKeysBetween(null, null, tickets.length) : [];
    const docs = tickets.map((t, i) => ({
      project: project._id, number: t.number, title: String(t.title ?? '(untitled)').slice(0, 200), description: String(t.description ?? ''), type: t.type, priority: t.priority,
      status: known.has(t.status) ? t.status : first, labels: t.labels ?? [], storyPoints: t.storyPoints ?? null, dueDate: t.dueDate, startDate: t.startDate, fields: t.fields ?? {},
      assignee: person(t.assignee), reporter: person(t.reporter), triage: Boolean(t.triage), rank: ranks[i],
      sprint: t.sprint ? sprintId.get(t.sprint) ?? null : null, milestone: t.milestone ? milestoneId.get(t.milestone) ?? null : null,
      createdAt: t.createdAt ?? new Date(), resolvedAt: t.resolvedAt ?? null, source: 'import',
    }));
    const inserted = docs.length ? await Ticket.insertMany(docs, { ordered: true }) : [];
    const byNumber = new Map(inserted.map((t) => [t.number, t._id]));
    for (const t of tickets) {
      const set = {};
      if (t.epic && byNumber.has(t.epic)) set.epic = byNumber.get(t.epic);
      if (t.parent && byNumber.has(t.parent)) set.parent = byNumber.get(t.parent);
      if (Object.keys(set).length) await Ticket.updateOne({ _id: byNumber.get(t.number) }, { $set: set });
    }
    project.ticketCounter = Math.max(0, ...inserted.map((t) => t.number));
    await project.save();
    if (inserted.length) await TicketEvent.insertMany(inserted.map((t) => ({ project: project._id, ticket: t._id, actor: user._id, source: 'import', type: 'created', at: t.createdAt })));
    const comments = (backup.comments ?? []).filter((c) => byNumber.has(c.ticket) && c.body).map((c) => {
      const author = person(c.author);
      return { project: project._id, ticket: byNumber.get(c.ticket), author, body: String(c.body).slice(0, 10_000), createdAt: c.createdAt ?? new Date(), ...(!author && { external: { source: 'import', login: c.authorName ?? 'Someone', url: null } }) };
    });
    if (comments.length) await Comment.insertMany(comments);
    return {
      project: { id: id(project), key: project.key, name: project.name },
      imported: { tickets: inserted.length, comments: comments.length, sprints: sprintId.size, milestones: milestoneId.size, members: members.length },
      leftOut: { people: (backup.members ?? []).filter((m) => !users.has(String(m.email).toLowerCase())).map((m) => m.email), attachments: (backup.attachments ?? []).length },
    };
  } catch (err) {
    // Half an import is worse than none.
    await Promise.all([Ticket.deleteMany({ project: project._id }), Comment.deleteMany({ project: project._id }), Sprint.deleteMany({ project: project._id }), Milestone.deleteMany({ project: project._id }), TicketEvent.deleteMany({ project: project._id })]);
    await project.deleteOne();
    if (err instanceof HttpError) throw err;
    if (err.name === 'ValidationError') throw new HttpError(422, 'bad_backup', `The backup has something that is not valid: ${Object.values(err.errors)[0]?.message}`);
    throw err;
  }
}
