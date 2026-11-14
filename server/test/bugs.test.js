// Bug intelligence through the API (throwaway MongoDB; emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Project, TicketEvent } from '../src/models/index.js';

let t;
let outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await jsonTransport.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
});
after(async () => { __setTransport(null); await t.stop(); });

const TRACE = (hash = '4f9a2c1e', line = 120) => `TypeError: Cannot read properties of undefined (reading 'total')
    at calculateTotal (https://shop.example.com/assets/checkout.${hash}.js:${line}:31)
    at onSubmit (https://shop.example.com/assets/checkout.${hash}.js:88:12)`;
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Bugs', key: `BG${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  return { admin, dev, viewer, project: body.project, url: `/api/projects/${body.project.id}/tickets` };
}

test('paste preview: parsed error, a ready title and description, not seen before', async () => {
  const { viewer, url } = await team();
  const res = await t.api('POST', `${url}/parse-error`, { token: viewer.token, body: { text: TRACE(), userAgent: CHROME_WIN } });
  assert.equal(res.status, 200);
  assert.equal(res.body.error.language, 'javascript');
  assert.deepEqual(res.body.error.environment, { browser: 'Chrome 130', os: 'Windows' });
  assert.equal(res.body.suggested.title, "TypeError: Cannot read properties of undefined (reading 'total')");
  assert.equal(res.body.suggested.type, 'bug');
  assert.match(res.body.suggested.description, /\*\*Where:\*\* `calculateTotal \(https:\/\/shop\.example\.com\/assets\/checkout\.4f9a2c1e\.js:120:31\)`/);
  assert.match(res.body.suggested.description, /\*\*Environment:\*\* Chrome 130 on Windows/);
  assert.match(res.body.suggested.description, /```text\nTypeError/);
  assert.equal(res.body.seenBefore, null);
  assert.equal((await t.api('POST', `${url}/parse-error`, { token: viewer.token, body: { text: '   ' } })).status, 400);
});

test('creating from an error; the same error again is grouped, not duplicated', async () => {
  const { dev, admin, url, project } = await team();
  const first = await t.api('POST', url, { token: dev.token, body: { errorText: TRACE(), userAgent: CHROME_WIN, assigneeId: dev.user.id } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const ticket = first.body.ticket;
  assert.deepEqual([first.body.grouped, ticket.type, ticket.number], [false, 'bug', 1]);
  assert.equal(ticket.title, "TypeError: Cannot read properties of undefined (reading 'total')");
  assert.equal(ticket.error.occurrences, 1);
  assert.equal(ticket.error.frames[0].fn, 'calculateTotal');
  assert.match(ticket.error.fingerprint, /^[0-9a-f]{40}$/);

  // Next deploy: new build hash and line numbers, same bug, reported by someone else.
  const again = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('9b8c7d6e', 133), title: 'Checkout broken again' } });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.grouped, again.body.regression, again.body.ticket.number], [true, false, 1]);
  assert.equal(again.body.ticket.error.occurrences, 2);
  assert.equal(again.body.ticket.title, ticket.title, 'the existing ticket keeps its title');

  const preview = await t.api('POST', `${url}/parse-error`, { token: dev.token, body: { text: TRACE('aaaaaaaa', 5) } });
  assert.deepEqual(preview.body.seenBefore, { number: 1, key: `${project.key}-1`, title: ticket.title, status: 'todo', type: 'bug', occurrences: 2, muted: false });
  assert.equal(await TicketEvent.countDocuments({ ticket: ticket.id, type: 'error_recurred' }), 1);

  // A different error is its own ticket.
  const other = await t.api('POST', url, { token: dev.token, body: { errorText: 'ValueError: invalid literal for int() with base 10' } });
  assert.deepEqual([other.status, other.body.ticket.number], [201, 2]);
});

test('a finished bug that comes back is reopened and its owner is told (regression)', async () => {
  const { dev, admin, url, project } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE(), assigneeId: dev.user.id } });
  await t.api('POST', `${url}/1/move`, { token: dev.token, body: { status: 'done' } });
  await flushNotifications();
  outbox = [];

  const back = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('1234abcd', 140) } });
  assert.equal(back.status, 200);
  assert.deepEqual([back.body.grouped, back.body.regression], [true, true]);
  assert.equal(back.body.ticket.status, 'todo');
  assert.equal(back.body.ticket.resolvedAt, null);
  await flushNotifications();

  const inbox = (await t.api('GET', '/api/notifications', { token: dev.token })).body.notifications;
  assert.equal(inbox[0].type, 'regression');
  assert.equal(inbox[0].ticketKey, `${project.key}-1`);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].subject, `${project.key}-1 came back (the same error was reported again by Admin): ${back.body.ticket.title}`);
  const history = (await t.api('GET', `${url}/1/history`, { token: dev.token })).body.events.map((e) => e.type);
  assert.deepEqual(history.slice(-2), ['error_recurred', 'status_changed']);
});

test('errors in the bin do not swallow new reports', async () => {
  const { admin, url } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  await t.api('DELETE', `${url}/1`, { token: admin.token });
  const fresh = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  assert.deepEqual([fresh.status, fresh.body.ticket.number, fresh.body.grouped], [201, 2, false]);
});

test('error groups: one row per distinct crash, most recent first', async () => {
  const { admin, url, project, viewer } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  await t.api('POST', url, { token: admin.token, body: { errorText: 'KeyError: user_id' } });
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('ffffffff', 1) } });
  await t.api('POST', url, { token: admin.token, body: { title: 'Plain task' } });
  const res = await t.api('GET', `/api/projects/${project.id}/errors`, { token: viewer.token });
  assert.deepEqual(res.body.errors.map((e) => [e.key, e.occurrences, e.errorType]), [
    [`${project.key}-1`, 2, 'TypeError'],
    [`${project.key}-2`, 1, 'KeyError'],
  ]);
  assert.equal(res.body.errors[0].resolved, false);
});

test('duplicate warning while typing', async () => {
  const { admin, dev, url } = await team();
  for (const title of ['Checkout crashes on Safari', 'Add dark mode to settings', 'Payment fails with coupon']) {
    await t.api('POST', url, { token: admin.token, body: { title } });
  }
  const res = await t.api('POST', `${url}/similar`, { token: dev.token, body: { title: 'safari checkout crash' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.similar[0].number, 1);
  assert.ok(res.body.similar[0].because.includes('safari'));
  assert.equal(res.body.similar.some((s) => s.number === 2), false);
  // While editing ticket 1 it doesn't match itself.
  const self = await t.api('POST', `${url}/similar`, { token: dev.token, body: { title: 'Checkout crashes on Safari', exclude: 1 } });
  assert.equal(self.body.similar.some((s) => s.number === 1), false);
  assert.equal((await t.api('POST', `${url}/similar`, { token: dev.token, body: { title: '' } })).status, 400);
});

test('validation: a title or an error is needed; viewers still cannot create', async () => {
  const { dev, viewer, url } = await team();
  const none = await t.api('POST', url, { token: dev.token, body: { priority: 'high' } });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.details[0].field, 'title');
  assert.equal((await t.api('POST', url, { token: viewer.token, body: { errorText: TRACE() } })).status, 403);
  assert.equal((await t.api('POST', url, { token: dev.token, body: { errorText: 'x'.repeat(50_001) } })).status, 400);
});
