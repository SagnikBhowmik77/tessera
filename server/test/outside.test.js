// Public portal, GitHub webhook and release notes (throwaway MongoDB; emails captured).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { findRefs } from '../src/services/github.service.js';
import { Project, Ticket, TicketEvent } from '../src/models/index.js';

let t;
let outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await jsonTransport.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
});
after(async () => { __setTransport(null); await t.stop(); });
beforeEach(() => { outbox = []; });

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const manager = await t.signUp('Manager');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `OUT${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [
    { user: manager.user.id, role: 'manager' }, { user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' },
  ] } } });
  return { admin, manager, dev, viewer, project: body.project, base: `/api/projects/${body.project.id}` };
}
const tokenOf = (url) => url.split('/report/')[1];

test('portal settings: managers turn it on, get a link, can rotate it; others never see it', async () => {
  const { base, manager, dev, viewer } = await team();
  assert.equal((await t.api('GET', `${base}/portal`, { token: dev.token })).status, 403);
  const off = await t.api('GET', `${base}/portal`, { token: manager.token });
  assert.deepEqual(off.body.portal, { enabled: false, intro: '', brand: { name: '', accent: null, logo: null }, url: null, turnstile: false, widget: { enabled: false, origins: [], scriptUrl: 'http://localhost:8740/sdk/widget.js', token: null } });

  const on = await t.api('PUT', `${base}/portal`, { token: manager.token, body: { enabled: true, intro: 'Found a bug in Shop? Tell us.' } });
  assert.match(on.body.portal.url, /^http:\/\/localhost:5210\/report\/[A-Za-z0-9_-]{32}$/);
  const token = tokenOf(on.body.portal.url);
  const project = (await t.api('GET', base, { token: viewer.token })).body.project;
  assert.deepEqual(project.portal, { enabled: true });
  assert.ok(!JSON.stringify(project).includes(token), 'the link is not in the project data members get');

  const info = await t.api('GET', `/api/portal/${token}`);
  assert.deepEqual(info.body, { project: { name: 'Shop', key: project.key }, intro: 'Found a bug in Shop? Tell us.', brand: { name: 'Shop', accent: null, logo: null }, turnstileSiteKey: null });

  const rotated = await t.api('POST', `${base}/portal/rotate`, { token: manager.token });
  assert.notEqual(tokenOf(rotated.body.portal.url), token);
  assert.equal((await t.api('GET', `/api/portal/${token}`)).status, 404, 'the old link is dead');
  await t.api('PUT', `${base}/portal`, { token: manager.token, body: { enabled: false } });
  assert.equal((await t.api('GET', `/api/portal/${tokenOf(rotated.body.portal.url)}`)).status, 404, 'turned off');
});

test('a public report lands in triage, tells the leads, and emails the reporter a receipt', async () => {
  const { base, admin, manager, dev, project } = await team();
  const token = tokenOf((await t.api('PUT', `${base}/portal`, { token: admin.token, body: { enabled: true } })).body.portal.url);
  const res = await t.api('POST', `/api/portal/${token}/reports`, {
    body: { title: 'Cannot pay with UPI', description: 'The pay button spins forever.', name: 'Meera', email: 'Meera@Example.com' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { trackUrl, ...answer } = res.body;
  assert.deepEqual(answer, { received: true, reference: `${project.key}-1`, alreadyKnown: false, willEmail: true });
  assert.match(trackUrl, /\/track\/[A-Za-z0-9_-]{24}$/);

  const ticket = await Ticket.findOne({ project: project.id, number: 1 }).lean();
  assert.deepEqual([ticket.source, ticket.triage, ticket.type, ticket.reporter], ['portal', true, 'bug', null]);
  assert.deepEqual(ticket.contact, { name: 'Meera', email: 'meera@example.com' });
  assert.deepEqual(ticket.labels, ['portal']);

  // Off the board until accepted; visible in the triage inbox.
  assert.equal((await t.api('GET', `${base}/tickets`, { token: dev.token })).body.total, 0);
  const inbox = await t.api('GET', `${base}/tickets?triage=true`, { token: dev.token });
  assert.deepEqual(inbox.body.tickets.map((x) => x.contact.name), ['Meera']);

  await flushNotifications();
  for (const lead of [admin, manager]) {
    const n = (await t.api('GET', '/api/notifications', { token: lead.token })).body.notifications;
    assert.equal(n[0].type, 'portal_report');
  }
  assert.equal((await t.api('GET', '/api/notifications', { token: dev.token })).body.unread, 0);
  const receipt = outbox.find((m) => m.to[0].address === 'meera@example.com');
  assert.equal(receipt.subject, `We received your report ${project.key}-1: Cannot pay with UPI`);

  // A rejected report goes to the bin, where it can be found and restored (back into triage).
  await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Rejected report' } });
  assert.equal((await t.api('DELETE', `${base}/tickets/2`, { token: dev.token })).status, 403, 'developers reject only what they reported');
  assert.equal((await t.api('DELETE', `${base}/tickets/2`, { token: manager.token })).status, 204);
  const bin = await t.api('GET', `${base}/tickets?deleted=true`, { token: dev.token });
  assert.deepEqual(bin.body.tickets.map((x) => x.number), [2]);
  await t.api('POST', `${base}/tickets/2/restore`, { token: manager.token });
  assert.deepEqual((await t.api('GET', `${base}/tickets?triage=true`, { token: dev.token })).body.tickets.map((x) => x.number).sort(), [1, 2]);

  // Accept onto the board; when it's fixed, the reporter hears about it.
  assert.equal((await t.api('POST', `${base}/tickets/1/accept`, { token: dev.token })).status, 200);
  assert.equal((await t.api('POST', `${base}/tickets/1/accept`, { token: dev.token })).body.error.code, 'not_in_triage');
  assert.equal((await t.api('GET', `${base}/tickets`, { token: dev.token })).body.total, 1);
  outbox = [];
  await t.api('POST', `${base}/tickets/1/move`, { token: dev.token, body: { status: 'done' } });
  await flushNotifications();
  assert.deepEqual(outbox.map((m) => [m.to[0].address, m.subject]), [['meera@example.com', `Fixed: Cannot pay with UPI (${project.key}-1)`]]);
  const types = (await TicketEvent.find({ ticket: ticket._id }).sort({ at: 1, _id: 1 }).lean()).map((e) => e.type);
  assert.deepEqual(types, ['created', 'triaged', 'status_changed']);
});

test('portal: errors group with known ones, bots and bad input are refused, no account needed', async () => {
  const { base, admin, project } = await team();
  const token = tokenOf((await t.api('PUT', `${base}/portal`, { token: admin.token, body: { enabled: true } })).body.portal.url);
  const trace = 'TypeError: x is undefined\n    at pay (https://shop.example.com/app.js:10:5)';
  await t.api('POST', `${base}/tickets`, { token: admin.token, body: { errorText: trace } });
  const again = await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Payment page crashed', errorText: trace } });
  assert.deepEqual([again.status, again.body.reference, again.body.alreadyKnown], [201, `${project.key}-1`, true]);
  assert.equal((await Ticket.findOne({ project: project.id, number: 1 }).lean()).error.occurrences, 2);

  const bot = await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Buy cheap watches', website: 'http://spam.example' } });
  assert.deepEqual([bot.status, bot.body.error.code], [400, 'rejected']);
  assert.equal((await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'x' } })).status, 400);
  assert.equal((await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Valid title', email: 'not-email' } })).status, 400);
  assert.equal((await t.api('POST', '/api/portal/short/reports', { body: { title: 'Valid title' } })).status, 400);
  assert.equal(await Ticket.countDocuments({ project: project.id }), 1, 'nothing was created by the refused reports');
});

test('reading GitHub messages: closing words close, plain mentions link, other keys are ignored', () => {
  assert.deepEqual(findRefs('Fixes SHOP-12, closes shop-3 and see SHOP-7. Also fixes OTHER-1', 'SHOP'), [
    { number: 12, closes: true }, { number: 3, closes: true }, { number: 7, closes: false },
  ]);
  assert.deepEqual(findRefs('resolved: SHOP-9\nrefs SHOP-9', 'SHOP'), [{ number: 9, closes: true }]);
  assert.deepEqual(findRefs('prefixSHOP-1 and SHOP-x', 'SHOP'), []);
});

function signed(base, secret, event, payload) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${t.base}${base}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sig }, body: raw })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('GitHub: admins connect; deliveries must be signed; commits and PRs link and close tickets', async () => {
  const { base, admin, manager, dev, project } = await team();
  assert.equal((await t.api('PUT', `${base}/integrations/github`, { token: manager.token })).status, 403);
  const gh = (await t.api('PUT', `${base}/integrations/github`, { token: admin.token })).body.github;
  assert.equal(gh.url, `http://localhost:8740/api/hooks/github/${project.id}`);
  assert.match(gh.secret, /^[0-9a-f]{64}$/);
  assert.equal((await t.api('GET', `${base}/integrations/github`, { token: manager.token })).body.github.secret, undefined);
  assert.deepEqual((await t.api('GET', base, { token: dev.token })).body.project.github, { connected: true, token: false, issueSync: false });

  for (const title of ['Login broken', 'Slow search', 'Typo on home']) await t.api('POST', `${base}/tickets`, { token: dev.token, body: { title } });
  const hook = `/api/hooks/github/${project.id}`;
  assert.deepEqual((await signed(hook, gh.secret, 'ping', { zen: 'hi' })).body, { ok: true, event: 'ping' });
  const forged = await signed(hook, 'f'.repeat(64), 'ping', {});
  assert.deepEqual([forged.status, forged.body.error.code], [401, 'bad_signature']);

  const repo = { default_branch: 'main' };
  const k = project.key;
  // A feature-branch commit only links; the same words on main close.
  const branch = await signed(hook, gh.secret, 'push', { ref: 'refs/heads/feature', repository: repo, commits: [
    { id: 'aaaaaaa1111', message: `Fix login redirect\n\nfixes ${k}-1`, url: 'https://github.com/acme/shop/commit/aaaaaaa', author: { username: 'asha' } },
  ] });
  assert.deepEqual([branch.body.linked, branch.body.closed], [[`${k}-1`], []]);
  const main = await signed(hook, gh.secret, 'push', { ref: 'refs/heads/main', repository: repo, commits: [
    { id: 'bbbbbbb2222', message: `Merge: fixes ${k}-1, mentions ${k}-3`, url: 'https://github.com/acme/shop/commit/bbbbbbb', author: { name: 'Asha' } },
  ] });
  assert.deepEqual([main.body.linked.sort(), main.body.closed], [[`${k}-1`, `${k}-3`], [`${k}-1`]]);

  const t1 = (await t.api('GET', `${base}/tickets/1`, { token: dev.token })).body.ticket;
  assert.equal(t1.status, 'done');
  assert.ok(t1.resolvedAt);
  assert.deepEqual(t1.links.map((l) => [l.kind, l.ref]), [['commit', 'aaaaaaa'], ['commit', 'bbbbbbb']]);
  assert.equal((await t.api('GET', `${base}/tickets/3`, { token: dev.token })).body.ticket.status, 'todo', 'a mention does not close');

  // Pull requests: opened links; merged with "closes" closes.
  const pr = { number: 42, title: `Speed up search (closes ${k}-2)`, body: '', html_url: 'https://github.com/acme/shop/pull/42', user: { login: 'ravi' }, merged: false };
  assert.deepEqual((await signed(hook, gh.secret, 'pull_request', { action: 'opened', pull_request: pr })).body.closed, []);
  const merged = await signed(hook, gh.secret, 'pull_request', { action: 'closed', pull_request: { ...pr, merged: true } });
  assert.deepEqual(merged.body, { ok: true, event: 'pull_request', linked: [], closed: [`${k}-2`], refreshed: [], moved: [] }, 'already linked, now closed');
  const closedPr = await signed(hook, gh.secret, 'pull_request', { action: 'closed', pull_request: { ...pr, number: 43, html_url: 'https://github.com/acme/shop/pull/43', merged: false, title: `closes ${k}-3` } });
  assert.deepEqual(closedPr.body.closed, [], 'closed without merging closes nothing');

  const history = (await t.api('GET', `${base}/tickets/2/history`, { token: dev.token })).body.events;
  assert.deepEqual(history.map((e) => [e.type, e.source]), [['created', 'app'], ['linked', 'github'], ['status_changed', 'github']]);

  // Disconnecting stops deliveries.
  await t.api('DELETE', `${base}/integrations/github`, { token: admin.token });
  assert.equal((await signed(hook, gh.secret, 'ping', {})).status, 404);
  assert.equal((await signed('/api/hooks/github/not-a-project', gh.secret, 'ping', {})).status, 404);
});

