// Columns, WIP limits, flow analytics and board time travel (throwaway MongoDB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestServer } from './helpers.js';
import { Project, Ticket, TicketEvent } from '../src/models/index.js';
import { addDays, startOfDayIn, todayIn } from '../src/dates.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const HOUR = 3600 * 1000;
const today = todayIn();
// A moment `dayOffset` days from today at `hour` o'clock India time.
const at = (dayOffset, hour) => new Date(startOfDayIn(addDays(today, dayOffset)).getTime() + hour * HOUR);

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const manager = await t.signUp('Manager');
  const dev = await t.signUp('Dev');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Flow', key: `FW${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: manager.user.id, role: 'manager' }, { user: dev.user.id, role: 'developer' }] } } });
  return { admin, manager, dev, project: body.project, base: `/api/projects/${body.project.id}` };
}

test('days start at midnight in the team time zone', () => {
  assert.equal(startOfDayIn('2026-11-05', 'Asia/Kolkata').toISOString(), '2026-11-04T18:30:00.000Z');
  assert.equal(startOfDayIn('2026-07-01', 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z', 'summer time');
  assert.equal(startOfDayIn('2026-12-01', 'America/New_York').toISOString(), '2026-12-01T05:00:00.000Z', 'winter time');
});

test('columns: rename keeps the key, add, reorder, set WIP limits, remove only when empty', async () => {
  const { base, admin, dev, manager } = await team();
  const put = (who, statuses) => t.api('PUT', `${base}/statuses`, { token: who.token, body: { statuses } });
  const cols = [
    { key: 'todo', name: 'Backlog', category: 'todo' },
    { key: 'in_progress', name: 'Doing', category: 'in_progress', wipLimit: 2 },
    { name: 'In Review', category: 'in_progress', wipLimit: 1 },
    { key: 'done', name: 'Shipped', category: 'done' },
  ];
  assert.equal((await put(dev, cols)).status, 403);
  const res = await put(manager, cols);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.project.statuses.map((s) => [s.key, s.name, s.wipLimit]), [
    ['todo', 'Backlog', null], ['in_progress', 'Doing', 2], ['in_review', 'In Review', 1], ['done', 'Shipped', null],
  ]);

  await t.api('POST', `${base}/tickets`, { token: admin.token, body: { title: 'Sits in review', status: 'in_review' } });
  const blocked = await put(admin, cols.filter((c) => c.name !== 'In Review'));
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.error.details, [{ key: 'in_review', name: 'In Review', count: 1 }]);

  const unknown = await put(admin, [{ key: 'todo', name: 'A', category: 'todo' }, { key: 'nope', name: 'B', category: 'done' }]);
  assert.equal(unknown.body.error.code, 'unknown_status');
  assert.equal((await put(admin, [{ key: 'todo', name: 'A', category: 'todo' }])).status, 400, 'at least two columns');
});

