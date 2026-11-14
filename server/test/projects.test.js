// Projects, members and roles against a real throwaway MongoDB (never Atlas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project, Ticket, TicketEvent } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const create = (token, body) => t.api('POST', '/api/projects', { token, body });

// A project with an admin plus extra members added directly (invites have their own tests).
let keyN = 0;
async function team(roles = []) {
  const admin = await t.signUp('Admin');
  keyN += 1;
  const res = await create(admin.token, { name: 'Payments', key: `PAY${keyN}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const project = res.body.project;
  const people = { admin };
  for (const role of roles) {
    const person = await t.signUp(role);
    await Project.updateOne({ _id: project.id }, { $push: { members: { user: person.user.id, role } } });
    people[role] = person;
  }
  return { project, ...people };
}

const path = (project, rest = '') => `/api/projects/${project.id}${rest}`;

test('creating a project makes you its admin with the default columns', async () => {
  const me = await t.signUp('Asha');
  const res = await create(me.token, { name: '  Tessera Web ', key: 'tw', description: 'The web app' });
  assert.equal(res.status, 201);
  const { project } = res.body;
  assert.equal(project.name, 'Tessera Web');
  assert.equal(project.key, 'TW');
  assert.equal(project.myRole, 'admin');
  assert.equal(project.ticketCounter, 0);
  assert.equal(project._id, undefined);
  assert.deepEqual(project.statuses.map((s) => s.name), ['To Do', 'In Progress', 'Done']);
  assert.equal(project.members.length, 1);
  assert.deepEqual(Object.keys(project.members[0].user).sort(), ['email', 'id', 'name']);
  assert.equal(project.members[0].role, 'admin');
});

test('create validation and key clashes', async () => {
  const me = await t.signUp();
  const bad = await create(me.token, { name: '', key: '9X' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.map((d) => d.field).sort(), ['key', 'name']);
  assert.equal((await create(me.token, { name: 'A', key: 'ABC' })).status, 201);
  const clash = await create(me.token, { name: 'B', key: 'abc' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'key_taken');
  // Someone else can use the same key.
  const other = await t.signUp();
  assert.equal((await create(other.token, { name: 'C', key: 'ABC' })).status, 201);
});

test('projects need login and are invisible to non-members (404, not 403)', async () => {
  const { project } = await team();
  const stranger = await t.signUp('Stranger');
  assert.equal((await t.api('GET', '/api/projects')).status, 401);
  const res = await t.api('GET', path(project), { token: stranger.token });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'project_not_found');
  assert.equal((await t.api('GET', '/api/projects/not-an-id', { token: stranger.token })).status, 400);
  const list = await t.api('GET', '/api/projects', { token: stranger.token });
  assert.deepEqual(list.body.projects, []);
});

test('the list shows my projects with my role; archived ones only on request', async () => {
  const { project, admin, viewer } = await team(['viewer']);
  const mine = await t.api('GET', '/api/projects', { token: viewer.token });
  assert.deepEqual(mine.body.projects.map((p) => [p.id, p.myRole]), [[project.id, 'viewer']]);

  assert.equal((await t.api('POST', path(project, '/archive'), { token: admin.token })).status, 200);
  assert.deepEqual((await t.api('GET', '/api/projects', { token: viewer.token })).body.projects, []);
  const archived = await t.api('GET', '/api/projects?archived=true', { token: viewer.token });
  assert.equal(archived.body.projects.length, 1);
  assert.ok(archived.body.projects[0].archivedAt);
});

test('who may edit: managers edit name and description, only admins change the key', async () => {
  const { project, admin, manager, developer } = await team(['manager', 'developer']);
  assert.equal((await t.api('PATCH', path(project), { token: developer.token, body: { name: 'X' } })).status, 403);
  const byManager = await t.api('PATCH', path(project), { token: manager.token, body: { name: 'Payments v2', description: 'New' } });
  assert.equal(byManager.status, 200);
  assert.equal(byManager.body.project.name, 'Payments v2');
  assert.equal((await t.api('PATCH', path(project), { token: manager.token, body: { key: 'NEW' } })).status, 403);
  const byAdmin = await t.api('PATCH', path(project), { token: admin.token, body: { key: 'new' } });
  assert.equal(byAdmin.body.project.key, 'NEW');
  assert.equal((await t.api('PATCH', path(project), { token: admin.token, body: {} })).status, 400);
});

test('archived projects are read-only until an admin unarchives them', async () => {
  const { project, admin, manager } = await team(['manager']);
  assert.equal((await t.api('POST', path(project, '/archive'), { token: manager.token })).status, 403);
  await t.api('POST', path(project, '/archive'), { token: admin.token });
  const blocked = await t.api('PATCH', path(project), { token: admin.token, body: { name: 'Nope' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'project_archived');
  assert.equal((await t.api('GET', path(project), { token: manager.token })).status, 200);
  const back = await t.api('POST', path(project, '/unarchive'), { token: admin.token });
  assert.equal(back.body.project.archivedAt, null);
  assert.equal((await t.api('PATCH', path(project), { token: admin.token, body: { name: 'Yes' } })).status, 200);
});

test('deleting a project needs the admin role and the key typed to confirm; it removes tickets and history', async () => {
  const { project, admin, manager } = await team(['manager']);
  const ticket = await Ticket.create({ project: project.id, number: 1, title: 'Bug', status: 'todo', rank: 'a0' });
  await TicketEvent.create({ project: project.id, ticket: ticket._id, type: 'created' });

  assert.equal((await t.api('DELETE', path(project), { token: manager.token, body: { confirmKey: project.key } })).status, 403);
  const wrong = await t.api('DELETE', path(project), { token: admin.token, body: { confirmKey: 'NOPE' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'confirm_mismatch');
  assert.equal((await t.api('DELETE', path(project), { token: admin.token, body: { confirmKey: project.key.toLowerCase() } })).status, 204);
  assert.equal(await Project.exists({ _id: project.id }), null);
  assert.equal(await Ticket.countDocuments({ project: project.id }), 0);
  assert.equal(await TicketEvent.countDocuments({ project: project.id }), 0);
});

test('role changes: admins change anyone, managers only developers and viewers', async () => {
  const { project, admin, manager, developer, viewer } = await team(['manager', 'developer', 'viewer']);
  const role = (actor, target, r) =>
    t.api('PATCH', path(project, `/members/${target.user.id}`), { token: actor.token, body: { role: r } });

  assert.equal((await role(manager, viewer, 'developer')).status, 200);
  assert.equal((await role(manager, developer, 'manager')).status, 403, 'manager cannot create managers');
  assert.equal((await role(manager, admin, 'viewer')).status, 403, 'manager cannot touch admins');
  assert.equal((await role(developer, viewer, 'viewer')).status, 403, 'developers manage nobody');
  assert.equal((await role(developer, developer, 'admin')).status, 403, 'nobody raises their own role');
  assert.equal((await role(developer, developer, 'viewer')).status, 200, 'lowering your own role is fine');
  const promoted = await role(admin, manager, 'admin');
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.project.members.find((m) => m.user.id === manager.user.id).role, 'admin');
  assert.equal((await role(admin, manager, 'bogus')).status, 400);
  const outsider = await t.signUp();
  assert.equal((await role(admin, outsider, 'viewer')).status, 404);
});

test('a project always keeps at least one admin', async () => {
  const { project, admin, developer } = await team(['developer']);
  const demote = await t.api('PATCH', path(project, `/members/${admin.user.id}`), { token: admin.token, body: { role: 'developer' } });
  assert.equal(demote.status, 409);
  assert.equal(demote.body.error.code, 'last_admin');
  const leave = await t.api('DELETE', path(project, `/members/${admin.user.id}`), { token: admin.token });
  assert.equal(leave.status, 409);

  // With a second admin, two simultaneous self-demotions can't both succeed.
  await t.api('PATCH', path(project, `/members/${developer.user.id}`), { token: admin.token, body: { role: 'admin' } });
  const both = await Promise.all([admin, developer].map((p) =>
    t.api('PATCH', path(project, `/members/${p.user.id}`), { token: p.token, body: { role: 'viewer' } })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const fresh = await Project.findById(project.id).lean();
  assert.equal(fresh.members.filter((m) => m.role === 'admin').length, 1);
});

test('removing members and leaving; their tickets become unassigned with history', async () => {
  const { project, admin, manager, developer, viewer } = await team(['manager', 'developer', 'viewer']);
  const ticket = await Ticket.create({ project: project.id, number: 1, title: 'Fix it', status: 'todo', rank: 'a0', assignee: developer.user.id });

  assert.equal((await t.api('DELETE', path(project, `/members/${admin.user.id}`), { token: manager.token })).status, 403);
  assert.equal((await t.api('DELETE', path(project, `/members/${manager.user.id}`), { token: viewer.token })).status, 403);

  const removed = await t.api('DELETE', path(project, `/members/${developer.user.id}`), { token: manager.token });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { left: false, unassignedTickets: 1 });
  assert.equal((await Ticket.findById(ticket._id)).assignee, null);
  const event = await TicketEvent.findOne({ ticket: ticket._id, type: 'assigned' }).lean();
  assert.equal(String(event.actor), manager.user.id);
  assert.equal((await t.api('GET', path(project), { token: developer.token })).status, 404);

  const left = await t.api('DELETE', path(project, `/members/${viewer.user.id}`), { token: viewer.token });
  assert.deepEqual(left.body, { left: true, unassignedTickets: 0 });
  const members = await t.api('GET', path(project, '/members'), { token: admin.token });
  assert.deepEqual(members.body.members.map((m) => m.role).sort(), ['admin', 'manager']);
});
