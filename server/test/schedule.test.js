// Scheduling (E3C): ticket start dates for the timeline, the scheduled filter, and leave.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Leave, Project } from '../src/models/index.js';
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
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Schedule', key: `SC${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  const base = `/api/projects/${body.project.id}`;
  return { admin, dev, base, url: `${base}/tickets` };
}

test('start dates: set on create and edit, never after the due date, recorded in history', async () => {
  const { admin, url } = await team();
  const bad = await t.api('POST', url, { token: admin.token, body: { title: 'Backwards', startDate: '2026-12-10', dueDate: '2026-12-01' } });
  assert.equal(bad.status, 400);
  const made = await t.api('POST', url, { token: admin.token, body: { title: 'Card form', startDate: '2026-12-01', dueDate: '2026-12-10' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.ticket.startDate, '2026-12-01');
  const key = made.body.ticket.key;

  // Moving only the start past the stored due date is refused too.
  const late = await t.api('PATCH', `${url}/${key}`, { token: admin.token, body: { startDate: '2026-12-11' } });
  assert.equal(late.body.error.code, 'dates_order');
  const ok = await t.api('PATCH', `${url}/${key}`, { token: admin.token, body: { startDate: '2026-12-03' } });
  assert.equal(ok.body.ticket.startDate, '2026-12-03');
  const cleared = await t.api('PATCH', `${url}/${key}`, { token: admin.token, body: { startDate: null } });
  assert.equal(cleared.body.ticket.startDate, null);

  const events = (await t.api('GET', `${url}/${key}/history`, { token: admin.token })).body.events.filter((e) => e.field === 'startDate');
  assert.deepEqual(events.map((e) => [e.from, e.to]), [['2026-12-01', '2026-12-03'], ['2026-12-03', null]]);
});

test('scheduled filter: tickets with a start or due date, or neither', async () => {
  const { admin, url } = await team();
  const mk = async (title, extra) => (await t.api('POST', url, { token: admin.token, body: { title, ...extra } })).body.ticket.key;
  const a = await mk('Only due', { dueDate: '2026-12-05' });
  const b = await mk('Only start', { startDate: '2026-12-01' });
  const c = await mk('Neither', {});
  const keys = async (q) => (await t.api('GET', `${url}?sort=number&${q}`, { token: admin.token })).body.tickets.map((x) => x.key);
  assert.deepEqual(await keys('scheduled=true'), [a, b]);
  assert.deepEqual(await keys('scheduled=false'), [c]);
});

test('leave: add, no overlaps, only your own to delete, visible to your projects only, gone with the account', async () => {
  const { admin, dev, base } = await team();
  const outsider = await t.signUp('Outsider');
  const from = addDays(today(), 3);
  const to = addDays(today(), 5);
  const add = (who, body) => t.api('POST', '/api/me/leave', { token: who.token, body });

  const made = await add(dev, { from, to, note: 'Diwali' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.leave.from, made.body.leave.to, made.body.leave.days, made.body.leave.note], [from, to, 3, 'Diwali']);
  assert.equal((await add(dev, { from: addDays(today(), 5), to: addDays(today(), 8) })).body.error.code, 'leave_overlap');
  assert.equal((await add(dev, { from: to, to: from })).body.error.code, 'leave_dates');
  assert.equal((await add(dev, { from: addDays(today(), -200), to: addDays(today(), -150) })).body.error.code, 'leave_too_old');
  await add(outsider, { from, to });

  // The project sees its members' leave in the range asked for, not outsiders'.
  const range = (f, tt) => t.api('GET', `${base}/leave?from=${f}&to=${tt}`, { token: admin.token });
  const seen = (await range(today(), addDays(today(), 30))).body.leave;
  assert.deepEqual(seen.map((l) => [l.user.name, l.from, l.to]), [['Dev', from, to]]);
  assert.equal(seen[0].user.email, undefined, 'teammates see the name, not the email');
  assert.deepEqual((await range(addDays(today(), 6), addDays(today(), 30))).body.leave, []);
  assert.equal((await t.api('GET', `${base}/leave?from=${today()}&to=${today()}`, { token: outsider.token })).status, 404);

  // Someone else's leave can't be deleted; your own can.
  const id = made.body.leave.id;
  assert.equal((await t.api('DELETE', `/api/me/leave/${id}`, { token: admin.token })).status, 404);
  assert.deepEqual((await t.api('GET', '/api/me/leave', { token: dev.token })).body.leave.map((l) => l.id), [id]);
  assert.equal((await t.api('DELETE', `/api/me/leave/${id}`, { token: dev.token })).status, 204);

  await add(dev, { from, to });
  assert.equal(await Leave.countDocuments({ user: dev.user.id }), 1);
  assert.equal((await t.api('DELETE', '/api/auth/me', { token: dev.token, body: { password: dev.password } })).status, 200);
  assert.equal(await Leave.countDocuments({ user: dev.user.id }), 0);
});
