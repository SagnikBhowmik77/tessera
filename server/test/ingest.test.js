// Crash capture (E6A): ingest keys, the public ingest endpoint and the tessera.js SDK
// (throwaway MongoDB; emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { ErrorOccurrence, Project, Ticket } from '../src/models/index.js';

let t;
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail() { return {}; } });
});
after(async () => { __setTransport(null); await t.stop(); });

const V8 = `TypeError: Cannot read properties of undefined (reading 'total')
    at calculateTotal (https://shop.example.com/assets/checkout.4f9a2c1e.js:120:31)
    at onSubmit (https://shop.example.com/assets/checkout.4f9a2c1e.js:88:12)`;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `IN${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  return { admin, dev, project: body.project, base: `/api/projects/${body.project.id}` };
}

// Like a browser's simple request: text/plain body, optional Origin.
const send = (body, { origin, ua = CHROME, raw } = {}) => fetch(`${t.base}/api/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain', 'user-agent': ua, ...(origin && { origin }) },
  body: raw ?? JSON.stringify(body),
}).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));

test('ingest keys: managers make them, the key is shown once, never stored or listed in full', async () => {
  const { admin, dev, base, project } = await team();
  assert.equal((await t.api('POST', `${base}/ingest-keys`, { token: dev.token, body: { name: 'Web' } })).status, 403);
  assert.equal((await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Web', origins: ['shop.example.com'] } })).status, 400);
  const made = await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Shop website', origins: ['https://Shop.example.com/'] } });
  assert.equal(made.status, 201);
  assert.match(made.body.key, /^tsk_[A-Za-z0-9_-]{32}$/);
  assert.equal(made.body.ingestKey.prefix, made.body.key.slice(0, 12));
  assert.deepEqual(made.body.ingestKey.origins, ['https://shop.example.com']);
  assert.equal(made.body.sdkUrl, 'http://localhost:8740/sdk/tessera.js');
  assert.equal(made.body.endpoint, 'http://localhost:8740/api/ingest');

  const list = (await t.api('GET', `${base}/ingest-keys`, { token: admin.token })).body;
  assert.equal(JSON.stringify(list).includes(made.body.key), false, 'the full key is never listed');
  assert.equal(JSON.stringify(list).includes('keyHash'), false);
  const stored = await Project.findById(project.id).lean();
  assert.equal(JSON.stringify(stored).includes(made.body.key), false, 'only a hash is stored');
  assert.equal((await t.api('GET', base, { token: dev.token })).body.project.ingestKeys, undefined);

  const revoked = await t.api('DELETE', `${base}/ingest-keys/${made.body.ingestKey.id}`, { token: admin.token });
  assert.ok(revoked.body.ingestKey.revokedAt);
  const audit = (await t.api('GET', `${base}/audit`, { token: admin.token })).body.entries.map((e) => e.action);
  assert.deepEqual(audit.slice(0, 2), ['ingest_key.revoked', 'ingest_key.created']);
});

test('a crash from an app: a triage ticket with what the SDK sent; repeats are counted', async () => {
  const { admin, base, project } = await team();
  const { key } = (await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Web' } })).body;

  // CORS for every website, no preflight needed for text/plain, nothing about the project in the answer.
  const pre = await fetch(`${t.base}/api/ingest`, { method: 'OPTIONS', headers: { origin: 'https://anywhere.example' } });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [204, '*']);
  const first = await send({ key, type: 'TypeError', message: "Cannot read properties of undefined (reading 'total')", stack: V8, url: 'https://shop.example.com/cart?token=secret#pay', release: '1.4.2', environment: 'production', user: 'customer-881' }, { origin: 'https://shop.example.com' });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual(first.body, { received: true });
  assert.equal(first.headers.get('access-control-allow-origin'), '*');

  const ticket = await Ticket.findOne({ project: project.id }).lean();
  assert.deepEqual([ticket.source, ticket.triage, ticket.type, ticket.error.language], ['sdk', true, 'bug', 'javascript']);
  assert.equal(ticket.error.frames[0].fn, 'calculateTotal');
  assert.deepEqual(ticket.error.environment, { browser: 'Chrome 130', os: 'Windows' });
  const occ = await ErrorOccurrence.findOne({ ticket: ticket._id }).lean();
  assert.deepEqual([occ.source, occ.release, occ.appEnvironment, occ.page], ['sdk', '1.4.2', 'production', 'https://shop.example.com/cart']);
  assert.match(occ.who, /^sdk:[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(occ).includes('customer-881'), false);

  // Firefox gives frames only: the error line is put in front so it still parses and groups.
  const firefox = 'calculateTotal@https://shop.example.com/assets/checkout.9b8c7d6e.js:133:31\nonSubmit@https://shop.example.com/assets/checkout.9b8c7d6e.js:88:12';
  const again = await send({ key, type: 'TypeError', message: "can't access property \"total\", cart is undefined", stack: firefox, release: '1.4.3' });
  assert.equal(again.status, 202);
  const after = await Ticket.find({ project: project.id }).lean();
  assert.equal(after.length, 1, 'same crash from Firefox and Chrome is one ticket');
  assert.equal(after[0].error.occurrences, 2);

  await flushNotifications();
  const inbox = (await t.api('GET', '/api/notifications', { token: admin.token })).body.notifications.filter((n) => n.type === 'crash_new');
  assert.equal(inbox.length, 1, 'managers hear about a new crash once, not every repeat');
  assert.equal(inbox[0].excerpt, 'release 1.4.2');
  const keys = (await t.api('GET', `${base}/ingest-keys`, { token: admin.token })).body.keys;
  assert.equal(keys[0].received, 2);
  assert.ok(keys[0].lastUsedAt);
  const { insights } = (await t.api('GET', `${base}/tickets/1/error/insights`, { token: admin.token })).body;
  assert.deepEqual(insights.environments.releases.map((r) => r.name), ['1.4.2', '1.4.3']);
});

test('refused: unknown or revoked keys, other websites, bad bodies; archived projects ignored', async () => {
  const { admin, base } = await team();
  const open = (await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Server' } })).body;
  const locked = (await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Web', origins: ['https://shop.example.com'] } })).body;

  assert.equal((await send({ key: 'tsk_not_a_real_key', message: 'x' })).status, 401);
  assert.equal((await send({ key: 'nope', message: 'x' })).status, 401);
  assert.equal((await send({ key: open.key })).body.error.code, 'bad_crash');
  assert.equal((await send(null, { raw: 'not json' })).status, 400);
  assert.equal((await send({ key: locked.key, message: 'boom' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ key: locked.key, message: 'boom' })).status, 403, 'a website-only key needs the website');
  assert.equal((await send({ key: locked.key, message: 'boom' }, { origin: 'https://shop.example.com' })).status, 202);
  assert.equal((await send({ key: open.key, message: 'From the server' })).status, 202, 'keys without websites work from servers');

  await t.api('DELETE', `${base}/ingest-keys/${open.ingestKey.id}`, { token: admin.token });
  assert.equal((await send({ key: open.key, message: 'x' })).status, 401);
  await t.api('POST', `${base}/archive`, { token: admin.token });
  assert.deepEqual((await send({ key: locked.key, message: 'later' }, { origin: 'https://shop.example.com' })).body, { received: false, ignored: 'project_archived' });
});

test('the SDK script: served to any website, and it really sends (deduped)', async () => {
  const { admin, base, project } = await team();
  const { key } = (await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Web' } })).body;
  const res = await fetch(`${t.base}/sdk/tessera.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const code = await res.text();

  // Run the real file in a bare global, like a worker with fetch.
  const sandbox = { fetch, URL, console: { warn() {} }, location: { href: 'https://shop.example.com/checkout?session=abc' } };
  vm.runInNewContext(code, sandbox);
  const { Tessera } = sandbox;
  assert.equal(await Tessera.capture(new Error('too early')), false, 'nothing is sent before init');
  Tessera.init({ key, endpoint: `${t.base}/api/ingest`, release: '2.0.0', environment: 'staging' });
  const err = new RangeError('Invalid array length');
  assert.equal(await Tessera.capture(err), true);
  assert.equal(await Tessera.capture(err), false, 'the same error within 10 seconds is not resent');
  assert.equal(await Tessera.capture('a plain string'), true);

  const tickets = await Ticket.find({ project: project.id }).sort({ number: 1 }).lean();
  assert.deepEqual(tickets.map((x) => x.error.type), ['RangeError', 'Error']);
  assert.equal(tickets[1].error.message, 'Non-error value: a plain string');
  const occ = await ErrorOccurrence.find({ project: project.id }).lean();
  assert.ok(occ.every((o) => o.release === '2.0.0' && o.appEnvironment === 'staging' && o.page === 'https://shop.example.com/checkout'));
});
