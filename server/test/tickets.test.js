// Tickets against a real throwaway MongoDB (never Atlas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project, Ticket, TicketEvent } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function team(roles = ['manager', 'developer', 'viewer']) {
  const admin = await t.signUp('Admin');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `TS${keyN}` } });
  const people = { admin, project: body.project };
  for (const role of roles) {
    const person = await t.signUp(role);
    await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: person.user.id, role } } });
    people[role] = person;
  }
  // A second developer, for "someone else's ticket".
  const dev2 = await t.signUp('Dev Two');
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev2.user.id, role: 'developer' } } });
  people.dev2 = dev2;
  return people;
}

const base = (project) => `/api/projects/${project.id}/tickets`;
const create = (project, who, body) => t.api('POST', base(project), { token: who.token, body });
const patch = (project, who, ref, body) => t.api('PATCH', `${base(project)}/${ref}`, { token: who.token, body });
const move = (project, who, ref, body) => t.api('POST', `${base(project)}/${ref}/move`, { token: who.token, body });
const column = async (project, who, status) =>
  (await t.api('GET', `${base(project)}?status=${status}`, { token: who.token })).body.tickets.map((x) => x.number);

test('creating tickets: numbered per project, defaults, reporter, created event', async () => {
  const { project, developer } = await team();
  const res = await create(project, developer, { title: '  Checkout button does nothing ', type: 'bug', labels: ['UI', 'ui', 'Checkout'], dueDate: '2026-12-01', storyPoints: 3 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ticket = res.body.ticket;
  assert.equal(ticket.key, `${project.key}-1`);
  assert.equal(ticket.number, 1);
  assert.equal(ticket.title, 'Checkout button does nothing');
  assert.equal(ticket.status, 'todo');
  assert.equal(ticket.priority, 'medium');
  assert.deepEqual(ticket.labels, ['ui', 'checkout']);
  assert.equal(ticket.dueDate, '2026-12-01');
  assert.equal(ticket.reporter.id, developer.user.id);
  assert.equal(ticket.assignee, null);
  assert.equal(ticket.resolvedAt, null);
  assert.equal(ticket._id, undefined);

  const second = await create(project, developer, { title: 'Second' });
  assert.equal(second.body.ticket.key, `${project.key}-2`);
  const events = await TicketEvent.find({ ticket: ticket.id }).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
  assert.equal(events[0].to.status, 'todo');
});

test('numbers stay unique when many tickets are created at once', async () => {
  const { project, admin } = await team([]);
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => create(project, admin, { title: `T${i}` })));
  assert.ok(results.every((r) => r.status === 201));
  const numbers = results.map((r) => r.body.ticket.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 15 }, (_, i) => i + 1));
});

test('create validation: viewers cannot create; status and assignee must fit the project', async () => {
  const { project, viewer, developer, admin } = await team();
  assert.equal((await create(project, viewer, { title: 'Nope' })).status, 403);
  assert.equal((await create(project, developer, { title: '' })).status, 400);
  assert.equal((await create(project, developer, { title: 'X', priority: 'urgent' })).status, 400);
  assert.equal((await create(project, developer, { title: 'X', dueDate: '2026-02-30' })).status, 400);
  const badStatus = await create(project, developer, { title: 'X', status: 'review' });
  assert.equal(badStatus.body.error.code, 'unknown_status');
  const toViewer = await create(project, developer, { title: 'X', assigneeId: viewer.user.id });
  assert.equal(toViewer.body.error.code, 'assignee_is_viewer');
  const outsider = await t.signUp();
  const toOutsider = await create(project, developer, { title: 'X', assigneeId: outsider.user.id });
  assert.equal(toOutsider.body.error.code, 'assignee_not_member');
  const done = await create(project, admin, { title: 'Already fixed', status: 'done', assigneeId: developer.user.id });
  assert.equal(done.status, 201);
  assert.ok(done.body.ticket.resolvedAt);
  assert.equal(done.body.ticket.assignee.id, developer.user.id);
});