test('a board must keep a done column', async () => {
  const { base, admin } = await team();
  const res = await t.api('PUT', `${base}/statuses`, { token: admin.token, body: { statuses: [{ key: 'todo', name: 'A', category: 'todo' }, { key: 'in_progress', name: 'B', category: 'in_progress' }] } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_columns');
});

test('WIP limits block moves into a full column; managers can override, on the record', async () => {
  const { base, admin, manager, dev } = await team();
  await t.api('PUT', `${base}/statuses`, { token: admin.token, body: { statuses: [
    { key: 'todo', name: 'To Do', category: 'todo' },
    { key: 'in_progress', name: 'In Progress', category: 'in_progress', wipLimit: 2 },
    { key: 'done', name: 'Done', category: 'done' },
  ] } });
  for (const title of ['a', 'b', 'c', 'd']) await t.api('POST', `${base}/tickets`, { token: dev.token, body: { title } });
  const move = (who, n, body) => t.api('POST', `${base}/tickets/${n}/move`, { token: who.token, body: { status: 'in_progress', ...body } });

  assert.equal((await move(dev, 1)).status, 200);
  assert.equal((await move(dev, 2)).status, 200);
  const full = await move(dev, 3);
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'wip_limit');
  assert.match(full.body.error.message, /In Progress is at its limit of 2/);
  assert.equal((await move(dev, 1, { before: 2 })).status, 200, 'reordering inside the column is fine');
  assert.equal((await t.api('PATCH', `${base}/tickets/3`, { token: dev.token, body: { status: 'in_progress' } })).body.error.code, 'wip_limit');
  assert.equal((await t.api('POST', `${base}/tickets`, { token: dev.token, body: { title: 'e', status: 'in_progress' } })).body.error.code, 'wip_limit');

  assert.equal((await move(dev, 3, { overrideWip: true })).status, 403, 'developers cannot override');
  const over = await move(manager, 3, { overrideWip: true });
  assert.equal(over.status, 200);
  const event = await TicketEvent.findOne({ ticket: over.body.ticket.id, type: 'status_changed' }).lean();
  assert.equal(event.field, 'wip_override');

  const analytics = await t.api('GET', `${base}/analytics`, { token: dev.token });
  const ip = analytics.body.wip.find((w) => w.key === 'in_progress');
  assert.deepEqual([ip.count, ip.limit, ip.over], [3, 2, true]);
});

// A hand-built history over the last 10 days (times in India time):
//  #1 A: created D-10 09:00, In Progress D-8 09:00, Done D-6 09:00        -> cycle 2 d, lead 4 d
//  #2 B: created D-10 09:00, In Progress D-9, Done D-5, reopened D-4, Done D-3 -> cycle 6 d, lead 7 d
//  #3 C: created D-7 09:00, Done D-7 21:00 (never "in progress")            -> cycle 0.5 d, lead 0.5 d
//  #4 D: created D-9 09:00, untouched since                                 -> stale
//  #5 E: created D-9 09:00, In Progress D-2 09:00, deleted D-1 09:00
async function history() {
  const s = await team();
  const projectId = new mongoose.Types.ObjectId(s.project.id);
  const reporter = new mongoose.Types.ObjectId(s.admin.user.id);
  const dev = new mongoose.Types.ObjectId(s.dev.user.id);
  const ids = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
  const ticket = (i, title, status, createdAt, updatedAt, extra = {}) => ({
    _id: ids[i], project: projectId, number: i + 1, type: 'task', title, description: '', priority: 'medium', status,
    assignee: null, reporter, labels: [], dueDate: null, storyPoints: null, rank: `a${i}`, resolvedAt: null,
    deletedAt: null, error: null, createdAt, updatedAt, __v: 0, ...extra,
  });
  await Ticket.collection.insertMany([
    ticket(0, 'A', 'done', at(-10, 9), at(-6, 9), { priority: 'high', resolvedAt: at(-6, 9) }),
    ticket(1, 'B', 'done', at(-10, 9), at(-3, 9), { assignee: dev, resolvedAt: at(-3, 9) }),
    ticket(2, 'C', 'done', at(-7, 9), at(-7, 21), { resolvedAt: at(-7, 21) }),
    ticket(3, 'D', 'todo', at(-9, 9), at(-9, 9)),
    ticket(4, 'E', 'in_progress', at(-9, 9), at(-1, 9), { deletedAt: at(-1, 9) }),
  ]);
  await Project.updateOne({ _id: projectId }, { $set: { ticketCounter: 5 } });
  const ev = (i, type, when, extra = {}) => ({ project: projectId, ticket: ids[i], actor: reporter, source: 'app', type, field: null, from: null, to: null, at: when, ...extra });
  const moved = (i, from, to, when) => ev(i, 'status_changed', when, { from, to });
  await TicketEvent.collection.insertMany([
    ev(0, 'created', at(-10, 9), { to: { status: 'todo' } }),
    ev(1, 'created', at(-10, 9), { to: { status: 'todo' } }),
    moved(1, 'todo', 'in_progress', at(-9, 9)),
    ev(3, 'created', at(-9, 9), { to: { status: 'todo' } }),
    ev(4, 'created', at(-9, 9), { to: { status: 'todo' } }),
    moved(0, 'todo', 'in_progress', at(-8, 9)),
    ev(2, 'created', at(-7, 9), { to: { status: 'todo' } }),
    moved(2, 'todo', 'done', at(-7, 21)),
    moved(0, 'in_progress', 'done', at(-6, 9)),
    ev(0, 'updated', at(-6, 10), { field: 'priority', from: 'low', to: 'high' }),
    moved(1, 'in_progress', 'done', at(-5, 9)),
    moved(1, 'done', 'in_progress', at(-4, 9)),
    ev(1, 'assigned', at(-4, 10), { from: null, to: dev }),
    moved(1, 'in_progress', 'done', at(-3, 9)),
    moved(4, 'todo', 'in_progress', at(-2, 9)),
    ev(4, 'deleted', at(-1, 9)),
  ]);
  return s;
}

test('analytics: cycle and lead time, throughput, time in status, cumulative flow, stale work', async () => {
  const s = await history();
  const res = await t.api('GET', `${s.base}/analytics?from=${addDays(today, -10)}&to=${today}`, { token: s.dev.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const a = res.body;

  assert.deepEqual(a.range, { from: addDays(today, -10), to: today, timeZone: 'Asia/Kolkata' });
  const { points, ...cycle } = a.cycleTime;
  assert.deepEqual(cycle, { count: 3, medianDays: 2, p85Days: 6, averageDays: 2.8, medianHours: 48, p85Hours: 144, averageHours: 68 });
  assert.deepEqual(points.map((p) => [p.number, p.days, p.hours, p.skippedInProgress]), [[3, 0.5, 12, true], [1, 2, 48, false], [2, 6, 144, false]]);
  assert.deepEqual(a.leadTime, { count: 3, medianDays: 4, p85Days: 7, averageDays: 3.8, medianHours: 96, p85Hours: 168, averageHours: 92 });

  const done = Object.fromEntries(a.throughput.filter((d) => d.count).map((d) => [d.day, d.count]));
  assert.deepEqual(done, { [addDays(today, -7)]: 1, [addDays(today, -6)]: 1, [addDays(today, -3)]: 1 });
  assert.equal(a.throughput.length, 11);

  const ip = a.timeInStatus.find((x) => x.key === 'in_progress');
  assert.deepEqual([ip.totalHours, ip.tickets, ip.averageHours], [192, 3, 64]);

  const cfd = Object.fromEntries(a.cfd.days.map((d) => [d.day, d.counts]));
  assert.deepEqual(cfd[addDays(today, -10)], { todo: 2, in_progress: 0, done: 0 });
  assert.deepEqual(cfd[addDays(today, -8)], { todo: 2, in_progress: 2, done: 0 });
  assert.deepEqual(cfd[addDays(today, -7)], { todo: 2, in_progress: 2, done: 1 });
  assert.deepEqual(cfd[addDays(today, -4)], { todo: 2, in_progress: 1, done: 2 });
  assert.deepEqual(cfd[today], { todo: 1, in_progress: 0, done: 3 });

  assert.deepEqual(a.wip.map((w) => [w.key, w.count]), [['todo', 1], ['in_progress', 0], ['done', 3]]);
  assert.deepEqual(a.stale.map((x) => x.number), [4]);
  assert.ok(a.stale[0].idleDays >= 8);

  // A shorter range only counts what finished inside it.
  const recent = await t.api('GET', `${s.base}/analytics?from=${addDays(today, -6)}&to=${today}&staleDays=30`, { token: s.dev.token });
  assert.equal(recent.body.cycleTime.count, 2);
  assert.deepEqual(recent.body.stale, []);
});

test('analytics validation', async () => {
  const { base, dev } = await team();
  const q = (qs) => t.api('GET', `${base}/analytics?${qs}`, { token: dev.token });
  assert.equal((await q(`to=${addDays(today, 1)}`)).status, 400, 'no future');
  assert.equal((await q(`from=${today}&to=${addDays(today, -1)}`)).status, 400);
  assert.equal((await q(`from=${addDays(today, -400)}&to=${today}`)).status, 400, 'max one year');
  const empty = await q('');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.cycleTime.count, 0);
  assert.equal(empty.body.cycleTime.medianDays, null);
  assert.equal(empty.body.throughput.length, 30);
});

test('board time travel: columns, fields and assignees as they were', async () => {
  const s = await history();
  const board = async (when) => (await t.api('GET', `${s.base}/board-at?at=${encodeURIComponent(when)}`, { token: s.dev.token })).body;
  const cards = (b) => Object.fromEntries(b.columns.map((c) => [c.key, c.tickets.map((x) => x.number)]));

  const d7 = await board(addDays(today, -7));
  assert.deepEqual(cards(d7), { todo: [4, 5], in_progress: [1, 2], done: [3] });
  const a = d7.columns.find((c) => c.key === 'in_progress').tickets.find((x) => x.number === 1);
  assert.equal(a.priority, 'low', 'priority was raised to high later');
  assert.equal(a.key, `${s.project.key}-1`);
  assert.equal(d7.columns.find((c) => c.key === 'in_progress').tickets.find((x) => x.number === 2).assignee, null);

  const later = await board(at(-1, 12).toISOString());
  assert.deepEqual(cards(later), { todo: [4], in_progress: [], done: [1, 2, 3] }, 'E is in the bin by then');
  assert.equal(later.columns.find((c) => c.key === 'done').tickets.find((x) => x.number === 2).assignee.name, 'Dev');

  const before = await board(addDays(today, -20));
  assert.equal(before.total, 0);
  const now = await board(new Date().toISOString());
  assert.deepEqual(cards(now), cards(later));
  assert.equal((await t.api('GET', `${s.base}/board-at?at=${addDays(today, 3)}`, { token: s.dev.token })).status, 400);
  assert.equal((await t.api('GET', `${s.base}/board-at?at=yesterday`, { token: s.dev.token })).status, 400);
});
