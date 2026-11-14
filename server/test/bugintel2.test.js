// Bug intelligence II, part B (E5B) through the API: spike alerts, comparing crashes, reproduction
// tracking and source links (throwaway MongoDB; emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { ErrorOccurrence, Project, Ticket } from '../src/models/index.js';
import { sourcePath, sourceUrl } from '../src/bugs/sourcelink.js';

let t;
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail() { return {}; } });
});
after(async () => { __setTransport(null); await t.stop(); });

const TRACE = (second = 'onSubmit') => `TypeError: Cannot read properties of undefined (reading 'total')
    at calculateTotal (https://shop.example.com/assets/checkout.4f9a2c1e.js:120:31)
    at ${second} (https://shop.example.com/assets/checkout.4f9a2c1e.js:88:12)`;
const GO = `panic: runtime error: index out of range [5] with length 3

goroutine 1 [running]:
main.process({0xc000012345, 0x3, 0x3})
\t/srv/shop/cart.go:12 +0x1d
main.main()
\t/srv/shop/main.go:8 +0x25
exit status 2`;
const RUBY = `app/models/order.rb:42:in \`total': undefined method \`price' for nil:NilClass (NoMethodError)
\tfrom app/controllers/orders_controller.rb:10:in \`create'`;

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Crashes', key: `BI${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  return { admin, dev, viewer, project: body.project, base: `/api/projects/${body.project.id}`, url: `/api/projects/${body.project.id}/tickets` };
}

test('source paths: relative paths link, absolute ones need the prefix, bundles and Java never', () => {
  assert.equal(sourcePath('app/models/order.rb'), 'app/models/order.rb');
  assert.equal(sourcePath('./src/cart.rs'), 'src/cart.rs');
  assert.equal(sourcePath('/var/www/shop/src/Cart.php'), null);
  assert.equal(sourcePath('/var/www/shop/src/Cart.php', '/var/www/shop/'), 'src/Cart.php');
  assert.equal(sourcePath('C:\\work\\shop\\api\\views.py', 'C:\\work\\shop\\'), 'api/views.py');
  assert.equal(sourcePath('https://shop.example.com/assets/checkout.4f9a2c1e.js'), null);
  assert.equal(sourcePath('https://shop.example.com/static/js/checkout.4f9a2c1e.js', 'https://shop.example.com/static/'), null, 'bundled build files need source maps');
  assert.equal(sourcePath('webpack:///./src/cart.js'), 'src/cart.js');
  assert.equal(sourcePath('../etc/passwd'), null);
  const src = { repo: 'acme/shop', branch: 'release/2.x', pathPrefix: '' };
  assert.equal(sourceUrl(src, { file: 'app/models/order.rb', line: 42, inApp: true }, 'ruby'), 'https://github.com/acme/shop/blob/release/2.x/app/models/order.rb#L42');
  assert.equal(sourceUrl(src, { file: 'vendor/x.rb', line: 1, inApp: false }, 'ruby'), null, 'library frames are not linked');
  assert.equal(sourceUrl(src, { file: 'Checkout.java', line: 4, inApp: true }, 'java'), null);
  assert.equal(sourceUrl({ repo: null }, { file: 'a.rb', line: 1, inApp: true }, 'ruby'), null);
});

