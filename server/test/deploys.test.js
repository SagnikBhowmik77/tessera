// Deployments (E8): merged vs live, held "fixed" emails, the release a crash came back in, GitHub
// deployment statuses, DORA, the public status page and badge (throwaway MongoDB; emails captured).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Deployment, ErrorOccurrence, Project, Ticket, TicketEvent } from '../src/models/index.js';
import { dora } from '../src/services/deploy.service.js';

let t;
let outbox = [];
const json = nodemailer.createTransport({ jsonTransport: true });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await json.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
});
after(async () => { __setTransport(null); await t.stop(); });

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `DP${n}` } });
  const url = `/api/projects/${body.project.id}`;
  const deployToken = (await t.api('POST', `${url}/ingest-keys`, { token: admin.token, body: { name: 'CI deploys', kind: 'deploy' } })).body.key;
  return { admin, project: body.project, url, deployToken };
}
const deploy = (token, body) => fetch(`${t.base}/api/deploys`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
async function hook(ctx, event, payload) {
  const secret = (await t.api('PUT', `${ctx.url}/integrations/github`, { token: ctx.admin.token })).body.github.secret;
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const r = await fetch(`${t.base}/api/hooks/github/${ctx.project.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sig }, body: raw });
  return { status: r.status, body: await r.json() };
}

test('merged vs live: a merge finishes a ticket, the next production deploy ships it', async () => {
  const ctx = await team();
  assert.match(ctx.deployToken, /^tsd_/);
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.admin.token, body: { title: 'Coupon rounding' } });
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.admin.token, body: { title: 'Closed by hand' } });
  const pr = { number: 4, title: 'Round coupons', body: `fixes ${ctx.project.key}-1`, html_url: 'https://github.com/acme/shop/pull/4', merged: true, user: { login: 'ana' }, head: { ref: 'fix' } };
  await hook(ctx, 'pull_request', { action: 'closed', pull_request: pr, repository: { full_name: 'acme/shop' } });
  await t.api('POST', `${ctx.url}/tickets/2/move`, { token: ctx.admin.token, body: { status: 'done' } });
  let one = await Ticket.findOne({ project: ctx.project.id, number: 1 }).lean();
  assert.ok(one.mergedAt, 'merged');
  assert.equal(one.shipped, null, 'not live yet');

  assert.equal((await deploy('tsk_wrongkind', { release: '1.5.0' })).status, 401);
  assert.equal((await deploy(ctx.deployToken, {})).status, 400);
  const staging = await deploy(ctx.deployToken, { release: '1.5.0-rc1', environment: 'staging' });
  assert.deepEqual(staging.body.shipped, [], 'staging does not ship anything');
  const failed = await deploy(ctx.deployToken, { release: '1.5.0', status: 'failure' });
  assert.deepEqual(failed.body.shipped, []);
  const live = await deploy(ctx.deployToken, { release: '1.5.0', sha: 'a1b2c3d4e5' });
  assert.equal(live.status, 201, JSON.stringify(live.body));
  assert.deepEqual(live.body.shipped, [`${ctx.project.key}-1`], 'only merged work ships; hand-closed tickets have no merge');
  one = await Ticket.findOne({ project: ctx.project.id, number: 1 }).lean();
  assert.deepEqual([one.shipped.release, one.shipped.environment], ['1.5.0', 'production']);
  assert.equal(await TicketEvent.countDocuments({ ticket: one._id, type: 'deployed' }), 1);

  // Reopening clears it: that merge and deploy didn't fix it after all.
  await t.api('POST', `${ctx.url}/tickets/1/move`, { token: ctx.admin.token, body: { status: 'todo' } });
  one = await Ticket.findOne({ project: ctx.project.id, number: 1 }).lean();
  assert.deepEqual([one.mergedAt, one.shipped], [null, null]);

  const list = (await t.api('GET', `${ctx.url}/deploys`, { token: ctx.admin.token })).body;
  assert.deepEqual(list.deployments.map((d) => [d.release, d.environment, d.status]), [['1.5.0', 'production', 'success'], ['1.5.0', 'production', 'failure'], ['1.5.0-rc1', 'staging', 'success']]);
  const manual = await t.api('POST', `${ctx.url}/deploys`, { token: ctx.admin.token, body: { release: '1.5.1' } });
  assert.equal(manual.status, 201);
});

test('reporter "fixed" emails can wait for the deploy', async () => {
  const ctx = await team();
  await t.api('PUT', `${ctx.url}/deploys/settings`, { token: ctx.admin.token, body: { emailAfterDeploy: true } });
  const portal = (await t.api('PUT', `${ctx.url}/portal`, { token: ctx.admin.token, body: { enabled: true } })).body.portal;
  const token = portal.url.split('/report/')[1];
  await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Cannot pay', email: 'meera@example.com' } });
  await t.api('POST', `${ctx.url}/tickets/1/accept`, { token: ctx.admin.token });
  await flushNotifications();
  outbox = [];
  await t.api('POST', `${ctx.url}/tickets/1/move`, { token: ctx.admin.token, body: { status: 'done' } });
  await flushNotifications();
  assert.equal(outbox.filter((m) => m.subject.startsWith('Fixed:')).length, 0, 'held');
  assert.equal((await Ticket.findOne({ project: ctx.project.id, number: 1 }).lean()).fixEmailPending, true);
  const res = await deploy(ctx.deployToken, { release: '2.0.0' });
  assert.equal(res.body.emailed, 1);
  await flushNotifications();
  assert.deepEqual(outbox.filter((m) => m.subject.startsWith('Fixed:')).map((m) => m.to[0].address), ['meera@example.com']);
});

test('the release a crash came back in', async () => {
  const ctx = await team();
  const trace = "TypeError: x is undefined\n    at pay (https://shop.example.com/assets/app.4f9a2c1e.js:1:20)";
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.admin.token, body: { errorText: trace } });
  await t.api('POST', `${ctx.url}/tickets/1/move`, { token: ctx.admin.token, body: { status: 'done' } });
  await deploy(ctx.deployToken, { release: '3.1.0' });
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.admin.token, body: { errorText: trace } });
  const ev = await TicketEvent.findOne({ type: 'error_recurred', project: ctx.project.id }).lean();
  assert.equal(ev.to.release, '3.1.0', 'the last production deploy before it came back');
  const { insights } = (await t.api('GET', `${ctx.url}/tickets/1/error/insights`, { token: ctx.admin.token })).body;
  assert.ok(insights.timeline.markers.some((m) => m.label === 'Came back: reopened by a new report (release 3.1.0)'));

  // A crash that names its own release (from the SDK) uses that one.
  await t.api('POST', `${ctx.url}/tickets/1/move`, { token: ctx.admin.token, body: { status: 'done' } });
  const { key } = (await t.api('POST', `${ctx.url}/ingest-keys`, { token: ctx.admin.token, body: { name: 'Web' } })).body;
  await fetch(`${t.base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ key, type: 'TypeError', message: 'x is undefined', stack: trace, release: '3.2.0' }) });
  const last = await TicketEvent.findOne({ type: 'error_recurred', project: ctx.project.id }).sort({ _id: -1 }).lean();
  assert.equal(last.to.release, '3.2.0');
});