test('reading: by number or key; other keys and outsiders get 404', async () => {
  const { project, developer, viewer } = await team();
  await create(project, developer, { title: 'Read me' });
  assert.equal((await t.api('GET', `${base(project)}/1`, { token: viewer.token })).body.ticket.title, 'Read me');
  assert.equal((await t.api('GET', `${base(project)}/${project.key.toLowerCase()}-1`, { token: viewer.token })).status, 200);
  assert.equal((await t.api('GET', `${base(project)}/OTHER-1`, { token: viewer.token })).status, 404);
  assert.equal((await t.api('GET', `${base(project)}/99`, { token: viewer.token })).status, 404);
  assert.equal((await t.api('GET', `${base(project)}/abc`, { token: viewer.token })).status, 400);
  const outsider = await t.signUp();
  assert.equal((await t.api('GET', `${base(project)}/1`, { token: outsider.token })).status, 404);
});

test('editing rights: own or assigned for developers, any for managers; "assign to me" for anyone who works', async () => {
  const { project, developer, dev2, manager, viewer } = await team();
  await create(project, developer, { title: 'Mine' });
  await create(project, dev2, { title: 'Theirs' });

  assert.equal((await patch(project, developer, 1, { priority: 'high' })).status, 200);
  assert.equal((await patch(project, developer, 2, { priority: 'high' })).status, 403);
  assert.equal((await patch(project, viewer, 1, { priority: 'low' })).status, 403);
  assert.equal((await patch(project, manager, 2, { priority: 'critical' })).status, 200);

  // Picking up someone else's unassigned ticket is allowed, and then it is yours to edit.
  const pick = await patch(project, developer, 2, { assigneeId: developer.user.id });
  assert.equal(pick.status, 200);
  assert.equal(pick.body.ticket.assignee.id, developer.user.id);
  assert.equal((await patch(project, developer, 2, { title: 'Theirs, now mine to fix' })).status, 200);
  // But not grabbing a ticket that is already assigned to someone else.
  await patch(project, manager, 1, { assigneeId: manager.user.id });
  assert.equal((await patch(project, dev2, 1, { assigneeId: dev2.user.id })).status, 403);
});

test('every real change is logged with from/to; unchanged values are not', async () => {
  const { project, developer, manager } = await team();
  await create(project, developer, { title: 'Log me', labels: ['a'] });
  const res = await patch(project, developer, 1, {
    title: 'Log me', priority: 'high', labels: ['a', 'b'], dueDate: '2026-12-24', assigneeId: manager.user.id,
  });
  assert.equal(res.status, 200);
  const history = (await t.api('GET', `${base(project)}/1/history`, { token: developer.token })).body.events;
  const summary = history.map((e) => [e.type, e.field, e.from, e.to]);
  assert.deepEqual(summary.slice(1), [
    ['updated', 'priority', 'medium', 'high'],
    ['updated', 'labels', ['a'], ['a', 'b']],
    ['updated', 'dueDate', null, '2026-12-24'],
    ['assigned', null, null, manager.user.id],
  ]);
  assert.equal(history[1].actor.name, 'developer');
  // Clearing the due date and unassigning.
  await patch(project, developer, 1, { dueDate: null, assigneeId: null });
  const ticket = (await t.api('GET', `${base(project)}/1`, { token: developer.token })).body.ticket;
  assert.equal(ticket.dueDate, null);
  assert.equal(ticket.assignee, null);
});

test('status changes: resolvedAt is set in Done and cleared when reopened', async () => {
  const { project, developer } = await team();
  await create(project, developer, { title: 'Ship it' });
  const done = await patch(project, developer, 1, { status: 'done' });
  assert.ok(done.body.ticket.resolvedAt);
  const reopened = await patch(project, developer, 1, { status: 'in_progress' });
  assert.equal(reopened.body.ticket.resolvedAt, null);
  const events = await TicketEvent.find({ ticket: done.body.ticket.id, type: 'status_changed' }).sort({ at: 1 }).lean();
  assert.deepEqual(events.map((e) => [e.from, e.to]), [['todo', 'done'], ['done', 'in_progress']]);
});