test('release notes: finished work grouped by type, as Markdown, with PR links and thanks', async () => {
  const { base, admin, dev, project } = await team();
  const mk = (b) => t.api('POST', `${base}/tickets`, { token: admin.token, body: b });
  await mk({ title: 'Dark mode', type: 'feature', assigneeId: dev.user.id });
  await mk({ title: 'Login *crash* on Safari', type: 'bug', assigneeId: admin.user.id });
  await mk({ title: 'Upgrade build tools', type: 'task' });
  await mk({ title: 'Not finished', type: 'feature' });
  for (const n of [1, 2, 3]) await t.api('POST', `${base}/tickets/${n}/move`, { token: admin.token, body: { status: 'done' } });
  await Ticket.updateOne({ project: project.id, number: 1 }, { $push: { links: { kind: 'pull_request', url: 'https://github.com/acme/shop/pull/7', ref: '#7', title: 'Dark mode' } } });

  const res = await t.api('GET', `${base}/release-notes?version=v1.4.0`, { token: dev.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.count, 3);
  assert.deepEqual(res.body.sections.map((s) => [s.title, s.tickets.map((x) => x.key)]), [
    ['New features', [`${project.key}-1`]], ['Bug fixes', [`${project.key}-2`]], ['Other changes', [`${project.key}-3`]],
  ]);
  const md = res.body.markdown;
  assert.match(md, /^## v1\.4\.0 \(/);
  assert.ok(md.includes(`- Dark mode ([${project.key}-1](http://localhost:5210/projects/${project.id}/tickets/${project.key}-1)) · [#7](https://github.com/acme/shop/pull/7)`));
  assert.ok(md.includes('- Login \\*crash\\* on Safari'), 'Markdown characters in titles are escaped');
  assert.ok(md.includes('Thanks to Admin, Dev.'));
  assert.ok(!md.includes('Not finished'));

  const empty = await t.api('GET', `${base}/release-notes?from=2026-01-01&to=2026-01-31`, { token: dev.token });
  assert.equal(empty.body.count, 0);
  assert.match(empty.body.markdown, /Nothing was finished in this period/);
  assert.equal((await t.api('GET', `${base}/release-notes?from=2026-02-01&to=2026-01-01`, { token: dev.token })).status, 400);
});