test('GitHub deployment statuses are recorded once', async () => {
  const ctx = await team();
  const payload = { deployment_status: { id: 77, state: 'success', environment_url: 'https://shop.example.com', created_at: '2026-11-10T08:00:00Z' }, deployment: { sha: 'abcdef1234', ref: 'main', environment: 'production', payload: { release: '4.0.0' } }, repository: { full_name: 'acme/shop' } };
  const first = await hook(ctx, 'deployment_status', payload);
  assert.deepEqual(first.body.deploy, { release: '4.0.0', shipped: [] });
  const again = await hook(ctx, 'deployment_status', payload);
  assert.deepEqual(again.body.deploy, { duplicate: true });
  const pending = await hook(ctx, 'deployment_status', { ...payload, deployment_status: { id: 78, state: 'in_progress' } });
  assert.deepEqual(pending.body.deploy, { ignored: 'in_progress' });
  assert.equal(await Deployment.countDocuments({ project: ctx.project.id }), 1);
});

test('DORA: deploy frequency, lead time, change failure rate, time to restore', async () => {
  const ctx = await team();
  const project = await Project.findById(ctx.project.id);
  const now = new Date('2026-11-10T12:00:00Z');
  const ago = (h) => new Date(+now - h * 3600 * 1000);
  // Four production deploys in the last 30 days; one followed by a crash coming back within a day; one failed.
  await Deployment.insertMany([
    { project: project._id, environment: 'production', release: '1', status: 'success', source: 'hook', at: ago(24 * 20) },
    { project: project._id, environment: 'production', release: '2', status: 'success', source: 'hook', at: ago(24 * 10) },
    { project: project._id, environment: 'production', release: '3', status: 'failure', source: 'hook', at: ago(24 * 5) },
    { project: project._id, environment: 'production', release: '4', status: 'success', source: 'hook', at: ago(24 * 2) },
    { project: project._id, environment: 'staging', release: 'x', status: 'success', source: 'hook', at: ago(24) },
  ]);
  const t1 = await Ticket.create({ project: project._id, number: 1, title: 'a', status: 'done', rank: 'a0', mergedAt: ago(24 * 10 + 6), shipped: { release: '2', at: ago(24 * 10) } });
  await Ticket.create({ project: project._id, number: 2, title: 'b', status: 'done', rank: 'a1', mergedAt: ago(24 * 2 + 2), shipped: { release: '4', at: ago(24 * 2) } });
  await ErrorOccurrence.create({ project: project._id, ticket: t1._id, at: ago(24 * 10 - 3), regression: true });
  // That crash came back (reopened) and was finished again 5 hours later.
  await TicketEvent.insertMany([
    { project: project._id, ticket: t1._id, type: 'error_recurred', at: ago(24 * 10 - 3), to: {} },
    { project: project._id, ticket: t1._id, type: 'status_changed', from: 'done', to: 'todo', at: ago(24 * 10 - 3) },
    { project: project._id, ticket: t1._id, type: 'status_changed', from: 'todo', to: 'done', at: ago(24 * 10 - 8) },
  ]);
  const d = await dora(project, 30, now);
  assert.deepEqual(d.deploys, { total: 4, successful: 3, perWeek: 0.7 });
  assert.deepEqual(d.leadTime, { hours: 4, tickets: 2 }, 'median of 6 h and 2 h');
  assert.deepEqual(d.changeFailure, { rate: 50, failed: 2, of: 4 });
  assert.deepEqual(d.timeToRestore, { hours: 5, incidents: 1 });
});