test('source links: managers set the repo; frames get links; GitHub deliveries fill it in when empty', async () => {
  const { admin, dev, base, url, project } = await team();
  const go = (await t.api('POST', url, { token: dev.token, body: { errorText: GO } })).body.ticket;
  assert.equal(go.error.language, 'go');
  assert.equal(go.error.frames[0].source, null, 'no repository yet');

  assert.equal((await t.api('PUT', `${base}/source`, { token: dev.token, body: { repo: 'acme/shop' } })).status, 403);
  assert.equal((await t.api('PUT', `${base}/source`, { token: admin.token, body: { repo: 'not a repo' } })).status, 400);
  const set = await t.api('PUT', `${base}/source`, { token: admin.token, body: { repo: 'acme/shop', branch: 'main', pathPrefix: '/srv/shop/' } });
  assert.equal(set.status, 200);
  assert.equal(set.body.source.learnedFrom, 'manual');
  const linked = (await t.api('GET', `${url}/1`, { token: dev.token })).body.ticket;
  assert.deepEqual(linked.error.frames.map((f) => f.source), [
    'https://github.com/acme/shop/blob/main/cart.go#L12',
    'https://github.com/acme/shop/blob/main/main.go#L8',
  ]);
  const audit = (await t.api('GET', `${base}/audit`, { token: admin.token })).body.entries;
  assert.equal(audit[0].action, 'source.changed');

  // Cleared, then learned from GitHub's ping (sent when the webhook is created).
  await t.api('PUT', `${base}/source`, { token: admin.token, body: { repo: null } });
  const gh = (await t.api('PUT', `${base}/integrations/github`, { token: admin.token })).body.github;
  const raw = JSON.stringify({ zen: 'Keep it simple.', repository: { full_name: 'acme/storefront', default_branch: 'trunk' } });
  const sig = `sha256=${createHmac('sha256', gh.secret).update(raw).digest('hex')}`;
  const ping = await fetch(`${t.base}/api/hooks/github/${project.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sig }, body: raw });
  assert.equal(ping.status, 200);
  const fresh = (await t.api('GET', base, { token: dev.token })).body.project;
  assert.deepEqual([fresh.source.repo, fresh.source.branch, fresh.source.learnedFrom], ['acme/storefront', 'trunk', 'github']);
});

test('spike alerts: a jump in reports alerts the owner once; quiet errors and muted ones never', async () => {
  const { admin, dev, url, project } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE(), assigneeId: dev.user.id } });
  const ticket = await Ticket.findOne({ project: project.id, number: 1 });
  // A steady week before the last hour: 14 reports, two a day.
  const day = 24 * 3600 * 1000;
  await ErrorOccurrence.insertMany(Array.from({ length: 14 }, (_, i) => ({ project: project.id, ticket: ticket._id, at: new Date(Date.now() - 2 * 3600 * 1000 - i * (day / 2)) })));
  for (let i = 0; i < 3; i += 1) await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  await flushNotifications();
  const inbox = async (who) => (await t.api('GET', '/api/notifications', { token: who.token })).body.notifications.filter((n) => n.type === 'crash_spike');
  assert.equal((await inbox(dev)).length, 0, '4 reports in an hour is not a spike');

  for (let i = 0; i < 3; i += 1) await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  await flushNotifications();
  const spikes = await inbox(dev);
  assert.equal(spikes.length, 1, 'alerted once, not on every report after it');
  assert.equal(spikes[0].excerpt, '5 reports in the last hour, usually almost none');
  assert.equal((await inbox(admin)).length, 0, 'the owner is told, not the managers');
  const { insights } = (await t.api('GET', `${url}/1/error/insights`, { token: dev.token })).body;
  assert.deepEqual([insights.spike.spiking, insights.spike.lastHour, insights.spike.baseline], [true, 7, 0.08]);
  assert.ok(insights.spike.alertedAt);
  const history = (await t.api('GET', `${url}/1/history`, { token: dev.token })).body.events.filter((e) => e.type === 'error_spike');
  assert.deepEqual(history.map((e) => e.to.lastHour), [5]);

  // Muted errors never alert.
  await t.api('POST', url, { token: admin.token, body: { errorText: 'KeyError: user_id' } });
  await t.api('PUT', `${url}/2/error/mute`, { token: dev.token, body: { for: '1d' } });
  for (let i = 0; i < 6; i += 1) await t.api('POST', url, { token: admin.token, body: { errorText: 'KeyError: user_id' } });
  await flushNotifications();
  assert.equal((await inbox(admin)).length, 0);
});

test('comparing two crashes: shared frames marked, plain sentences on what differs', async () => {
  const { admin, viewer, base, url } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('onSubmit') } });
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('applyCoupon') } });
  await t.api('POST', url, { token: admin.token, body: { title: 'Plain task' } });
  const res = await t.api('GET', `${base}/errors/compare?a=1&b=2`, { token: viewer.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { a, b, shared, points } = res.body;
  assert.deepEqual([a.number, b.number], [1, 2]);
  assert.deepEqual(a.frames.map((f) => f.shared), [true, false]);
  assert.deepEqual(b.frames.map((f) => f.shared), [true, false]);
  assert.equal(shared.length, 1);
  assert.deepEqual(points, [
    'Both are TypeError.',
    'Same message once numbers, ids and quoted values are taken out.',
    'Both fail in calculateTotal (checkout.4f9a2c1e.js).',
    'They share 1 frame of your code.',
  ]);
  assert.equal((await t.api('GET', `${base}/errors/compare?a=1&b=3`, { token: viewer.token })).status, 400);
  assert.equal((await t.api('GET', `${base}/errors/compare?a=1&b=1`, { token: viewer.token })).status, 400);
  const ruby = await t.api('POST', url, { token: admin.token, body: { errorText: RUBY } });
  const cross = (await t.api('GET', `${base}/errors/compare?a=1&b=${ruby.body.ticket.number}`, { token: viewer.token })).body;
  assert.equal(cross.points[0], 'Different languages: javascript and ruby.');
  assert.ok(cross.points.includes('No frames of your code in common.'));
});

test('reproduction tracking: steps, attempts with results, status, search, permissions', async () => {
  const { admin, dev, viewer, url } = await team();
  await t.api('POST', url, { token: admin.token, body: { title: 'Coupon field rejects valid codes', type: 'bug' } });
  const empty = (await t.api('GET', `${url}/1/repro`, { token: viewer.token })).body.repro;
  assert.deepEqual([empty.steps, empty.attempts, empty.summary.status], ['', [], 'unknown']);

  assert.equal((await t.api('PUT', `${url}/1/repro/steps`, { token: viewer.token, body: { steps: 'x' } })).status, 403);
  const steps = await t.api('PUT', `${url}/1/repro/steps`, { token: dev.token, body: { steps: '1. Add any item\n2. Enter SAVE10\n3. Press Apply' } });
  assert.equal(steps.body.repro.summary.hasSteps, true);

  const no = await t.api('POST', `${url}/1/repro/attempts`, { token: dev.token, body: { result: 'not_reproduced', environment: 'Firefox 132 on macOS' } });
  assert.equal(no.body.repro.summary.status, 'not_reproduced');
  const search = async (q) => (await t.api('GET', `${url}?q=${encodeURIComponent(q)}`, { token: dev.token })).body.tickets.map((x) => x.number);
  assert.deepEqual(await search('is:unreproduced'), [1]);
  assert.deepEqual(await search('is:reproduced'), []);

  const yes = await t.api('POST', `${url}/1/repro/attempts`, { token: admin.token, body: { result: 'reproduced', environment: 'Chrome 130 on Windows', note: 'Only when the cart has one item' } });
  assert.deepEqual([yes.body.repro.summary.status, yes.body.repro.summary.reproduced, yes.body.repro.summary.notReproduced], ['reproduced', 1, 1]);
  assert.deepEqual(yes.body.repro.attempts.map((a) => [a.result, a.by.name]), [['not_reproduced', 'Dev'], ['reproduced', 'Admin']]);
  assert.deepEqual(await search('is:reproduced'), [1]);
  assert.equal((await t.api('GET', `${url}/1`, { token: viewer.token })).body.ticket.repro.status, 'reproduced');

  // Removing: your own, or any as a manager.
  const adminAttempt = yes.body.repro.attempts[1].id;
  assert.equal((await t.api('DELETE', `${url}/1/repro/attempts/${adminAttempt}`, { token: dev.token })).status, 403);
  const left = await t.api('DELETE', `${url}/1/repro/attempts/${adminAttempt}`, { token: admin.token });
  assert.equal(left.body.repro.summary.status, 'not_reproduced');
  assert.equal((await t.api('POST', `${url}/1/repro/attempts`, { token: dev.token, body: { result: 'maybe' } })).status, 400);
  const history = (await t.api('GET', `${url}/1/history`, { token: dev.token })).body.events.filter((e) => e.type === 'repro_updated').map((e) => e.field);
  assert.deepEqual(history, ['steps', 'attempt', 'attempt', 'attempt_removed']);
});
