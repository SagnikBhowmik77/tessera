// Search language, project setup templates, the label list, card layouts and the setup checklist
// (E4D), against a throwaway MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project } from '../src/models/index.js';
import { tokenize } from '../src/services/searchql.service.js';
import { addDays, todayIn } from '../src/dates.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function team(body = {}) {
  const admin = await t.signUp('Admin Person');
  const dev = await t.signUp('Asha Rao');
  keyN += 1;
  const res = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Setup', key: `SE${keyN}`, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await Project.updateOne({ _id: res.body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  const base = `/api/projects/${res.body.project.id}`;
  const call = (method, path, payload, who = admin) => t.api(method, `${base}${path}`, { token: who.token, body: payload });
  return { admin, dev, project: res.body.project, base, call };
}
const titles = (r) => r.body.tickets.map((x) => x.title).sort();
const search = (call, q) => call('GET', `/tickets?q=${encodeURIComponent(q)}&limit=100`);

test('search language: tokens, quotes, negation; unknown keys stay as words', () => {
  assert.deepEqual(tokenize('type:bug,feature  -label:"won\'t fix" checkout http://x.io page'), {
    tokens: [
      { key: 'type', negate: false, raw: 'bug,feature', values: ['bug', 'feature'] },
      { key: 'label', negate: true, raw: "won't fix", values: ["won't fix"] },
    ],
    text: 'checkout http://x.io page',
  });
  assert.deepEqual(tokenize('plain words').tokens, []);
});