test('public status page and README badge: off until turned on, then facts only', async () => {
  const ctx = await team();
  const settings = (await t.api('PUT', `${ctx.url}/deploys/settings`, { token: ctx.admin.token, body: { statusPage: { enabled: true, showCrashes: true } } })).body.settings;
  const token = settings.statusPage.token;
  assert.ok(token);
  let s = (await fetch(`${t.base}/api/status/${token}`).then((r) => r.json()));
  assert.deepEqual([s.name, s.state, s.lastDeploy, s.crashes24h], ['Shop', 'operational', null, 0]);
  assert.equal(s.project, undefined, 'no project internals');
  await deploy(ctx.deployToken, { release: '5.0.0' });
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.admin.token, body: { title: 'Checkout down', labels: ['incident'], priority: 'critical' } });
  s = await fetch(`${t.base}/api/status/${token}`).then((r) => r.json());
  assert.deepEqual([s.state, s.incidents.map((i) => i.title), s.lastDeploy.release], ['incident', ['Checkout down'], '5.0.0']);

  const svg = await fetch(`${t.base}/api/status/${token}/badge.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal(svg.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(await svg.text(), /status: 1 incident/);
  assert.match(await fetch(`${t.base}/api/status/${token}/badge.svg?show=release`).then((r) => r.text()), /release: 5\.0\.0/);
  await t.api('PUT', `${ctx.url}/deploys/settings`, { token: ctx.admin.token, body: { statusPage: { enabled: false } } });
  assert.equal((await fetch(`${t.base}/api/status/${token}`)).status, 404);
});
