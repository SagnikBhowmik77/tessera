// Custom fields, ticket templates and recurring tickets (E4B), against a throwaway MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../src/csv.js';
import { Project, Recurrence, Ticket } from '../src/models/index.js';
import { indexOnOrAfter, nextOnOrAfter, occurrence, runDueRecurrences } from '../src/services/template.service.js';
import { addDays, todayIn } from '../src/dates.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const today = () => todayIn('Asia/Kolkata');
let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Custom', key: `CU${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  const base = `/api/projects/${body.project.id}`;
  const call = (method, path, payload, who = admin) => t.api(method, `${base}${path}`, { token: who.token, body: payload });
  return { admin, dev, project: body.project, base, call };
}

test('custom fields: define, fill, validate, history, rename keeps values, removals clear values', async () => {
  const { dev, call, base, admin } = await team();
  assert.equal((await call('PUT', '/fields', { fields: [{ name: 'Customer', type: 'text' }] }, dev)).status, 403);
  const defs = [
    { name: 'Customer', type: 'text' },
    { name: 'Environment', type: 'select', options: ['Production', 'Staging'] },
    { name: 'Revenue at risk', type: 'number' },
    { name: 'Go-live', type: 'date' },
    { name: 'Needs design', type: 'checkbox' },
    { name: 'Spec', type: 'url' },
  ];
  const set = await call('PUT', '/fields', { fields: defs });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.fields.map((f) => f.key), ['customer', 'environment', 'revenue_at_risk', 'go_live', 'needs_design', 'spec']);
  assert.equal((await call('PUT', '/fields', { fields: [{ name: 'A', type: 'text' }, { name: 'a', type: 'number' }] })).body.error.code, 'duplicate_field');
  assert.equal((await call('PUT', '/fields', { fields: [{ name: 'Pick', type: 'select', options: [] }] })).body.error.code, 'field_options');

  const made = await call('POST', '/tickets', { title: 'Checkout fails', fields: { customer: 'Acme', environment: 'production', revenue_at_risk: '120000', needs_design: true } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.ticket.fields, { customer: 'Acme', environment: 'Production', revenue_at_risk: 120000, needs_design: true });
  const key = made.body.ticket.key;

  const bad = await call('PATCH', `/tickets/${key}`, { fields: { environment: 'Moon' } });
  assert.equal(bad.body.error.code, 'field_invalid');
  assert.match(bad.body.error.message, /^Environment: choose one of Production, Staging/);
  assert.equal((await call('PATCH', `/tickets/${key}`, { fields: { spec: 'javascript:alert(1)' } })).body.error.code, 'field_invalid');
  assert.equal((await call('PATCH', `/tickets/${key}`, { fields: { go_live: '2026-02-30' } })).body.error.code, 'field_invalid');
  assert.equal((await call('PATCH', `/tickets/${key}`, { fields: { nope: 'x' } })).body.error.code, 'unknown_field');

  const ok = await call('PATCH', `/tickets/${key}`, { fields: { go_live: '2026-12-15', spec: 'https://example.com/spec', customer: null } });
  assert.deepEqual(ok.body.ticket.fields, { environment: 'Production', revenue_at_risk: 120000, needs_design: true, go_live: '2026-12-15', spec: 'https://example.com/spec' });
  const history = (await call('GET', `/tickets/${key}/history`)).body.events.filter((e) => e.field?.startsWith('fields.'));
  assert.deepEqual(history.map((e) => [e.field, e.from, e.to]), [
    ['fields.go_live', null, '2026-12-15'], ['fields.spec', null, 'https://example.com/spec'], ['fields.customer', 'Acme', null],
  ]);

  // CSV export has a column per field.
  const csv = parseCsv(await (await fetch(`${t.base}${base}/tickets/export`, { headers: { authorization: `Bearer ${admin.token}` } })).text());
  const row = Object.fromEntries(csv[0].map((h, i) => [h, csv[1][i]]));
  assert.deepEqual([row.Environment, row['Revenue at risk'], row['Needs design'], row['Go-live']], ['Production', '120000', 'yes', '2026-12-15']);

  // Rename keeps values; changing a type is refused; dropping an option or a field clears values.
  const current = (await Project.findById(made.body.ticket.project).lean()).customFields;
  assert.equal((await call('PUT', '/fields', { fields: current.map((f) => (f.key === 'spec' ? { ...f, type: 'text' } : f)) })).body.error.code, 'field_type_change');
  const renamed = current.map((f) => (f.key === 'environment' ? { ...f, name: 'Where', options: ['Staging'] } : f)).filter((f) => f.key !== 'needs_design');
  assert.equal((await call('PUT', '/fields', { fields: renamed })).status, 200);
  const after = (await call('GET', `/tickets/${key}`)).body.ticket.fields;
  assert.deepEqual(after, { revenue_at_risk: 120000, go_live: '2026-12-15', spec: 'https://example.com/spec' });
});