test('search language: filters narrow the list and are described in words', async () => {
  const { admin, dev, call, base } = await team();
  const today = todayIn('Asia/Kolkata');
  await call('POST', '/tickets', { title: 'Checkout crash', type: 'bug', priority: 'critical', assigneeId: admin.user.id, dueDate: addDays(today, 2), labels: ['payments'] });
  await call('POST', '/tickets', { title: 'Login crash', type: 'bug', priority: 'high', assigneeId: dev.user.id, dueDate: addDays(today, 20) });
  await call('POST', '/tickets', { title: 'Write docs', type: 'task', priority: 'low', labels: ['docs'] });
  const old = (await call('POST', '/tickets', { title: 'Old feature', type: 'feature', priority: 'medium' })).body.ticket;
  await call('PATCH', `/tickets/${old.key}`, { status: 'in_progress' });

  let r = await search(call, 'type:bug assignee:me due:<7d');
  assert.deepEqual(titles(r), ['Checkout crash']);
  assert.deepEqual(r.body.search.understood, ['type is bug', 'assigned to me', `due before 7 days from today (${addDays(today, 7)})`]);
  assert.equal(r.body.search.mode, 'filters');

  assert.deepEqual(titles(await search(call, 'priority:>=high')), ['Checkout crash', 'Login crash']);
  assert.deepEqual(titles(await search(call, 'type:bugs -label:payments')), ['Login crash']);
  assert.deepEqual(titles(await search(call, 'assignee:asha')), ['Login crash']);
  assert.deepEqual(titles(await search(call, 'is:unassigned')), ['Old feature', 'Write docs']);
  assert.deepEqual(titles(await search(call, 'status:"in progress"')), ['Old feature']);
  assert.deepEqual(titles(await search(call, 'status:todo,done type:task')), ['Write docs']);
  assert.deepEqual(titles(await search(call, 'due:none is:open')), ['Old feature', 'Write docs']);
  assert.deepEqual(titles(await search(call, 'created:<1d label:docs')), ['Write docs']);
  assert.deepEqual(titles(await search(call, 'created:>30d')), []);
  // Words and filters together.
  r = await search(call, 'type:bug login');
  assert.deepEqual(titles(r), ['Login crash']);
  assert.equal(r.body.search.mode, 'words');

  // Mistakes are explained and left out, never guessed.
  r = await search(call, 'type:bug assignee:zed due:soonish');
  assert.deepEqual(titles(r), ['Checkout crash', 'Login crash']);
  assert.deepEqual(r.body.search.problems, [
    'assignee:zed: no member matches "zed"',
    'due:soonish: try due:<7d, due:>2w, due:2026-11-30, due:overdue, due:today, due:week or due:none',
  ]);
  assert.match((await search(call, 'status:review')).body.search.problems[0], /no column called "review" \(columns: To Do, In Progress, Done\)/);
  assert.equal((await search(call, 'sla:breached')).body.search.problems[0], 'sla:breached: service levels are off in this project');

  // CSV export honours the same language.
  const csv = await fetch(`${t.base}${base}/tickets/export?q=${encodeURIComponent('type:task')}`, { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(csv.headers.get('x-export-count'), '1');
});

test('setup templates: columns and labels only; the label list feeds pickers', async () => {
  const list = await t.api('GET', '/api/projects/setup-templates', { token: (await t.signUp('Someone')).token });
  assert.deepEqual(list.body.templates.map((x) => x.key), ['kanban', 'scrum', 'bugs', 'support', 'content']);
  const { project, call, dev } = await team({ template: 'bugs' });
  assert.deepEqual(project.statuses.map((s) => s.name), ['New', 'Confirmed', 'Fixing', 'Verifying', 'Fixed', "Won't fix"]);
  assert.equal(project.statuses.find((s) => s.key === 'fixing').wipLimit, 5);
  assert.equal(project.ticketCounter, 0);
  assert.deepEqual(project.suggestedLabels, ['crash', 'ui', 'performance', 'regression', 'needs-info']);
  assert.equal((await t.api('POST', '/api/projects', { token: dev.token, body: { name: 'X', key: 'XZ', template: 'nope' } })).status, 400);

  await call('POST', '/tickets', { title: 'A', labels: ['ui'] });
  assert.deepEqual((await call('GET', '/labels')).body.labels.slice(0, 2), [{ label: 'ui', count: 1 }, { label: 'crash', count: 0 }]);
  assert.equal((await call('PUT', '/labels', { labels: ['x'] }, dev)).status, 403);
  assert.deepEqual((await call('PUT', '/labels', { labels: ['Mobile', 'mobile', 'web'] })).body.labels, ['mobile', 'web']);
});

test('card layout: known parts and up to 3 custom fields', async () => {
  const { project, call } = await team();
  assert.ok(project.cardFields.includes('assignee'));
  assert.ok(!project.cardFields.includes('points'));
  await call('PUT', '/fields', { fields: [{ name: 'Customer', type: 'text' }, { name: 'A', type: 'text' }, { name: 'B', type: 'text' }, { name: 'C', type: 'text' }] });
  assert.equal((await call('PUT', '/card-layout', { fields: ['key', 'nonsense'] })).body.error.message, 'Unknown card parts: nonsense');
  assert.equal((await call('PUT', '/card-layout', { fields: ['field:customer', 'field:a', 'field:b', 'field:c'] })).body.error.code, 'card_layout');
  assert.deepEqual((await call('PUT', '/card-layout', { fields: ['key', 'points', 'field:customer', 'key'] })).body.fields, ['key', 'points', 'field:customer']);
});

test('setup checklist: worked out from the real project; can be put away and brought back', async () => {
  const { call, admin, dev } = await team();
  const done = async () => Object.fromEntries((await call('GET', '/setup')).body.steps.map((s) => [s.key, s.done]));
  // The developer was added straight to the project, so "invite" is already done.
  assert.deepEqual(await done(), { columns: false, labels: false, invite: true, ticket: false, assign: false, automate: false, finish: false });
  await call('PUT', '/statuses', { statuses: [
    { key: 'todo', name: 'To Do', category: 'todo' }, { key: 'in_progress', name: 'Doing', category: 'in_progress' }, { key: 'done', name: 'Done', category: 'done' },
  ] });
  const tk = (await call('POST', '/tickets', { title: 'First', labels: ['x'], assigneeId: dev.user.id })).body.ticket;
  await call('PATCH', `/tickets/${tk.key}`, { status: 'done' });
  await call('POST', '/templates', { name: 'T', title: 'T' });
  assert.deepEqual(await done(), { columns: true, labels: true, invite: true, ticket: true, assign: true, automate: true, finish: true });

  assert.equal((await call('POST', '/setup/dismiss', undefined, dev)).status, 403);
  assert.ok((await call('POST', '/setup/dismiss', undefined, admin)).body.dismissedAt);
  assert.equal((await call('DELETE', '/setup/dismiss')).body.dismissedAt, null);
  const audit = (await call('GET', '/audit?area=setup')).body.entries.map((e) => e.action);
  assert.deepEqual(audit.slice(0, 2), ['checklist.restored', 'checklist.dismissed']);
  assert.equal(audit.at(-1), 'project.created');
});
