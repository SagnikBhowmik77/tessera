import * as projects from '../services/project.service.js';
import * as invites from '../services/invite.service.js';
import { closeProjectRoom, publish, removeFromProject } from '../realtime.js';
import { recordAudit } from '../services/audit.service.js';

// Controllers translate HTTP <-> service calls; all rules live in the services.
const send = async (res, project, userId, status = 200) =>
  res.status(status).json({ project: await projects.serializeProject(project, userId) });
// Project-level changes pushed to everyone with it open (they refetch the project).
const live = (req, action, projectId = req.project._id) =>
  publish(String(projectId), 'project', { action, actorId: String(req.user._id) });

export async function list(req, res) {
  res.json({ projects: await projects.listProjects(req.user, req.valid.query) });
}

export async function create(req, res) {
  const project = await projects.createProject(req.user, req.valid.body);
  recordAudit(project._id, req.user._id, 'project.created', { target: project.name, details: { template: project.setupTemplate } });
  await send(res, project, req.user._id, 201);
}

export async function get(req, res) {
  await send(res, req.project, req.user._id);
}

export async function update(req, res) {
  const project = await projects.updateProject(req.project, req.membership, req.valid.body);
  live(req, 'updated');
  await send(res, project, req.user._id);
}

export async function archive(req, res) {
  const project = await projects.setArchived(req.project, true);
  live(req, 'archived');
  await send(res, project, req.user._id);
}

export async function unarchive(req, res) {
  const project = await projects.setArchived(req.project, false);
  live(req, 'unarchived');
  await send(res, project, req.user._id);
}

export async function remove(req, res) {
  await projects.deleteProject(req.project, req.valid.body);
  live(req, 'deleted');
  await closeProjectRoom(String(req.project._id));
  res.status(204).end();
}

export async function members(req, res) {
  const project = await projects.serializeProject(req.project, req.user._id);
  res.json({ members: project.members });
}

export async function changeRole(req, res) {
  const project = await projects.changeRole(req.project, req.membership, req.valid.params.userId, req.valid.body.role);
  live(req, 'members');
  await send(res, project, req.user._id);
}

export async function removeMember(req, res) {
  const result = await projects.removeMember(req.project, req.membership, req.valid.params.userId);
  await removeFromProject(req.valid.params.userId, String(req.project._id));
  live(req, 'members');
  res.json(result);
}

export async function createInvite(req, res) {
  res.status(201).json(await invites.createInvite(req.project, req.membership, req.user, req.valid.body));
}

export async function listInvites(req, res) {
  res.json({ invites: await invites.listInvites(req.project) });
}

export async function revokeInvite(req, res) {
  await invites.revokeInvite(req.project, req.valid.params.inviteId);
  res.status(204).end();
}

export async function previewInvite(req, res) {
  res.json({ invite: await invites.previewInvite(req.valid.params.token) });
}

export async function acceptInvite(req, res) {
  const project = await invites.acceptInvite(req.valid.params.token, req.user);
  recordAudit(project._id, req.user._id, 'member.joined', { target: `${req.user.name} (${req.user.email})` });
  live(req, 'members', project._id);
  await send(res, project, req.user._id);
}

export async function declineInvite(req, res) {
  await invites.declineInvite(req.valid.params.token);
  res.status(204).end();
}