test('templates: managers keep them; a ticket from one gets its defaults and sub-tasks', async () => {
  const { dev, call } = await team();
  const body = {
    name: 'New hire setup', title: 'Set up a new teammate', description: '## Before day one\n- Laptop', type: 'task', priority: 'high',
    labels: ['onboarding'], storyPoints: 3, subtasks: ['Create accounts', 'Order laptop', 'Book intro meetings'],
  };
  assert.equal((await call('POST', '/templates', body, dev)).status, 403);
  const tpl = (await call('POST', '/templates', body)).body.template;
  assert.equal(tpl.subtasks.length, 3);
  assert.equal((await call('POST', '/templates', { ...body, name: 'new HIRE setup' })).body.error.code, 'template_exists');
  assert.equal((await call('GET', '/templates', undefined, dev)).body.templates.length, 1);

  // A developer uses it; what they type wins.
  const made = await call('POST', '/tickets', { templateId: tpl.id, title: 'Set up Priya', priority: 'high' }, dev);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.subtasks, 3);
  const ticket = made.body.ticket;
  assert.deepEqual([ticket.title, ticket.priority, ticket.labels, ticket.storyPoints, ticket.description], ['Set up Priya', 'high', ['onboarding'], 3, '## Before day one\n- Laptop']);
  const rel = (await call('GET', `/tickets/${ticket.key}/relations`)).body.relations;
  assert.deepEqual(rel.subtasks.map((s) => s.title), ['Create accounts', 'Order laptop', 'Book intro meetings']);

  // No title: the template's is used.
  assert.equal((await call('POST', '/tickets', { templateId: tpl.id }, dev)).body.ticket.title, 'Set up a new teammate');
  assert.equal((await call('PATCH', `/templates/${tpl.id}`, { subtasks: [] })).body.template.subtasks.length, 0);
  assert.equal((await call('DELETE', `/templates/${tpl.id}`)).status, 204);
});

test('schedules: every N days, weeks on the same weekday, months on the same day (clamped)', () => {
  const weekly = { every: 'week', interval: 1, anchor: '2026-11-09' }; // a Monday
  assert.equal(nextOnOrAfter(weekly, '2026-11-10'), '2026-11-16');
  assert.equal(nextOnOrAfter(weekly, '2026-11-16'), '2026-11-16');
  const fortnightly = { every: 'week', interval: 2, anchor: '2026-11-09' };
  assert.equal(nextOnOrAfter(fortnightly, '2026-11-10'), '2026-11-23');
  const monthly = { every: 'month', interval: 1, anchor: '2026-10-31' };
  assert.deepEqual([1, 2, 3, 4].map((k) => occurrence(monthly, k)), ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  const daily = { every: 'day', interval: 3, anchor: '2026-11-01' };
  assert.equal(nextOnOrAfter(daily, '2026-11-08'), '2026-11-10');
  assert.equal(indexOnOrAfter(daily, '2026-10-01'), 0);
});

test('recurring tickets: created on their day, never twice, missed runs counted, paused with a reason', async () => {
  const { admin, dev, call, project } = await team();
  const tpl = (await call('POST', '/templates', { name: 'Weekly deps', title: 'Update dependencies', subtasks: ['Run audit'] })).body.template;
  const first = addDays(today(), 1);
  const made = await call('POST', '/recurring', { templateId: tpl.id, assigneeId: dev.user.id, every: 'week', firstDay: first, dueInDays: 2 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const rec = made.body.recurring;
  assert.equal(rec.nextRun, first);
  assert.equal((await call('POST', '/recurring', { templateId: tpl.id, every: 'week', firstDay: first }, dev)).status, 403);
  assert.equal((await call('DELETE', `/templates/${tpl.id}`)).body.error.code, 'template_in_use');

  // Not due yet today; due tomorrow.
  assert.equal((await runDueRecurrences(today())).filter((c) => c.recurrence === rec.id).length, 0);
  const created = (await runDueRecurrences(first)).filter((c) => c.recurrence === rec.id);
  assert.equal(created.length, 1);
  const ticket = await Ticket.findOne({ project: project.id, number: created[0].number }).lean();
  assert.match(ticket.title, /^Update dependencies · \d{1,2} \w{3} \d{4}$/);
  assert.equal(String(ticket.assignee), dev.user.id);
  assert.equal(ticket.dueDate.toISOString().slice(0, 10), addDays(first, 2));
  assert.equal(ticket.source, 'recurring');
  assert.equal(await Ticket.countDocuments({ parent: ticket._id }), 1, 'the template sub-task came along');
  assert.equal((await runDueRecurrences(first)).filter((c) => c.recurrence === rec.id).length, 0, 'never twice for the same day');

  // Asleep for three weeks: one ticket for the latest run, two counted as missed.
  const later = addDays(first, 7 * 3);
  const caught = (await runDueRecurrences(later)).filter((c) => c.recurrence === rec.id);
  assert.deepEqual(caught.map((c) => [c.day, c.missed]), [[later, 2]]);
  const listed = (await call('GET', '/recurring')).body.recurring[0];
  assert.deepEqual([listed.lastRun.day, listed.lastRun.missed, listed.nextRun], [later, 2, addDays(later, 7)]);

  // "Create now" doesn't move the schedule.
  assert.equal((await call('POST', `/recurring/${rec.id}/run`)).status, 201);
  assert.equal((await Recurrence.findById(rec.id).lean()).nextRun, addDays(later, 7));

  // The owner becomes a viewer: the next run pauses itself with a reason; resuming takes it over.
  await Project.updateOne({ _id: project.id, 'members.user': admin.user.id }, { $set: { 'members.$.role': 'viewer' } });
  await runDueRecurrences(addDays(later, 7));
  const paused = await Recurrence.findById(rec.id).lean();
  assert.equal(paused.active, false);
  assert.match(paused.pausedReason, /can no longer create tickets/);
  await Project.updateOne({ _id: project.id, 'members.user': admin.user.id }, { $set: { 'members.$.role': 'admin' } });
  const resumed = (await call('PATCH', `/recurring/${rec.id}`, { active: true })).body.recurring;
  assert.deepEqual([resumed.active, resumed.pausedReason], [true, null]);
  assert.ok(resumed.nextRun >= today(), 'resuming starts from today, no catch-up burst');
  assert.equal((await call('DELETE', `/recurring/${rec.id}`)).status, 204);
});
