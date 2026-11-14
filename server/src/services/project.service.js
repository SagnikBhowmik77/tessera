import { HttpError } from '../errors.js';
import {
  Project, Ticket, TicketEvent, ProjectInvite, Comment, SavedFilter, Notification, Snooze, TicketVisit, Sprint, Milestone, Template, Recurrence, Rule, AuditEntry, ErrorOccurrence, Deployment, RepoInsight, PokerRound, Retro, Incident, Tracker, RoadmapVote, PortalLogo, TestRun, WebhookDelivery,
} from '../models/index.js';
import { forgetMember } from './follow.service.js';
import { purgeAttachments } from './attachment.service.js';
import { purgeSourceMaps } from './sourcemap.service.js';
import { fromTemplate } from './setup.service.js';

// admin > manager > developer > viewer.
const RANK = { viewer: 1, developer: 2, manager: 3, admin: 4 };
export const roleAtLeast = (role, min) => RANK[role] >= RANK[min];

const MEMBER_FIELDS = 'name email';

// What the API sends for a project: the document plus the caller's own role.
export async function serializeProject(project, userId) {
  await project.populate('members.user', MEMBER_FIELDS);
  const json = project.toJSON();
  const me = project.members.find((m) => String(m.user?._id ?? m.user) === String(userId));
  json.myRole = me?.role ?? null;
  // Secrets stay on the server: the GitHub secret is only ever shown by its own endpoint,
  // and the portal link only to managers and admins.
  json.github = { connected: Boolean(project.github?.secret), token: Boolean(project.github?.token), issueSync: Boolean(project.github?.issues?.sync) };
  // Ingest keys are listed (without their hashes) in Settings, not on every project read.
  delete json.ingestKeys;
  delete json.statusPage;
  json.portal = { enabled: Boolean(project.portal?.enabled) };
  // E11 / E13 settings carry tokens and (sealed) secrets: each has its own manager-only endpoint.
  delete json.alerts;
  delete json.webhooks;
  delete json.shareLinks;
  json.gitlab = { connected: Boolean(project.gitlab?.secret) };
  json.roadmap = { enabled: Boolean(project.roadmap?.enabled) };
  return json;
}

