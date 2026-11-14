// Runs against a real, throwaway MongoDB (mongodb-memory-server), never Atlas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { User, Project, Ticket, TicketEvent, DEFAULT_STATUSES } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const newUser = (email = 'asha@example.com') =>
  User.create({ name: 'Asha', email, passwordHash: 'not-a-real-hash' });

const newProject = (owner, extra = {}) =>
  Project.create({ name: 'Tessera', key: 'tes', owner: owner._id, members: [{ user: owner._id, role: 'admin' }], ...extra });

const newTicket = (project, extra = {}) =>
  Ticket.create({ project: project._id, number: 1, title: 'Login button does nothing', status: 'todo', rank: 'a0', ...extra });

const indexNames = async (model) => (await model.collection.indexes()).map((i) => i.name);

test('health reports a connected database', async () => {
  const { status, body } = await t.api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.database, { configured: true, connected: true });
});

test('user email is unique regardless of case and the hash is hidden by default', async () => {
  await newUser('Dup@Example.com');
  await assert.rejects(newUser('dup@example.com'), /duplicate key/);
  const found = await User.findOne({ email: 'dup@example.com' });
  assert.equal(found.passwordHash, undefined);
  const withHash = await User.findOne({ email: 'dup@example.com' }).select('+passwordHash');
  assert.equal(withHash.passwordHash, 'not-a-real-hash');
});

test('a new project gets the three default columns, an uppercase key and counter 0', async () => {
  const owner = await newUser('owner1@example.com');
  const project = await newProject(owner);
  assert.equal(project.key, 'TES');
  assert.equal(project.ticketCounter, 0);
  assert.deepEqual(project.statuses.map((s) => s.key), DEFAULT_STATUSES.map((s) => s.key));
  assert.equal(project.statuses[0].wipLimit, null);
});

test('project validation: key format, members, unique status keys, a done column', async () => {
  const owner = await newUser('owner2@example.com');
  await assert.rejects(newProject(owner, { key: '1BAD' }), /key/);
  await assert.rejects(newProject(owner, { key: 'TOOLONGKEY' }), /key/);
  await assert.rejects(newProject(owner, { members: [] }), /at least one member/);
  await assert.rejects(newProject(owner, { members: [{ user: owner._id, role: 'god' }] }), /role/);
  await assert.rejects(
    newProject(owner, { statuses: [{ key: 'a', name: 'A', category: 'todo' }, { key: 'a', name: 'B', category: 'done' }] }),
    /unique/,
  );
  await assert.rejects(
    newProject(owner, { statuses: [{ key: 'a', name: 'A', category: 'todo' }, { key: 'b', name: 'B', category: 'in_progress' }] }),
    /done/,
  );
});

test('project key is unique per owner but two owners may reuse it', async () => {
  const a = await newUser('owner3@example.com');
  const b = await newUser('owner4@example.com');
  await newProject(a, { key: 'APP' });
  await assert.rejects(newProject(a, { key: 'app' }), /duplicate key/);
  await newProject(b, { key: 'APP' });
});

test('ticket numbers are unique within a project and the counter increments atomically', async () => {
  const owner = await newUser('owner5@example.com');
  const project = await newProject(owner);
  // 20 tickets created at the same moment must get 20 different numbers.
  const numbers = await Promise.all(
    Array.from({ length: 20 }, () =>
      Project.findByIdAndUpdate(project._id, { $inc: { ticketCounter: 1 } }, { returnDocument: 'after' })
        .then((p) => p.ticketCounter)),
  );
  assert.equal(new Set(numbers).size, 20);
  await newTicket(project, { number: 7 });
  await assert.rejects(newTicket(project, { number: 7 }), /duplicate key/);
});

test('ticket defaults and validation', async () => {
  const owner = await newUser('owner6@example.com');
  const project = await newProject(owner);
  const ticket = await newTicket(project, { labels: ['UI', ' Auth '] });
  assert.equal(ticket.type, 'task');
  assert.equal(ticket.priority, 'medium');
  assert.deepEqual([...ticket.labels], ['ui', 'auth']);
  assert.equal(ticket.resolvedAt, null);
  await assert.rejects(newTicket(project, { number: 2, priority: 'urgent' }), /priority/);
  await assert.rejects(newTicket(project, { number: 3, type: 'story' }), /type/);
  await assert.rejects(newTicket(project, { number: 4, title: '' }), /title/);
  await assert.rejects(newTicket(project, { number: 5, labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }), /20 labels/);
});

test('ticket events store any from/to values and reject unknown types', async () => {
  const owner = await newUser('owner7@example.com');
  const project = await newProject(owner);
  const ticket = await newTicket(project);
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: owner._id, type: 'status_changed', from: 'todo', to: 'in_progress' });
  await TicketEvent.create({ project: project._id, ticket: ticket._id, type: 'updated', field: 'labels', from: [], to: ['ui'], source: 'github' });
  const events = await TicketEvent.find({ ticket: ticket._id }).sort({ at: 1 }).lean();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].to, ['ui']);
  await assert.rejects(TicketEvent.create({ project: project._id, ticket: ticket._id, type: 'teleported' }), /type/);
});

test('every declared index exists, including the text search index', async () => {
  assert.ok((await indexNames(User)).includes('email_1'));
  const projectIdx = await indexNames(Project);
  assert.ok(projectIdx.includes('owner_1_key_1'));
  assert.ok(projectIdx.includes('members.user_1_archivedAt_1'));
  const ticketIdx = await indexNames(Ticket);
  for (const name of ['project_1_number_1', 'project_1_status_1_rank_1', 'assignee_1_status_1', 'ticket_text']) {
    assert.ok(ticketIdx.includes(name), `missing ${name}`);
  }
  const eventIdx = await indexNames(TicketEvent);
  assert.ok(eventIdx.includes('ticket_1_at_1'));
  assert.ok(eventIdx.includes('project_1_at_1'));
});

// Last on purpose: it drops the connection and then restores it.
test('health turns 503 while the database is disconnected, and recovers', async () => {
  await disconnectDb();
  const down = await t.api('GET', '/api/health');
  assert.equal(down.status, 503);
  assert.equal(down.body.ok, false);
  assert.equal(down.body.database.connected, false);
  await connectDb(t.uri);
  assert.equal((await t.api('GET', '/api/health')).status, 200);
});
