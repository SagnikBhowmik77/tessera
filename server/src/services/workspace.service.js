import { HttpError } from '../errors.js';
import { Project, User, Workspace } from '../models/index.js';
import { roleAtLeast } from './project.service.js';

// Workspaces (E14): a team or company groups its projects and people. Project roles still decide
// what someone can do in a project; the workspace makes it quick to find and add the team.

const id = (x) => String(x?._id ?? x);
const RANK = { member: 1, admin: 2, owner: 3 };
const roleIn = (ws, userId) => ws.members.find((m) => id(m.user) === id(userId))?.role ?? null;

async function load(wsId, user, min = 'member') {
  const ws = await Workspace.findById(wsId);
  const role = ws && roleIn(ws, user._id);
  if (!role) throw new HttpError(404, 'workspace_not_found', 'Workspace not found');
  if (RANK[role] < RANK[min]) throw new HttpError(403, 'forbidden', min === 'owner' ? 'Only the workspace owner can do this' : 'Only workspace admins can do this');
  return { ws, role };
}

async function json(ws, user) {
  await ws.populate('members.user', 'name email');
  const projects = await Project.find({ workspace: ws._id, archivedAt: null }, { name: 1, key: 1, members: 1 }).sort({ name: 1 }).lean();
  return {
    id: id(ws), name: ws.name, myRole: roleIn(ws, user._id), createdAt: ws.createdAt,
    members: ws.members.filter((m) => m.user).map((m) => ({ id: id(m.user), name: m.user.name, email: m.user.email, role: m.role })),
    // Every project in the workspace is listed by name; only your own open.
    projects: projects.map((p) => {
      const mine = p.members.find((m) => id(m.user) === id(user._id));
      return { id: id(p), name: p.name, key: p.key, myRole: mine?.role ?? null, members: p.members.length };
    }),
  };
}

export async function listWorkspaces(user) {
  const rows = await Workspace.find({ 'members.user': user._id }).sort({ name: 1 }).lean();
  const counts = new Map((await Project.aggregate([{ $match: { workspace: { $in: rows.map((w) => w._id) }, archivedAt: null } }, { $group: { _id: '$workspace', n: { $sum: 1 } } }])).map((r) => [id(r._id), r.n]));
  return rows.map((w) => ({ id: id(w), name: w.name, myRole: roleIn(w, user._id), members: w.members.length, projects: counts.get(id(w)) ?? 0 }));
}

export async function createWorkspace(user, { name }) {
  if (await Workspace.countDocuments({ createdBy: user._id }) >= 10) throw new HttpError(409, 'too_many', 'You can create at most 10 workspaces');
  const ws = await Workspace.create({ name, createdBy: user._id, members: [{ user: user._id, role: 'owner' }] });
  return json(ws, user);
}

export async function showWorkspace(user, wsId) {
  return json((await load(wsId, user)).ws, user);
}

export async function renameWorkspace(user, wsId, { name }) {
  const { ws } = await load(wsId, user, 'admin');
  ws.name = name;
  await ws.save();
  return json(ws, user);
}

// Deleting a workspace never deletes projects: they just stop being grouped.
export async function deleteWorkspace(user, wsId) {
  const { ws } = await load(wsId, user, 'owner');
  await Project.updateMany({ workspace: ws._id }, { $set: { workspace: null } });
  await ws.deleteOne();
}

export async function addMember(user, wsId, { email, role }) {
  const { ws, role: mine } = await load(wsId, user, 'admin');
  if (role === 'owner' && mine !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can add another owner');
  const person = await User.findOne({ email: email.toLowerCase() }, { _id: 1 });
  if (!person) throw new HttpError(404, 'no_account', 'Nobody with that email has a Tessera account yet. Invite them to a project first.');
  if (roleIn(ws, person._id)) throw new HttpError(409, 'already_member', 'They are already in this workspace');
  if (ws.members.length >= 200) throw new HttpError(409, 'too_many', 'A workspace has at most 200 people');
  ws.members.push({ user: person._id, role });
  await ws.save();
  return json(ws, user);
}

const owners = (ws) => ws.members.filter((m) => m.role === 'owner').length;

export async function changeMemberRole(user, wsId, memberId, role) {
  const { ws, role: mine } = await load(wsId, user, 'admin');
  const m = ws.members.find((x) => id(x.user) === memberId);
  if (!m) throw new HttpError(404, 'member_not_found', 'They are not in this workspace');
  if ((role === 'owner' || m.role === 'owner') && mine !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can change owners');
  if (m.role === 'owner' && role !== 'owner' && owners(ws) === 1) throw new HttpError(409, 'last_owner', 'A workspace needs at least one owner');
  m.role = role;
  await ws.save();
  return json(ws, user);
}

// Admins remove people; anyone can leave.
export async function removeMember(user, wsId, memberId) {
  const self = memberId === id(user._id);
  const { ws, role: mine } = await load(wsId, user, self ? 'member' : 'admin');
  const m = ws.members.find((x) => id(x.user) === memberId);
  if (!m) throw new HttpError(404, 'member_not_found', 'They are not in this workspace');
  if (m.role === 'owner' && !self && mine !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can remove an owner');
  if (m.role === 'owner' && owners(ws) === 1) throw new HttpError(409, 'last_owner', 'A workspace needs at least one owner. Make someone else an owner first.');
  ws.members = ws.members.filter((x) => x !== m);
  await ws.save();
  return self ? null : json(ws, user);
}

// A project joins a workspace when its admin is also an admin of that workspace.
export async function setProjectWorkspace(user, project, membership, wsId) {
  if (membership.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only project admins can move a project');
  if (wsId) await load(wsId, user, 'admin');
  project.workspace = wsId ?? null;
  await project.save();
  return { workspace: wsId ?? null };
}

// Adds the workspace's people who are not in the project yet, with one role.
export async function addWorkspaceMembers(project, membership, role) {
  if (!roleAtLeast(membership.role, 'manager')) throw new HttpError(403, 'forbidden', 'Only managers can add people');
  if (role === 'admin' && membership.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can add admins');
  if (!project.workspace) throw new HttpError(409, 'no_workspace', 'This project is not in a workspace');
  const ws = await Workspace.findById(project.workspace).lean();
  if (!ws) throw new HttpError(409, 'no_workspace', 'This project is not in a workspace');
  const inProject = new Set(project.members.map((m) => id(m.user)));
  const added = ws.members.filter((m) => !inProject.has(id(m.user)));
  for (const m of added) project.members.push({ user: m.user, role });
  await project.save();
  return { added: added.length };
}

// When an account is deleted. A workspace left without an owner gets its longest-standing admin
// (or member) as owner; an empty one is deleted (its projects just stop being grouped).
export async function leaveAllWorkspaces(userId) {
  for (const ws of await Workspace.find({ 'members.user': userId })) {
    ws.members = ws.members.filter((m) => id(m.user) !== id(userId));
    if (!ws.members.length) {
      await Project.updateMany({ workspace: ws._id }, { $set: { workspace: null } });
      await ws.deleteOne();
      continue;
    }
    if (!ws.members.some((m) => m.role === 'owner')) (ws.members.find((m) => m.role === 'admin') ?? ws.members[0]).role = 'owner';
    await ws.save();
  }
}
