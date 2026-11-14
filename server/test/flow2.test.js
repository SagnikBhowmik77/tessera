// Flow analytics II (E9): Monte Carlo forecast and what-if, next best ticket, WIP suggestions,
// estimate accuracy, rework, work mix, bottlenecks, standup, compare two dates, mosaic.
// Histories are written back-dated, exactly as the app records them (throwaway MongoDB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { Project, Ticket, TicketEvent } from '../src/models/index.js';
import { monteCarlo } from '../src/services/flow2.service.js';

let t;
before(async () => { t = await startTestServer(); __setTransport({ async sendMail() { return {}; } }); });
after(async () => { __setTransport(null); await t.stop(); });

const DAY = 24 * 3600 * 1000;
const ago = (d, h = 0) => new Date(Date.now() - d * DAY - h * 3600 * 1000);

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Flow', key: `FL${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  return { admin, dev, project: await Project.findById(body.project.id), url: `/api/projects/${body.project.id}` };
}

// A ticket with a back-dated history: created, then moves [daysAgo, from, to].
let seq = 0;
async function seed(project, { createdDaysAgo, moves = [], points = null, type = 'task', assignee = null, labels = [], priority = 'medium', dueDate = null, blockedSince = null, actor = null }) {
  seq += 1;
  const last = moves.at(-1);
  const status = last ? last[2] : 'todo';
  const doneAt = moves.filter(([, , to]) => to === 'done').at(-1)?.[0];
  const ticket = await Ticket.create({
    project: project._id, number: 1000 + seq, title: `T${seq}`, type, status, rank: `a${seq}`, storyPoints: points, assignee, labels, priority, dueDate, blockedSince,
    resolvedAt: status === 'done' && doneAt !== undefined ? ago(doneAt) : null,
  });
  await Ticket.collection.updateOne({ _id: ticket._id }, { $set: { createdAt: ago(createdDaysAgo) } });
  await TicketEvent.insertMany([
    { project: project._id, ticket: ticket._id, type: 'created', at: ago(createdDaysAgo), to: { status: 'todo' }, actor },
    ...moves.map(([d, from, to]) => ({ project: project._id, ticket: ticket._id, type: 'status_changed', from, to, at: ago(d), actor })),
  ]);
  return ticket.toObject();
}

test('Monte Carlo: deterministic, ordered percentiles, slower when the team is slower', () => {
  const samples = [0, 1, 2, 1, 0, 3, 1, 2, 0, 1];
  const a = monteCarlo({ samples, items: 20 });
  assert.deepEqual(a, monteCarlo({ samples, items: 20 }), 'same history, same answer');
  assert.ok(a.whenDone.p50 <= a.whenDone.p85 && a.whenDone.p85 <= a.whenDone.p95);
  const slow = monteCarlo({ samples, items: 20, factor: 0.5 });
  assert.ok(slow.whenDone.p85 > a.whenDone.p85);
  const many = monteCarlo({ samples, days: 14 });
  assert.ok(many.howMany.p95 <= many.howMany.p85 && many.howMany.p85 <= many.howMany.p50, 'more confidence, fewer items promised');
});

