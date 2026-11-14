// Filters, search, sorting, saved filters and "my work" against a real throwaway MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project } from '../src/models/index.js';
import { addDays, todayIn } from '../src/dates.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
// One project with a known set of tickets.
async function seeded() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Store', key: `SR${keyN}` } });
  const project = body.project;
  await Project.updateOne({ _id: project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  const today = todayIn();
  const make = (who, b) => t.api('POST', `/api/projects/${project.id}/tickets`, { token: who.token, body: b });
  // #1..#6
  await make(admin, { title: 'Checkout crashes on Safari', type: 'bug', priority: 'critical', labels: ['checkout', 'safari'], assigneeId: dev.user.id, dueDate: addDays(today, -2) });
  await make(dev, { title: 'Add dark mode to settings', type: 'feature', priority: 'low', labels: ['ui'], dueDate: addDays(today, 3) });
  await make(admin, { title: 'Payment page shows wrong total', type: 'bug', priority: 'high', labels: ['checkout'], assigneeId: dev.user.id, description: 'The GST line is added twice when a coupon is applied.' });
  await make(dev, { title: 'Write onboarding docs', type: 'task', priority: 'medium', dueDate: today });
  await make(admin, { title: 'Login crash after password reset', type: 'bug', priority: 'medium', status: 'done', assigneeId: dev.user.id, dueDate: addDays(today, -5) });
  await make(admin, { title: 'Improve search ranking', type: 'feature', priority: 'high', status: 'in_progress', assigneeId: admin.user.id });
  return { admin, dev, viewer, project, url: `/api/projects/${project.id}/tickets` };
}
const numbers = (res) => res.body.tickets.map((x) => x.number);
const get = (s, who, qs) => t.api('GET', `${s.url}?${qs}`, { token: who.token });

test('filters combine: each filter narrows, values inside one filter widen', async () => {
  const s = await seeded();
  assert.deepEqual(numbers(await get(s, s.dev, 'type=bug&sort=number')), [1, 3, 5]);
  assert.deepEqual(numbers(await get(s, s.dev, 'type=bug,feature&priority=high,critical&sort=number')), [1, 3, 6]);
  assert.deepEqual(numbers(await get(s, s.dev, 'status=done')), [5]);
  assert.deepEqual(numbers(await get(s, s.dev, 'label=checkout&sort=number')), [1, 3]);
  assert.deepEqual(numbers(await get(s, s.dev, 'label=CHECKOUT,ui&sort=number')), [1, 2, 3]);
  assert.deepEqual(numbers(await get(s, s.dev, `reporter=${s.dev.user.id}&sort=number`)), [2, 4]);
});

test('"me" and "none" for people, and open/closed', async () => {
  const s = await seeded();
  assert.deepEqual(numbers(await get(s, s.dev, 'assignee=me&open=true&sort=number')), [1, 3]);
  assert.deepEqual(numbers(await get(s, s.admin, 'assignee=me&sort=number')), [6], '"me" follows whoever asks');
  assert.deepEqual(numbers(await get(s, s.dev, 'assignee=none&sort=number')), [2, 4]);
  assert.deepEqual(numbers(await get(s, s.dev, `assignee=none,${s.admin.user.id}&sort=number`)), [2, 4, 6]);
  assert.deepEqual(numbers(await get(s, s.dev, 'reporter=me&sort=number')), [2, 4]);
  assert.deepEqual(numbers(await get(s, s.dev, 'open=false')), [5]);
});

test('due dates use the team calendar: overdue skips finished work', async () => {
  const s = await seeded();
  assert.deepEqual(numbers(await get(s, s.dev, 'due=overdue')), [1], '#5 is overdue on paper but done');
  assert.deepEqual(numbers(await get(s, s.dev, 'due=today')), [4]);
  assert.deepEqual(numbers(await get(s, s.dev, 'due=week&sort=number')), [2, 4]);
  assert.deepEqual(numbers(await get(s, s.dev, 'due=none&sort=number')), [3, 6]);
  const today = todayIn();
  assert.deepEqual(numbers(await get(s, s.dev, `dueFrom=${addDays(today, -3)}&dueTo=${today}&sort=number`)), [1, 4]);
  assert.equal((await get(s, s.dev, `dueFrom=${today}&dueTo=${addDays(today, -1)}`)).status, 400);
});

test('keyword search: whole words ranked, partial words, ticket keys', async () => {
  const s = await seeded();
  const crash = await get(s, s.dev, 'q=crash&sort=relevance');
  assert.equal(crash.body.search.mode, 'words');
  assert.deepEqual(numbers(crash).sort(), [1, 5], '"crash" also finds "crashes"');

  const inDescription = await get(s, s.dev, 'q=coupon');
  assert.deepEqual(numbers(inDescription), [3]);

  const partial = await get(s, s.dev, 'q=checko');
  assert.equal(partial.body.search.mode, 'partial');
  assert.deepEqual(numbers(partial).sort(), [1, 3]);

  const byKey = await get(s, s.dev, `q=${s.project.key.toLowerCase()}-4`);
  assert.equal(byKey.body.search.mode, 'key');
  assert.deepEqual(numbers(byKey), [4]);
  assert.deepEqual(numbers(await get(s, s.dev, 'q=4')), [4]);

  // Search respects the other filters too, and special characters are safe.
  assert.deepEqual(numbers(await get(s, s.dev, 'q=crash&open=true')), [1]);
  const odd = await get(s, s.dev, `q=${encodeURIComponent('.*(')}`);
  assert.equal(odd.status, 200);
  assert.deepEqual(numbers(odd), []);
});

test('sorting: board order follows the project columns; priority, due, newest', async () => {
  const s = await seeded();
  const board = await get(s, s.dev, 'sort=rank');
  assert.deepEqual(board.body.tickets.map((x) => x.status), ['todo', 'todo', 'todo', 'todo', 'in_progress', 'done'],
    'To Do, then In Progress, then Done (not alphabetical)');
  assert.deepEqual(numbers(await get(s, s.dev, 'sort=priority')).slice(0, 3), [1, 3, 6]);
  assert.deepEqual(numbers(await get(s, s.dev, 'sort=due')), [5, 1, 4, 2, 3, 6], 'soonest first, undated last');
  assert.deepEqual(numbers(await get(s, s.dev, 'sort=newest')), [6, 5, 4, 3, 2, 1]);
});

test('pagination and validation', async () => {
  const s = await seeded();
  const p1 = await get(s, s.dev, 'sort=number&limit=4&page=1');
  assert.deepEqual(numbers(p1), [1, 2, 3, 4]);
  assert.deepEqual([p1.body.total, p1.body.page, p1.body.pages], [6, 1, 2]);
  assert.deepEqual(numbers(await get(s, s.dev, 'sort=number&limit=4&page=2')), [5, 6]);
  for (const bad of ['priority=urgent', 'type=story', 'sort=random', 'limit=0', 'limit=999', 'due=someday', 'assignee=bob', 'open=maybe']) {
    assert.equal((await get(s, s.dev, bad)).status, 400, bad);
  }
});

test('labels in use, most used first', async () => {
  const s = await seeded();
  const res = await t.api('GET', `/api/projects/${s.project.id}/labels`, { token: s.viewer.token });
  assert.deepEqual(res.body.labels, [{ label: 'checkout', count: 2 }, { label: 'safari', count: 1 }, { label: 'ui', count: 1 }]);
});

test('my work: open tickets assigned to me across projects, soonest due first', async () => {
  const a = await seeded();
  // The same developer in a second project.
  const other = await t.api('POST', '/api/projects', { token: a.dev.token, body: { name: 'Side', key: 'SIDE' } });
  await t.api('POST', `/api/projects/${other.body.project.id}/tickets`, { token: a.dev.token, body: { title: 'Side task', assigneeId: a.dev.user.id } });

  const res = await t.api('GET', '/api/me/tickets', { token: a.dev.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tickets.map((x) => x.key), [`${a.project.key}-1`, `${a.project.key}-3`, 'SIDE-1']);
  assert.equal(res.body.tickets[2].projectName, 'Side');
  assert.equal(res.body.total, 3);

  // Archived projects drop out.
  await t.api('POST', `/api/projects/${other.body.project.id}/archive`, { token: a.dev.token });
  assert.equal((await t.api('GET', '/api/me/tickets', { token: a.dev.token })).body.total, 2);
  const nobody = await t.signUp();
  assert.deepEqual((await t.api('GET', '/api/me/tickets', { token: nobody.token })).body, { tickets: [], total: 0, snoozedCount: 0 });
});

test('saved filters: personal or shared, run as a query, owner-only edits', async () => {
  const s = await seeded();
  const base = `/api/projects/${s.project.id}/filters`;
  const mine = await t.api('POST', base, { token: s.dev.token, body: { name: 'My open bugs', query: { assignee: 'me', type: 'bug', open: 'true' } } });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(mine.body.filter.shared, false);
  const shared = await t.api('POST', base, { token: s.admin.token, body: { name: 'Overdue', query: { due: 'overdue', sort: 'priority' }, shared: true } });
  await t.api('POST', base, { token: s.admin.token, body: { name: 'Admin only', query: { priority: 'critical' } } });

  // The viewer sees only the shared one; the developer sees theirs first.
  assert.deepEqual((await t.api('GET', base, { token: s.viewer.token })).body.filters.map((f) => f.name), ['Overdue']);
  const devList = (await t.api('GET', base, { token: s.dev.token })).body.filters;
  assert.deepEqual(devList.map((f) => [f.name, f.mine]), [['My open bugs', true], ['Overdue', false]]);

  // Running a saved filter = passing its query to the ticket list.
  const run = await get(s, s.dev, new URLSearchParams(mine.body.filter.query).toString());
  assert.deepEqual(numbers(run).sort(), [1, 3]);

  // Validation and names.
  assert.equal((await t.api('POST', base, { token: s.dev.token, body: { name: 'Bad', query: { priority: 'urgent' } } })).status, 400);
  assert.equal((await t.api('POST', base, { token: s.dev.token, body: { name: 'Bad', query: { page: '2' } } })).status, 400);
  assert.equal((await t.api('POST', base, { token: s.dev.token, body: { name: 'My open bugs', query: {} } })).body.error.code, 'name_taken');

  // Only the owner edits; managers (not developers) may remove a shared one.
  const sharedId = shared.body.filter.id;
  assert.equal((await t.api('PATCH', `${base}/${sharedId}`, { token: s.dev.token, body: { name: 'Mine now' } })).status, 403);
  const renamed = await t.api('PATCH', `${base}/${mine.body.filter.id}`, { token: s.dev.token, body: { name: 'Bugs on me', shared: true } });
  assert.equal(renamed.body.filter.name, 'Bugs on me');
  assert.equal((await t.api('DELETE', `${base}/${sharedId}`, { token: s.dev.token })).status, 403);
  assert.equal((await t.api('DELETE', `${base}/${sharedId}`, { token: s.admin.token })).status, 204);
  assert.equal((await t.api('DELETE', `${base}/${sharedId}`, { token: s.admin.token })).status, 404);
});
