// Planning (E3A): sub-tasks, epics, dependencies, the blocked flag and blocked time (throwaway MongoDB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project, Ticket, TicketEvent } from '../src/models/index.js';
import { addDays, todayIn } from '../src/dates.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Plan', key: `PL${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: viewer.user.id, role: 'viewer' } } });
  const base = `/api/projects/${body.project.id}`;
  const url = `${base}/tickets`;
  const mk = async (title, extra = {}) => (await t.api('POST', url, { token: admin.token, body: { title, ...extra } })).body.ticket;
  const rel = async (key) => (await t.api('GET', `${url}/${key}/relations`, { token: admin.token })).body.relations;
  return { admin, viewer, project: body.project, base, url, mk, rel, key: `PL${keyN}` };
}

test('sub-tasks: added under a ticket, counted on its card, one level deep only', async () => {
  const { admin, viewer, url, mk, rel } = await team();
  const story = await mk('Checkout revamp');
  const add = (title) => t.api('POST', `${url}/${story.key}/subtasks`, { token: admin.token, body: { title } });
  assert.equal((await add('Design the form')).status, 201);
  await add('Build the API');
  assert.equal((await t.api('POST', `${url}/${story.key}/subtasks`, { token: viewer.token, body: { title: 'x' } })).status, 403);

  let r = await rel(story.key);
  assert.deepEqual(r.subtasks.map((s) => s.title), ['Design the form', 'Build the API']);
  assert.deepEqual(r.subtaskProgress, { total: 2, done: 0, points: 0, pointsDone: 0 });

  await t.api('POST', `${url}/${r.subtasks[0].key}/move`, { token: admin.token, body: { status: 'done' } });
  const card = (await t.api('GET', `${url}?sort=number`, { token: admin.token })).body.tickets.find((x) => x.key === story.key);
  assert.deepEqual(card.subtaskProgress, { total: 2, done: 1 });

  // No sub-task of a sub-task, and a ticket with sub-tasks can't become one.
  const nested = await t.api('POST', `${url}/${r.subtasks[0].key}/subtasks`, { token: admin.token, body: { title: 'Deeper' } });
  assert.equal(nested.body.error.code, 'parent_nested');
  const other = await mk('Other story');
  const flip = await t.api('PUT', `${url}/${story.key}/parent`, { token: admin.token, body: { parent: other.key } });
  assert.equal(flip.body.error.code, 'parent_has_children');
  r = await rel(r.subtasks[1].key);
  assert.equal(r.parent.key, story.key);
});

test('epics: group tickets, show progress, and keep the grouping consistent', async () => {
  const { admin, url, mk, rel } = await team();
  const epic = await mk('Payments v2', { type: 'epic' });
  const a = await mk('UPI', { storyPoints: 3 });
  const b = await mk('Cards', { storyPoints: 5 });
  const notEpic = await mk('Just a task');
  for (const x of [a, b]) {
    const res = await t.api('PUT', `${url}/${x.key}/epic`, { token: admin.token, body: { epic: epic.key } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  assert.equal((await t.api('PUT', `${url}/${notEpic.key}/epic`, { token: admin.token, body: { epic: notEpic.key } })).body.error.code, 'not_an_epic');
  await t.api('POST', `${url}/${a.key}/move`, { token: admin.token, body: { status: 'done' } });

  const r = await rel(epic.key);
  assert.deepEqual(r.epicProgress, { total: 2, done: 1, points: 8, pointsDone: 3 });
  const list = (await t.api('GET', `${url}?sort=number`, { token: admin.token })).body.tickets;
  assert.deepEqual(list.find((x) => x.key === b.key).epicInfo, { key: epic.key, title: 'Payments v2' });
  assert.deepEqual(list.find((x) => x.key === epic.key).epicProgress, { total: 2, done: 1 });

  // An epic with tickets in it can't stop being an epic; a sub-task follows its parent's epic.
  assert.equal((await t.api('PATCH', `${url}/${epic.key}`, { token: admin.token, body: { type: 'task' } })).body.error.code, 'epic_conflict');
  const sub = (await t.api('POST', `${url}/${b.key}/subtasks`, { token: admin.token, body: { title: 'Card form' } })).body.relations.subtasks[0];
  assert.equal((await t.api('PUT', `${url}/${sub.key}/epic`, { token: admin.token, body: { epic: epic.key } })).body.error.code, 'subtask_epic');

  // Taking a ticket out of the epic is recorded in its history.
  await t.api('PUT', `${url}/${b.key}/epic`, { token: admin.token, body: { epic: null } });
  const history = (await t.api('GET', `${url}/${b.key}/history`, { token: admin.token })).body.events.filter((e) => e.type === 'relation_changed');
  assert.deepEqual(history.map((e) => [e.field, e.from?.key ?? null, e.to?.key ?? null]), [['epic', null, epic.key], ['epic', epic.key, null]]);
});

test('dependencies: blocked while a blocker is open, unblocked when it is done; loops are refused', async () => {
  const { admin, url, mk, rel } = await team();
  const api = await mk('Payment API');
  const ui = await mk('Payment screen');
  const add = await t.api('POST', `${url}/${ui.key}/blockers`, { token: admin.token, body: { ticket: api.key } });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual(add.body.relations.blockedBy.map((x) => x.key), [api.key]);
  assert.equal(add.body.relations.blocked.reason, `Waiting on ${api.key}`);
  assert.deepEqual((await rel(api.key)).blocks.map((x) => x.key), [ui.key]);
  const card = (await t.api('GET', `${url}/${ui.key}`, { token: admin.token })).body.ticket;
  assert.ok(card.blockedSince);

  const loop = await t.api('POST', `${url}/${api.key}/blockers`, { token: admin.token, body: { ticket: ui.key } });
  assert.equal(loop.body.error.code, 'block_cycle');
  assert.equal((await t.api('POST', `${url}/${api.key}/blockers`, { token: admin.token, body: { ticket: api.key } })).body.error.code, 'block_self');

  // Finishing the blocker frees the ticket, and the history has both ends of the spell.
  const moved = await t.api('POST', `${url}/${api.key}/move`, { token: admin.token, body: { status: 'done' } });
  assert.equal(moved.status, 200);
  const freed = await rel(ui.key);
  assert.equal(freed.blocked, null);
  assert.equal(freed.blockedTime.spells, 1);
  const events = await TicketEvent.find({ ticket: ui.id, type: { $in: ['blocked', 'unblocked'] } }).sort({ at: 1 }).lean();
  assert.deepEqual(events.map((e) => e.type), ['blocked', 'unblocked']);
  assert.equal(events[0].to.kind, 'dependency');

  // Reopening the blocker blocks it again.
  await t.api('POST', `${url}/${api.key}/move`, { token: admin.token, body: { status: 'todo' } });
  assert.ok((await rel(ui.key)).blocked);
});

test('flag: blocked by hand with a reason; a new reason starts a new spell; clearing ends it', async () => {
  const { admin, viewer, url, mk, rel } = await team();
  const x = await mk('Go live');
  assert.equal((await t.api('PUT', `${url}/${x.key}/flag`, { token: viewer.token, body: { reason: 'nope' } })).status, 403);
  const flagged = await t.api('PUT', `${url}/${x.key}/flag`, { token: admin.token, body: { reason: 'Waiting for the payment provider' } });
  assert.equal(flagged.body.relations.blocked.reason, 'Waiting for the payment provider');
  assert.equal(flagged.body.relations.flag.reason, 'Waiting for the payment provider');
  await t.api('PUT', `${url}/${x.key}/flag`, { token: admin.token, body: { reason: 'Waiting for legal sign-off' } });
  const cleared = await t.api('DELETE', `${url}/${x.key}/flag`, { token: admin.token });
  assert.equal(cleared.body.relations.blocked, null);
  const events = await TicketEvent.find({ ticket: x.id, type: { $in: ['blocked', 'unblocked'] } }).sort({ at: 1, _id: 1 }).lean();
  assert.deepEqual(events.map((e) => [e.type, e.to?.reason ?? null]), [
    ['blocked', 'Waiting for the payment provider'], ['blocked', 'Waiting for legal sign-off'], ['unblocked', null],
  ]);
  assert.equal((await rel(x.key)).blockedTime.spells, 1, 'one spell, two reasons');
});

test('blocked time in analytics: hours by reason and by ticket, clipped to the range', async () => {
  const { admin, base, project, mk } = await team();
  const a = await mk('Integrate gateway');
  const b = await mk('Ship mobile build');
  const H = 3600e3;
  const now = Date.now();
  await TicketEvent.insertMany([
    { project: project.id, ticket: a.id, type: 'blocked', to: { reason: 'Waiting for the payment provider', kind: 'flag' }, at: new Date(now - 5 * H) },
    { project: project.id, ticket: a.id, type: 'unblocked', at: new Date(now - 3 * H) },
    { project: project.id, ticket: b.id, type: 'blocked', to: { reason: 'Waiting on X-1', kind: 'dependency' }, at: new Date(now - 4 * H) },
  ]);
  await Ticket.updateOne({ _id: b.id }, { $set: { blockedSince: new Date(now - 4 * H), blockedReason: 'Waiting on X-1' } });

  const today = todayIn();
  const res = await t.api('GET', `${base}/analytics?from=${addDays(today, -2)}&to=${today}`, { token: admin.token });
  assert.equal(res.status, 200);
  const blocked = res.body.blocked;
  assert.equal(blocked.tickets, 2);
  assert.equal(blocked.blockedNow, 1);
  const byReason = Object.fromEntries(blocked.byReason.map((r) => [r.reason, r.hours]));
  assert.ok(Math.abs(byReason['Waiting for the payment provider'] - 2) < 0.1);
  assert.ok(Math.abs(byReason['Waiting on other tickets'] - 4) < 0.1);
  assert.ok(Math.abs(blocked.totalHours - 6) < 0.1);
  assert.equal(blocked.topTickets[0].key, b.key);
});