test('forecast: refuses on too little history, then dates with what-if', async () => {
  const ctx = await team();
  await seed(ctx.project, { createdDaysAgo: 3 });
  const thin = (await t.api('GET', `${ctx.url}/flow/forecast`, { token: ctx.dev.token })).body;
  assert.equal(thin.enough, false);
  assert.match(thin.reason, /a forecast needs at least 5/);
  for (let i = 0; i < 12; i += 1) await seed(ctx.project, { createdDaysAgo: 30, moves: [[25 - i * 2, 'todo', 'in_progress'], [24 - i * 2, 'in_progress', 'done']] });
  for (let i = 0; i < 5; i += 1) await seed(ctx.project, { createdDaysAgo: 2 });
  const f = (await t.api('GET', `${ctx.url}/flow/forecast?days=14`, { token: ctx.dev.token })).body;
  assert.equal(f.enough, true, JSON.stringify(f));
  assert.deepEqual([f.items, f.sample.finished, f.sample.days], [6, 12, 42]);
  assert.match(f.whenDone.p85.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(f.whenDone.p50.days <= f.whenDone.p85.days);
  assert.ok(typeof f.howMany.p85 === 'number');
  const more = (await t.api('GET', `${ctx.url}/flow/forecast?add=10`, { token: ctx.dev.token })).body;
  assert.equal(more.items, 16);
  assert.ok(more.whenDone.p85.days > f.whenDone.p85.days, 'more work takes longer');
  const faster = (await t.api('GET', `${ctx.url}/flow/forecast?factor=2`, { token: ctx.dev.token })).body;
  assert.ok(faster.whenDone.p85.days < f.whenDone.p85.days, 'a faster team finishes sooner');
  assert.equal((await t.api('GET', `${ctx.url}/flow/forecast?scope=sprint`, { token: ctx.dev.token })).body.error.code, 'no_active_sprint');
});

test('next best ticket: started work first, then what unblocks others and is overdue; blocked last', async () => {
  const ctx = await team();
  const me = ctx.dev.user.id;
  const started = await seed(ctx.project, { createdDaysAgo: 5, moves: [[2, 'todo', 'in_progress']], assignee: me });
  const overdue = await seed(ctx.project, { createdDaysAgo: 5, assignee: me, dueDate: ago(3), priority: 'high' });
  const blocked = await seed(ctx.project, { createdDaysAgo: 5, assignee: me, blockedSince: ago(1), priority: 'critical' });
  const free = await seed(ctx.project, { createdDaysAgo: 5 });
  await Ticket.updateOne({ _id: blocked._id }, { $set: { blockedBy: [free._id], blockedReason: 'waiting for the API' } });
  const next = (await t.api('GET', `${ctx.url}/flow/next`, { token: ctx.dev.token })).body.next;
  const k = (x) => `${ctx.project.key}-${x.number}`;
  assert.deepEqual(next.map((x) => x.key), [k(overdue), k(started), k(free), k(blocked)]);
  assert.ok(next[0].reasons.some((r) => r.startsWith('overdue since')));
  assert.ok(next[1].reasons.includes('you already started it'));
  assert.ok(next[2].reasons.includes(`unblocks ${k(blocked)}`) && next[2].reasons.includes('nobody owns it yet'));
  assert.ok(next[3].reasons.includes('blocked: waiting for the API'));
});

test('insights: WIP suggestion (Little\'s law), estimates, rework, work mix and bottleneck reasons', async () => {
  const ctx = await team();
  await Project.updateOne({ _id: ctx.project._id, 'statuses.key': 'in_progress' }, { $set: { 'statuses.$.wipLimit': 2 } });
  const project = await Project.findById(ctx.project._id);
  // 10 finished in the window; bigger estimates took longer.
  for (let i = 0; i < 10; i += 1) {
    await seed(project, { createdDaysAgo: 28, points: i < 5 ? 1 : 5, type: i % 2 ? 'bug' : 'feature', labels: ['checkout'], moves: [[20 - i, 'todo', 'in_progress'], [(20 - i) - (i < 5 ? 1 : 4), 'in_progress', 'done']] });
  }
  // One finished and then reopened (rework), now in progress, plus three more piled up there.
  await seed(project, { createdDaysAgo: 10, moves: [[8, 'todo', 'in_progress'], [6, 'in_progress', 'done'], [3, 'done', 'in_progress']] });
  for (let i = 0; i < 3; i += 1) await seed(project, { createdDaysAgo: 4, moves: [[3, 'todo', 'in_progress']] });
  const res = (await t.api('GET', `${ctx.url}/flow/insights`, { token: ctx.dev.token })).body;
  const w = res.wip.find((x) => x.status === 'in_progress');
  assert.ok(w, JSON.stringify(res.wip));
  assert.equal(w.now, 4);
  assert.match(w.reason, /Little's law/);
  assert.equal(res.estimates.tickets, 10);
  assert.deepEqual(res.estimates.groups.map((g) => [g.points, g.tickets]), [[1, 5], [5, 5]]);
  assert.equal(res.estimates.verdict, 'Bigger estimates did take longer.');
  assert.deepEqual([res.rework.finished, res.rework.reopened, res.rework.byHand], [11, 1, 1]);
  assert.equal(res.mix.labels[0].label, 'checkout');
  assert.ok(res.mix.weeks.reduce((s, x) => s + x.bug + x.feature, 0) >= 10);
  assert.ok(res.bottlenecks.some((b) => b.text === 'In Progress holds 4 tickets, over its limit of 2.'), JSON.stringify(res.bottlenecks));
});

test('standup, compare two dates and the mosaic', async () => {
  const ctx = await team();
  const me = ctx.dev.user.id;
  await seed(ctx.project, { createdDaysAgo: 5, assignee: me, moves: [[0, 'todo', 'done']], actor: me });
  await seed(ctx.project, { createdDaysAgo: 5, assignee: me, moves: [[3, 'todo', 'in_progress']] });
  const stuck = await seed(ctx.project, { createdDaysAgo: 5, assignee: me, moves: [[3, 'todo', 'in_progress']], blockedSince: ago(1) });
  await Ticket.updateOne({ _id: stuck._id }, { $set: { blockedReason: 'design review' } });
  const s = (await t.api('GET', `${ctx.url}/flow/standup`, { token: ctx.admin.token })).body;
  const dev = s.people.find((p) => p.name === 'Dev');
  assert.equal(dev.finished.length, 1);
  assert.equal(dev.today.length, 1);
  assert.match(dev.blocked[0], /design review/);
  assert.match(s.text, /\*Dev\*\nSince \d{4}-\d{2}-\d{2}: finished /);

  const from = ago(4).toISOString();
  const to = new Date().toISOString();
  const c = (await t.api('GET', `${ctx.url}/flow/compare?from=${from}&to=${to}`, { token: ctx.admin.token })).body;
  assert.equal(c.finished, 1);
  assert.equal(c.moved.length, 3);
  assert.deepEqual(c.columns.map((x) => [x.key, x.from, x.to]), [['todo', 3, 0], ['in_progress', 0, 2], ['done', 0, 1]]);
  assert.equal((await t.api('GET', `${ctx.url}/flow/compare?from=${to}&to=${from}`, { token: ctx.admin.token })).status, 400);

  const tiles = (await t.api('GET', `${ctx.url}/flow/mosaic`, { token: ctx.admin.token })).body.tiles;
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles.map((x) => x.category).sort(), ['done', 'in_progress', 'in_progress']);
  assert.equal(tiles.find((x) => x.blocked).key, `${ctx.project.key}-${stuck.number}`);
});