test('drag and drop: order within a column and moves between columns', async () => {
  const { project, developer, dev2 } = await team();
  for (const title of ['one', 'two', 'three', 'four']) await create(project, developer, { title });
  assert.deepEqual(await column(project, developer, 'todo'), [1, 2, 3, 4]);

  // Any developer may move any card. Move 4 between 1 and 2.
  assert.equal((await move(project, dev2, 4, { status: 'todo', after: 1, before: 2 })).status, 200);
  assert.deepEqual(await column(project, developer, 'todo'), [1, 4, 2, 3]);
  // To the top, then to the bottom.
  await move(project, dev2, 3, { status: 'todo', after: null, before: 1 });
  assert.deepEqual(await column(project, developer, 'todo'), [3, 1, 4, 2]);
  await move(project, dev2, 3, { status: 'todo', after: 2 });
  assert.deepEqual(await column(project, developer, 'todo'), [1, 4, 2, 3]);
  // Reordering is not logged as workflow.
  assert.equal(await TicketEvent.countDocuments({ type: 'status_changed', project: project.id }), 0);

  // Into an empty column, then between columns with a position.
  const moved = await move(project, dev2, 2, { status: 'in_progress' });
  assert.equal(moved.body.ticket.status, 'in_progress');
  await move(project, developer, 1, { status: 'in_progress', before: 2 });
  assert.deepEqual(await column(project, developer, 'in_progress'), [1, 2]);
  assert.deepEqual(await column(project, developer, 'todo'), [4, 3]);
  assert.equal(await TicketEvent.countDocuments({ type: 'status_changed', project: project.id }), 2);

  // A neighbour that isn't in the target column means the board was stale.
  const stale = await move(project, developer, 3, { status: 'todo', after: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_board');
  const viewerMove = await move(project, (await team()).viewer, 1, { status: 'done' });
  assert.equal(viewerMove.status, 404, 'a viewer of another project cannot see this one');
});

test('cards that ended up with the same rank are rebalanced instead of failing', async () => {
  const { project, developer } = await team(['developer']);
  for (const title of ['a', 'b', 'c']) await create(project, developer, { title });
  await Ticket.updateMany({ project: project.id }, { $set: { rank: 'a0' } });
  const res = await move(project, developer, 3, { status: 'todo', after: 1, before: 2 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await column(project, developer, 'todo'), [1, 3, 2]);
  const ranks = (await Ticket.find({ project: project.id }).lean()).map((x) => x.rank);
  assert.equal(new Set(ranks).size, 3);
});

test('delete goes to the bin and can be restored; rights follow the reporter', async () => {
  const { project, developer, dev2, manager } = await team();
  await create(project, developer, { title: 'Bin me' });
  await create(project, developer, { title: 'Stay' });

  assert.equal((await t.api('DELETE', `${base(project)}/1`, { token: dev2.token })).status, 403);
  assert.equal((await t.api('DELETE', `${base(project)}/1`, { token: developer.token })).status, 204);
  assert.deepEqual(await column(project, developer, 'todo'), [2]);
  const bin = await t.api('GET', `${base(project)}?deleted=true`, { token: developer.token });
  assert.deepEqual(bin.body.tickets.map((x) => x.number), [1]);
  assert.ok(bin.body.tickets[0].deletedAt);

  assert.equal((await patch(project, developer, 1, { title: 'x' })).body.error.code, 'ticket_deleted');
  assert.equal((await t.api('DELETE', `${base(project)}/1`, { token: developer.token })).status, 409);
  const restored = await t.api('POST', `${base(project)}/1/restore`, { token: manager.token });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.ticket.deletedAt, null);
  assert.deepEqual(await column(project, developer, 'todo'), [2, 1]);
  const types = (await TicketEvent.find({ ticket: restored.body.ticket.id }).sort({ at: 1, _id: 1 }).lean()).map((e) => e.type);
  assert.deepEqual(types, ['created', 'deleted', 'restored']);
  // Numbers are never reused.
  assert.equal((await create(project, developer, { title: 'Next' })).body.ticket.number, 3);
});

test('archived projects: tickets can be read but not changed; key changes rename tickets', async () => {
  const { project, admin, developer } = await team();
  await create(project, developer, { title: 'Frozen' });
  await t.api('PATCH', `/api/projects/${project.id}`, { token: admin.token, body: { key: 'NEWK' } });
  assert.equal((await t.api('GET', `${base(project)}/NEWK-1`, { token: developer.token })).body.ticket.key, 'NEWK-1');

  await t.api('POST', `/api/projects/${project.id}/archive`, { token: admin.token });
  assert.equal((await t.api('GET', `${base(project)}/1`, { token: developer.token })).status, 200);
  const blocked = await create(project, admin, { title: 'No' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'project_archived');
  assert.equal((await move(project, admin, 1, { status: 'done' })).status, 409);
});
