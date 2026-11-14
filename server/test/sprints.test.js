// Sprints, the retro report and milestones (E3B), against a throwaway MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project, Sprint, TicketEvent } from '../src/models/index.js';
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
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Sprints', key: `SP${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, {
    $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } },
  });
  const base = `/api/projects/${body.project.id}`;
  const url = `${base}/tickets`;
  const call = (method, path, payload, token = admin.token) => t.api(method, `${base}${path}`, { token, body: payload });
  const mk = async (title, extra = {}) => (await t.api('POST', url, { token: admin.token, body: { title, ...extra } })).body.ticket;
  const plan = (key, sprint) => t.api('PUT', `${url}/${key}/sprint`, { token: admin.token, body: { sprint } });
  return { admin, dev, viewer, project: body.project, base, url, call, mk, plan };
}

const today = () => todayIn('Asia/Kolkata');

test('sprint lifecycle: plan, start (one at a time), complete with unfinished work carried over', async () => {
  const { dev, viewer, url, call, mk, plan } = await team();
  assert.equal((await call('POST', '/sprints', {}, dev.token)).status, 403, 'developers do not plan sprints');
  const created = await call('POST', '/sprints', { goal: 'Take card payments', startDate: today(), endDate: addDays(today(), 13) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const s1 = created.body.sprint;
  assert.equal(s1.name, 'Sprint 1');
  assert.equal(s1.state, 'planned');
  const s2 = (await call('POST', '/sprints', { name: 'Hardening' })).body.sprint;

  assert.equal((await call('POST', '/sprints', { startDate: today(), endDate: addDays(today(), -1) })).body.error.code, 'sprint_dates');
  assert.equal((await call('POST', '/sprints', { startDate: today(), endDate: addDays(today(), 60) })).body.error.code, 'sprint_too_long');
  assert.equal((await call('POST', `/sprints/${s1.id}/start`)).body.error.code, 'sprint_empty');

  const a = await mk('Card form', { storyPoints: 3 });
  const b = await mk('3-D Secure', { storyPoints: 5 });
  const epic = await mk('Payments', { type: 'epic' });
  assert.equal((await plan(a.key, s1.id)).body.ticket.sprint, s1.id);
  await plan(b.key, s1.id);
  assert.equal((await plan(epic.key, s1.id)).body.error.code, 'epic_in_sprint');
  assert.equal((await t.api('PUT', `${url}/${a.key}/sprint`, { token: viewer.token, body: { sprint: null } })).status, 403);

  assert.equal((await call('POST', `/sprints/${s2.id}/start`)).body.error.code, 'sprint_dates');
  const started = await call('POST', `/sprints/${s1.id}/start`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.sprint.state, 'active');
  await call('PATCH', `/sprints/${s2.id}`, { startDate: today(), endDate: addDays(today(), 6) });
  await plan(a.key, s2.id);
  assert.equal((await call('POST', `/sprints/${s2.id}/start`)).body.error.code, 'sprint_running');
  await plan(a.key, s1.id);
  assert.equal((await call('DELETE', `/sprints/${s1.id}`)).body.error.code, 'sprint_not_planned');
  assert.equal((await call('PATCH', `/sprints/${s1.id}`, { startDate: addDays(today(), 1) })).body.error.code, 'sprint_started');

  // The board can show just the running sprint, or the backlog.
  const c = await mk('Receipts email');
  const keys = async (q) => (await t.api('GET', `${url}?sort=number&${q}`, { token: dev.token })).body.tickets.map((x) => x.key);
  assert.deepEqual(await keys('sprint=active'), [a.key, b.key]);
  assert.deepEqual(await keys('sprint=none&type=task'), [c.key]);

  await call('PATCH', `/tickets/${a.key}`, { status: 'done' });
  const done = await call('POST', `/sprints/${s1.id}/complete`, { carryTo: 'new' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.completed, 1);
  assert.equal(done.body.unfinished, 1);
  const next = done.body.carriedTo;
  assert.equal(next.name, 'Sprint 3');
  assert.equal(next.state, 'planned');
  assert.equal((await t.api('GET', `${url}/${b.key}`, { token: dev.token })).body.ticket.sprint, next.id);
  assert.equal((await t.api('GET', `${url}/${a.key}`, { token: dev.token })).body.ticket.sprint, s1.id, 'finished work stays with its sprint');
  assert.equal((await plan(c.key, s1.id)).body.error.code, 'sprint_closed');

  const listed = (await call('GET', '/sprints', undefined, viewer.token)).body;
  assert.deepEqual(listed.sprints.map((s) => [s.name, s.state]), [['Hardening', 'planned'], ['Sprint 3', 'planned'], ['Sprint 1', 'closed']]);
  assert.deepEqual(listed.velocity, [{ id: s1.id, name: 'Sprint 1', committed: 2, committedPoints: 8, completed: 1, completedPoints: 3 }]);
  const closed = listed.sprints.find((s) => s.id === s1.id);
  assert.deepEqual([closed.tickets, closed.done, closed.points, closed.pointsDone, closed.carriedTo], [2, 1, 8, 3, next.id]);

  // A planned sprint can be deleted; its tickets go back to the backlog, and the history says so.
  assert.equal((await call('DELETE', `/sprints/${next.id}`)).status, 204);
  assert.equal((await t.api('GET', `${url}/${b.key}`, { token: dev.token })).body.ticket.sprint, null);
  const moves = (await t.api('GET', `${url}/${b.key}/history`, { token: dev.token })).body.events
    .filter((e) => e.type === 'relation_changed' && e.field === 'sprint');
  assert.deepEqual(moves.map((e) => [e.from?.name ?? null, e.to?.name ?? null]), [[null, 'Sprint 1'], ['Sprint 1', 'Sprint 3'], ['Sprint 3', null]]);
});

test('retro report: committed vs added mid-sprint, removed, finished, slipped, where work waited, burndown', async () => {
  const { url, call, mk, plan } = await team();
  const H = 3600e3;
  const D = 24 * H;
  const t0 = Date.now() - 3 * D;
  const a = await mk('Card form', { storyPoints: 3 });
  const b = await mk('3-D Secure', { storyPoints: 5 });
  const c = await mk('Receipts', { storyPoints: 2 });
  const d = await mk('Refunds', { storyPoints: 1 });
  const sprint = (await call('POST', '/sprints', { startDate: todayIn('Asia/Kolkata', new Date(t0)), endDate: addDays(today(), 3) })).body.sprint;
  await plan(a.key, sprint.id);
  await plan(b.key, sprint.id);
  assert.equal((await call('GET', `/sprints/${sprint.id}/report`)).body.error.code, 'sprint_not_started');
  await call('POST', `/sprints/${sprint.id}/start`);

  // Wind the clock back: the sprint started three days ago with A and B in it.
  await Sprint.updateOne({ _id: sprint.id }, { $set: { startedAt: new Date(t0) } });
  await TicketEvent.updateMany({ ticket: { $in: [a.id, b.id, c.id, d.id] } }, { $set: { at: new Date(t0 - H) } });
  // Puts the newest event of that kind on `ticket` at a moment in the past.
  const stamp = async (ticket, type, at) => {
    const e = await TicketEvent.findOne({ ticket, type }).sort({ _id: -1 });
    await TicketEvent.updateOne({ _id: e._id }, { $set: { at: new Date(at) } });
  };

  await plan(c.key, sprint.id); await stamp(c.id, 'relation_changed', t0 + D); // added mid-sprint
  await plan(d.key, sprint.id); await stamp(d.id, 'relation_changed', t0 + D);
  await plan(d.key, null); await stamp(d.id, 'relation_changed', t0 + 2 * D); // and taken out again
  await call('PATCH', `/tickets/${a.key}`, { status: 'in_progress' }); await stamp(a.id, 'status_changed', t0 + D);
  await call('PATCH', `/tickets/${a.key}`, { status: 'done' }); await stamp(a.id, 'status_changed', t0 + 2 * D);
  await call('PUT', `/tickets/${b.key}/flag`, { reason: 'Waiting for the bank' }); await stamp(b.id, 'blocked', t0 + D);

  const res = await call('GET', `/sprints/${sprint.id}/report`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body.report;
  assert.equal(r.unit, 'points');
  assert.deepEqual(r.summary, {
    committed: { count: 2, points: 8 },
    added: { count: 2, points: 3 },
    removed: { count: 1, points: 1 },
    completed: { count: 1, points: 3 },
    unfinished: { count: 2, points: 7 },
  });
  assert.deepEqual(r.added.map((x) => x.key), [c.key, d.key]);
  assert.deepEqual(r.removed.map((x) => x.key), [d.key]);
  assert.deepEqual(r.completed.map((x) => x.key), [a.key]);
  assert.deepEqual(r.unfinished.map((x) => x.key).sort(), [b.key, c.key].sort());

  // A sat in progress for a day; B has been blocked for about two days.
  const inProgress = r.waited.find((w) => w.status === 'in_progress');
  assert.ok(Math.abs(inProgress.hours - 24) < 0.1, `in progress ${inProgress.hours}h`);
  assert.ok(r.waited.find((w) => w.status === 'todo').hours > 100);
  assert.ok(Math.abs(r.blocked.totalHours - 48) < 0.2, `blocked ${r.blocked.totalHours}h`);
  assert.equal(r.blocked.byReason[0].reason, 'Waiting for the bank');
  assert.equal(r.blocked.tickets[0].key, b.key);
  assert.ok(r.unfinished.find((x) => x.key === b.key).blockedHours > 47);

  // Burndown: 8 points on the first day; 7 left today (B and C).
  assert.equal(r.burndown[0].remaining, 8);
  assert.equal(r.burndown[0].ideal, 8);
  const lastReal = r.burndown.filter((p) => p.remaining !== null).at(-1);
  assert.equal(lastReal.day, today());
  assert.equal(lastReal.remaining, 7);
  assert.equal(r.burndown.at(-1).ideal, 0);

  // Closing it to the backlog: the report keeps describing it as it ended.
  await call('POST', `/sprints/${sprint.id}/complete`, { carryTo: 'backlog' });
  const closed = (await call('GET', `/sprints/${sprint.id}/report`)).body.report;
  assert.equal(closed.sprint.state, 'closed');
  assert.deepEqual(closed.summary.unfinished, { count: 2, points: 7 });
  assert.deepEqual(closed.summary.removed, { count: 1, points: 1 }, 'the carry-over at close is not counted as removed');
  assert.equal(closed.carriedTo, null);
  assert.equal((await t.api('GET', `${url}/${b.key}`, { token: (await t.signUp('Nobody')).token })).status, 404);
});

test('milestones: progress from their tickets, overdue, closing, deleting keeps the tickets', async () => {
  const { dev, url, call, mk } = await team();
  assert.equal((await call('POST', '/milestones', { name: 'Beta' }, dev.token)).status, 403);
  const beta = (await call('POST', '/milestones', { name: 'Public beta', dueDate: addDays(today(), 10) })).body.milestone;
  assert.equal(beta.dueDate, addDays(today(), 10));
  assert.equal((await call('POST', '/milestones', { name: 'public BETA' })).body.error.code, 'milestone_exists');
  const late = (await call('POST', '/milestones', { name: 'Pilot', dueDate: addDays(today(), -2) })).body.milestone;

  const a = await mk('Sign-up', { storyPoints: 2 });
  const b = await mk('Billing', { storyPoints: 3 });
  assert.equal((await t.api('PUT', `${url}/${a.key}/milestone`, { token: dev.token, body: { milestone: beta.id } })).status, 403,
    'developers change only tickets they reported or are assigned to');
  const put = (key, milestone) => call('PUT', `/tickets/${key}/milestone`, { milestone });
  assert.equal((await put(a.key, beta.id)).body.ticket.milestone, beta.id);
  await put(b.key, beta.id);
  await call('PATCH', `/tickets/${a.key}`, { status: 'done' });
  await put(b.key, late.id);

  let list = (await call('GET', '/milestones', undefined, dev.token)).body.milestones;
  assert.deepEqual(list.map((m) => m.name), ['Pilot', 'Public beta']);
  const [pilot, pub] = list;
  assert.deepEqual(pub.progress, { total: 1, done: 1, points: 2, pointsDone: 2 });
  assert.equal(pub.daysLeft, 10);
  assert.equal(pilot.overdue, true);
  assert.equal(pilot.daysLeft, -2);

  const keys = async (q) => (await t.api('GET', `${url}?sort=number&${q}`, { token: dev.token })).body.tickets.map((x) => x.key);
  assert.deepEqual(await keys(`milestone=${late.id}`), [b.key]);

  await call('PATCH', `/milestones/${beta.id}`, { closed: true });
  assert.equal((await put(b.key, beta.id)).body.error.code, 'milestone_closed');
  list = (await call('GET', '/milestones')).body.milestones;
  assert.equal(list.at(-1).name, 'Public beta', 'closed milestones go last');
  assert.ok(list.at(-1).closedAt);

  assert.equal((await call('DELETE', `/milestones/${late.id}`)).status, 204);
  const ticket = (await t.api('GET', `${url}/${b.key}`, { token: dev.token })).body.ticket;
  assert.equal(ticket.milestone, null);
  assert.equal(ticket.title, 'Billing');
});