export async function listProjects(user, { archived }) {
  const filter = { 'members.user': user._id };
  if (!archived) filter.archivedAt = null;
  const projects = await Project.find(filter).sort({ updatedAt: -1 });
  // How far along each project is: tickets on the board (not in the bin), and how many are in a
  // done column. One query for all of them.
  const counts = await Ticket.aggregate([
    { $match: { project: { $in: projects.map((p) => p._id) }, deletedAt: null } },
    { $group: { _id: { project: '$project', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const progressOf = (p) => {
    const done = new Set(p.statuses.filter((s) => s.category === 'done').map((s) => s.key));
    return counts.filter((c) => String(c._id.project) === String(p._id)).reduce((acc, c) => {
      acc.total += c.n;
      if (done.has(c._id.status)) acc.done += c.n;
      return acc;
    }, { total: 0, done: 0 });
  };
  return Promise.all(projects.map(async (p) => ({ ...(await serializeProject(p, user._id)), progress: progressOf(p) })));
}

const keyTaken = () => new HttpError(409, 'key_taken', 'You already have a project with this key');

export async function createProject(user, { name, key, description, template }) {
  try {
    return await Project.create({
      name, key, description, owner: user._id, members: [{ user: user._id, role: 'admin' }], ...fromTemplate(template),
    });
  } catch (err) {
    if (err.code === 11000) throw keyTaken();
    throw err;
  }
}

// Managers may edit the name and description; changing the key (which renames every
// ticket, TES-12 -> NEW-12) is for admins only.
export async function updateProject(project, membership, changes) {
  if (changes.key !== undefined && changes.key !== project.key && membership.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'Only admins can change the project key');
  }
  for (const [field, value] of Object.entries(changes)) if (value !== undefined) project[field] = value;
  try {
    await project.save();
  } catch (err) {
    if (err.code === 11000) throw keyTaken();
    throw err;
  }
  return project;
}

export async function setArchived(project, archived) {
  project.archivedAt = archived ? (project.archivedAt ?? new Date()) : null;
  await project.save();
  return project;
}

export async function deleteProject(project, { confirmKey }) {
  if (confirmKey !== project.key) {
    throw new HttpError(400, 'confirm_mismatch', `Type the project key (${project.key}) to confirm`);
  }
  await purgeProjects([project._id]);
}

// Removes projects and everything in them: files, comments, history, tickets, invites.
export async function purgeProjects(projectIds) {
  if (!projectIds.length) return;
  const inThem = { project: { $in: projectIds } };
  await purgeAttachments(projectIds);
  await purgeSourceMaps(projectIds);
  await Comment.deleteMany(inThem);
  await TicketEvent.deleteMany(inThem);
  await Ticket.deleteMany(inThem);
  await ProjectInvite.deleteMany(inThem);
  await SavedFilter.deleteMany(inThem);
  await Notification.deleteMany(inThem);
  await Snooze.deleteMany(inThem);
  await TicketVisit.deleteMany(inThem);
  await Sprint.deleteMany(inThem);
  await Milestone.deleteMany(inThem);
  await Template.deleteMany(inThem);
  await Recurrence.deleteMany(inThem);
  await Rule.deleteMany(inThem);
  await AuditEntry.deleteMany(inThem);
  await ErrorOccurrence.deleteMany(inThem);
  await Deployment.deleteMany(inThem);
  await RepoInsight.deleteMany(inThem);
  await PokerRound.deleteMany(inThem);
  await Retro.deleteMany(inThem);
  await Incident.deleteMany(inThem);
  await Tracker.deleteMany(inThem);
  await RoadmapVote.deleteMany(inThem);
  await PortalLogo.deleteMany(inThem);
  await TestRun.deleteMany(inThem);
  await WebhookDelivery.deleteMany(inThem);
  await Project.deleteMany({ _id: { $in: projectIds } });
}

// Tickets assigned to someone leaving become unassigned, and the history records it.
export async function unassignMember(projectIds, userId, actorId = null) {
  const assigned = await Ticket.find({ project: { $in: projectIds }, assignee: userId }, { _id: 1, project: 1 }).lean();
  if (!assigned.length) return 0;
  const at = new Date();
  await TicketEvent.insertMany(assigned.map((t) => ({
    project: t.project, ticket: t._id, actor: actorId, type: 'assigned', from: userId, to: null, at,
  })));
  await Ticket.updateMany({ _id: { $in: assigned.map((t) => t._id) } }, { $set: { assignee: null } });
  return assigned.length;
}

// Managers handle developers and viewers; admins handle everyone.
function assertCanManage(actor, target, newRole) {
  if (actor.role === 'admin') return;
  const manageable = ['developer', 'viewer'];
  if (actor.role === 'manager' && manageable.includes(target.role) && (!newRole || manageable.includes(newRole))) return;
  throw new HttpError(403, 'forbidden', 'Managers can only manage developers and viewers');
}

const lastAdmin = () =>
  new HttpError(409, 'last_admin', 'A project needs at least one admin. Make someone else an admin first.');

function findMember(project, userId) {
  const member = project.members.find((m) => String(m.user) === String(userId));
  if (!member) throw new HttpError(404, 'member_not_found', 'That person is not a member of this project');
  return member;
}

export async function changeRole(project, actor, userId, role) {
  const target = findMember(project, userId);
  if (String(target.user) !== String(actor.user)) assertCanManage(actor, target, role);
  else if (actor.role !== 'admin' && !roleAtLeast(actor.role, role)) {
    throw new HttpError(403, 'forbidden', 'You cannot raise your own role');
  }
  if (target.role === role) return project;
  // Checked inside the update itself, so two admins demoting each other at the same moment
  // can never leave the project with none.
  const res = await Project.updateOne(
    { _id: project._id, members: { $elemMatch: { role: 'admin', user: { $ne: target.user } } } },
    { $set: { 'members.$[m].role': role } },
    { arrayFilters: [{ 'm.user': target.user }] },
  );
  if (res.matchedCount === 0) throw lastAdmin();
  return Project.findById(project._id);
}

// Removing someone else, or leaving yourself (any role may leave).
export async function removeMember(project, actor, userId) {
  const target = findMember(project, userId);
  const leaving = String(target.user) === String(actor.user);
  if (!leaving) assertCanManage(actor, target);
  const res = await Project.updateOne(
    { _id: project._id, members: { $elemMatch: { role: 'admin', user: { $ne: target.user } } } },
    { $pull: { members: { user: target.user } } },
  );
  if (res.matchedCount === 0) throw lastAdmin();
  const unassigned = await unassignMember([project._id], target.user, leaving ? null : actor.user);
  await forgetMember([project._id], target.user);
  return { left: leaving, unassignedTickets: unassigned };
}
