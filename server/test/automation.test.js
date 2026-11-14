// Automation rules, service levels (SLA) and the project audit log (E4C), against a throwaway MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { startTestServer } from './helpers.js';
import { Project, Rule, Ticket, TicketEvent } from '../src/models/index.js';
import { checkSlaBreaches } from '../src/services/sla.service.js';
import { addDays, todayIn } from '../src/dates.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Auto', key: `AU${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, {
    $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } },
  });
  const base = `/api/projects/${body.project.id}`;
  const call = (method, path, payload, who = admin) => t.api(method, `${base}${path}`, { token: who.token, body: payload });
  return { admin, dev, viewer, project: body.project, base, call };
}
const HOUR = 3600 * 1000;

test('rules: saving is checked against the project; developers cannot set them up', async () => {
  const { dev, viewer, call } = await team();
  const rule = { name: 'Route bugs', trigger: { type: 'created' }, actions: [{ type: 'assign', value: dev.user.id }] };
  assert.equal((await call('POST', '/rules', rule, dev)).status, 403);
  assert.equal((await call('POST', '/rules', { ...rule, actions: [] })).body.error.details[0].message, 'Add at least one action');
  assert.equal((await call('POST', '/rules', { ...rule, actions: [{ type: 'assign', value: viewer.user.id }] })).body.error.message, "Viewers can't be assigned tickets");
  assert.equal((await call('POST', '/rules', { ...rule, actions: [{ type: 'move', value: 'nowhere' }] })).body.error.message, 'This project has no column "nowhere"');
  assert.equal((await call('POST', '/rules', { ...rule, trigger: { type: 'moved', status: 'done' }, actions: [{ type: 'move', value: 'done' }] })).body.error.code, 'rule_invalid');
  // Settings that don't belong to the trigger are dropped.
  const made = await call('POST', '/rules', { ...rule, trigger: { type: 'created', status: 'done', label: 'x' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.rule.trigger, { type: 'created', status: null, priority: null, label: null, kind: null });
  assert.equal((await call('GET', '/rules', undefined, viewer)).body.rules.length, 1);
});

test('rules: created + conditions assign and label; history names the rule; the new assignee is told', async () => {
  const { admin, dev, call } = await team();
  await call('POST', '/rules', {
    name: 'Route bugs to Dev',
    trigger: { type: 'created' },
    conditions: { types: ['bug'], unassigned: true },
    actions: [{ type: 'assign', value: dev.user.id }, { type: 'add_label', value: 'Triage' }, { type: 'due_in', value: 3 }],
  });
  const task = (await call('POST', '/tickets', { title: 'Write docs', type: 'task' })).body.ticket;
  assert.equal(task.assignee, null);
  const bug = (await call('POST', '/tickets', { title: 'Crash on save', type: 'bug' })).body.ticket;
  assert.equal(bug.assignee.id, dev.user.id);
  assert.deepEqual(bug.labels, ['triage']);
  assert.equal(bug.dueDate, addDays(todayIn('Asia/Kolkata'), 3));
  const auto = (await call('GET', `/tickets/${bug.key}/history`)).body.events.filter((e) => e.source === 'automation');
  assert.deepEqual(auto.map((e) => e.type), ['assigned', 'updated', 'updated']);
  assert.equal(auto[0].rule.name, 'Route bugs to Dev');
  assert.equal(auto[0].actor, null);
  const inbox = (await t.api('GET', '/api/notifications', { token: dev.token })).body.notifications;
  assert.equal(inbox[0].type, 'assigned');
  assert.equal(inbox[0].excerpt, 'Automation rule: Route bugs to Dev');
  const [rule] = (await call('GET', '/rules', undefined, admin)).body.rules;
  assert.equal(rule.runs, 1);
  assert.equal(rule.lastRun.ticketKey, bug.key);
});

test('rules: moved / priority / label triggers, run in order, never chain, disabled ones skipped', async () => {
  const { call } = await team();
  const a = (await call('POST', '/rules', { name: 'Done means low', trigger: { type: 'moved', status: 'done' }, actions: [{ type: 'set_priority', value: 'low' }] })).body.rule;
  // Would fire on the priority change above if rules chained; they don't.
  await call('POST', '/rules', { name: 'Low gets a label', trigger: { type: 'priority_changed', priority: 'low' }, actions: [{ type: 'add_label', value: 'chained' }] });
  await call('POST', '/rules', { name: 'Hotfix to critical', trigger: { type: 'label_added', label: 'hotfix' }, actions: [{ type: 'set_priority', value: 'critical' }] });
  const off = (await call('POST', '/rules', { name: 'Off', enabled: false, trigger: { type: 'created' }, actions: [{ type: 'add_label', value: 'off' }] })).body.rule;

  const tk = (await call('POST', '/tickets', { title: 'One' })).body.ticket;
  assert.deepEqual(tk.labels, []);
  const moved = await call('PATCH', `/tickets/${tk.key}`, { status: 'done' });
  assert.equal(moved.body.ticket.priority, 'low');
  assert.deepEqual(moved.body.ticket.labels, []);
  const labelled = await call('PATCH', `/tickets/${tk.key}`, { labels: ['hotfix'] });
  assert.equal(labelled.body.ticket.priority, 'critical');
  // Created with the label counts as the label being added.
  assert.equal((await call('POST', '/tickets', { title: 'Two', labels: ['hotfix'] })).body.ticket.priority, 'critical');
  // A person changing priority does start rules.
  const tk3 = (await call('POST', '/tickets', { title: 'Three' })).body.ticket;
  assert.deepEqual((await call('PATCH', `/tickets/${tk3.key}`, { priority: 'low' })).body.ticket.labels, ['chained']);

  // Board drag counts as a move too.
  const tk4 = (await call('POST', '/tickets', { title: 'Four', priority: 'high' })).body.ticket;
  assert.equal((await call('POST', `/tickets/${tk4.key}/move`, { status: 'done' })).body.ticket.priority, 'low');

  // Reordering needs every rule once.
  const rules = (await call('GET', '/rules')).body.rules;
  assert.equal((await call('PUT', '/rules/order', { ids: [a.id] })).body.error.code, 'rule_order');
  const order = (await call('PUT', '/rules/order', { ids: rules.map((r) => r.id).reverse() })).body.rules;
  assert.equal(order[0].id, off.id);
  assert.equal((await call('PATCH', `/rules/${off.id}`, { enabled: true })).body.rule.enabled, true);
  assert.equal((await call('DELETE', `/rules/${off.id}`)).status, 204);
});

test('rules: an action that cannot run is skipped and recorded on the rule, the change still saves', async () => {
  const { call, project } = await team();
  await call('PUT', '/statuses', {
    statuses: [
      { key: 'todo', name: 'To Do', category: 'todo' },
      { key: 'in_progress', name: 'In Progress', category: 'in_progress', wipLimit: 1 },
      { key: 'done', name: 'Done', category: 'done' },
    ],
  });
  await call('POST', '/rules', { name: 'Start bugs', trigger: { type: 'created' }, conditions: { types: ['bug'] }, actions: [{ type: 'move', value: 'in_progress' }, { type: 'add_label', value: 'auto' }] });
  const first = (await call('POST', '/tickets', { title: 'Bug 1', type: 'bug' })).body.ticket;
  assert.equal(first.status, 'in_progress');
  const second = await call('POST', '/tickets', { title: 'Bug 2', type: 'bug' });
  assert.equal(second.status, 201);
  assert.equal(second.body.ticket.status, 'todo');
  assert.deepEqual(second.body.ticket.labels, ['auto']);
  const rule = await Rule.findOne({ project: project.id }).lean();
  assert.equal(rule.runs, 2);
  assert.match(rule.lastError.message, /In Progress is at its limit of 1/);
  assert.equal(rule.lastError.ticketKey, second.body.ticket.key);
});

test('SLA: targets are checked; tickets carry their clocks; first response by comment or by starting work', async () => {
  const { admin, dev, call } = await team();
  assert.equal((await call('PUT', '/sla', { enabled: true, targets: [] })).body.error.code, 'sla_empty');
  assert.equal((await call('PUT', '/sla', { enabled: true, targets: [{ priority: 'high', responseHours: 10, resolveHours: 2 }] })).body.error.code, 'sla_order');
  assert.equal((await call('PUT', '/sla', { enabled: true, targets: [{ priority: 'high', responseHours: 2 }, { priority: 'high', resolveHours: 2 }] })).body.error.code, 'duplicate_priority');
  assert.equal((await call('PUT', '/sla', { enabled: true, targets: [{ priority: 'high', responseHours: 1.5 }] })).body.error.details[0].message, 'Whole hours only');
  const saved = await call('PUT', '/sla', { enabled: true, targets: [{ priority: 'high', responseHours: 4, resolveHours: 24 }, { priority: 'low', responseHours: null, resolveHours: null }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.sla.targets.length, 1);

  const low = (await call('POST', '/tickets', { title: 'Low', priority: 'low' })).body.ticket;
  assert.equal(low.sla, null);
  const high = (await call('POST', '/tickets', { title: 'High', priority: 'high' })).body.ticket;
  assert.equal(high.sla.response.state, 'running');
  assert.equal(high.sla.response.hours, 4);
  assert.equal(new Date(high.sla.resolve.dueAt) - new Date(high.createdAt), 24 * HOUR);

  // The reporter commenting on their own ticket is not a response; someone else is.
  await call('POST', `/tickets/${high.key}/comments`, { body: 'Any news?' }, admin);
  assert.equal((await call('GET', `/tickets/${high.key}`)).body.ticket.sla.response.doneAt, null);
  await call('POST', `/tickets/${high.key}/comments`, { body: 'Looking now' }, dev);
  assert.equal((await call('GET', `/tickets/${high.key}`)).body.ticket.sla.response.state, 'met');

  const started = (await call('POST', '/tickets', { title: 'High 2', priority: 'high' })).body.ticket;
  const moved = (await call('PATCH', `/tickets/${started.key}`, { status: 'in_progress' })).body.ticket;
  assert.equal(moved.sla.response.state, 'met');
  assert.equal(moved.sla.resolve.state, 'running');
  assert.equal((await call('PATCH', `/tickets/${started.key}`, { status: 'done' })).body.ticket.sla.resolve.state, 'met');
});

test('SLA: breaches are alerted once, written to history, run SLA rules; old breaches are not alerted', async () => {
  const { admin, dev, call } = await team();
  const old = (await call('POST', '/tickets', { title: 'Old', priority: 'high' })).body.ticket;
  await Ticket.collection.updateOne({ _id: new Types.ObjectId(old.id) }, { $set: { createdAt: new Date(Date.now() - 10 * HOUR) } });
  await call('PUT', '/sla', { enabled: true, targets: [{ priority: 'high', responseHours: 2, resolveHours: 48 }] });
  await call('POST', '/rules', { name: 'Escalate', trigger: { type: 'sla_breached', kind: 'response' }, actions: [{ type: 'set_priority', value: 'critical' }, { type: 'add_label', value: 'escalated' }] });

  const fresh = (await call('POST', '/tickets', { title: 'Fresh', priority: 'high', assigneeId: dev.user.id })).body.ticket;
  const unassigned = (await call('POST', '/tickets', { title: 'Nobody', priority: 'high' }, dev)).body.ticket;
  await Ticket.collection.updateMany({ _id: { $in: [fresh.id, unassigned.id].map((id) => new Types.ObjectId(id)) } }, { $set: { createdAt: new Date(Date.now() - 3 * HOUR) } });

  // At risk: under a quarter of the time left.
  const risky = (await call('POST', '/tickets', { title: 'Risky', priority: 'high' })).body.ticket;
  await Ticket.collection.updateOne({ _id: new Types.ObjectId(risky.id) }, { $set: { createdAt: new Date(Date.now() - 1.75 * HOUR) } });
  assert.deepEqual((await call('GET', '/tickets?sla=at_risk')).body.tickets.map((x) => x.title), ['Risky']);
  assert.deepEqual((await call('GET', '/tickets?sla=breached')).body.tickets.map((x) => x.title).sort(), ['Fresh', 'Nobody', 'Old']);

  const handled = await checkSlaBreaches();
  assert.deepEqual(handled.map((h) => h.number).sort(), [fresh.number, unassigned.number].sort());
  assert.deepEqual(await checkSlaBreaches(), []);

  const after = (await call('GET', `/tickets/${fresh.key}`)).body.ticket;
  assert.equal(after.priority, 'critical');
  assert.deepEqual(after.labels, ['escalated']);
  const events = (await call('GET', `/tickets/${fresh.key}/history`)).body.events;
  const breach = events.find((e) => e.type === 'sla_breached');
  assert.equal(breach.field, 'response');
  assert.equal(breach.source, 'sla');
  assert.equal(events.at(-1).rule.name, 'Escalate');
  const devInbox = (await t.api('GET', '/api/notifications', { token: dev.token })).body.notifications.filter((n) => n.type === 'sla_breached');
  assert.deepEqual(devInbox.map((n) => [n.ticketKey, n.excerpt]), [[fresh.key, 'First response target of 2 hours missed']]);
  // Unassigned: the managers and admins hear about it.
  const adminInbox = (await t.api('GET', '/api/notifications', { token: admin.token })).body.notifications.filter((n) => n.type === 'sla_breached');
  assert.deepEqual(adminInbox.map((n) => n.ticketKey), [unassigned.key]);
  assert.equal(await TicketEvent.countDocuments({ ticket: old.id, type: 'sla_breached' }), 0);

  const report = (await call('GET', '/sla/report')).body;
  assert.equal(report.enabled, true);
  // The rule raised Fresh and Nobody to critical, which has no target here: Old and Risky remain.
  assert.equal(report.rows.find((r) => r.priority === 'high').tickets, 2);
  assert.deepEqual(report.breached.map((b) => b.key), [old.key]);
});

test('audit log: setup changes are recorded with who and what; developers cannot read it', async () => {
  const { admin, dev, call, base } = await team();
  await call('PATCH', `/members/${dev.user.id}`, { role: 'manager' });
  await call('PUT', '/fields', { fields: [{ name: 'Customer', type: 'text' }] });
  const rule = (await call('POST', '/rules', { name: 'Tag bugs', trigger: { type: 'created' }, actions: [{ type: 'add_label', value: 'bug' }] })).body.rule;
  await call('DELETE', `/rules/${rule.id}`);
  await call('POST', '/tickets', { title: 'A' });
  const one = (await call('POST', '/tickets', { title: 'B' })).body.ticket;
  await call('POST', '/tickets/bulk', { tickets: [one.number], changes: { priority: 'high' } });
  // CSV, not JSON: fetched directly.
  assert.equal((await fetch(`${t.base}${base}/tickets/export`, { headers: { authorization: `Bearer ${admin.token}` } })).status, 200);
  await call('POST', '/rules', { name: 'Bad', trigger: { type: 'created' }, actions: [] });
  await call('PATCH', `/members/${dev.user.id}`, { role: 'developer' });

  assert.equal((await call('GET', '/audit', undefined, dev)).status, 403);
  const { entries } = (await call('GET', '/audit', undefined, admin)).body;
  assert.deepEqual(entries.map((e) => e.action), [
    'member.role_changed', 'tickets.exported', 'tickets.bulk_changed', 'rule.deleted', 'rule.created', 'fields.changed', 'member.role_changed', 'project.created',
  ]);
  const byAction = Object.fromEntries(entries.map((e) => [e.action, e]));
  assert.equal(entries.at(-2).target, `Dev (${dev.email})`);
  assert.deepEqual(entries.at(-2).details, { role: 'manager' });
  assert.equal(entries.at(-2).actor.name, 'Admin');
  assert.equal(byAction['rule.deleted'].target, 'Tag bugs');
  assert.deepEqual(byAction['tickets.bulk_changed'].details, { action: 'update', tickets: 1, done: 1, failed: 0, changes: ['priority'] });
  assert.deepEqual(byAction['tickets.exported'].details, { count: 2 });
  assert.deepEqual(byAction['fields.changed'].details, { fields: ['Customer'] });
  // The area filter narrows the list.
  assert.deepEqual((await call('GET', '/audit?area=automation')).body.entries.map((e) => e.action), ['rule.deleted', 'rule.created']);
});
