// Notifications and integrations (E13): personal API tokens and the CLI, Slack / Discord alerts,
// signed outgoing webhooks, quiet hours and digests, and the GitLab webhook (throwaway MongoDB;
// outbound HTTP and email are captured, nothing leaves the machine).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { flushHooks } from '../src/services/hooks.js';
import { __setOutboundFetch } from '../src/services/outbound.service.js';
import { __setGitlabFetch } from '../src/services/gitlab.service.js';
import { runDigestSweep } from '../src/services/digest.service.js';
import { ApiToken, Notification, Project, Ticket, User } from '../src/models/index.js';
import { main as cli } from '../../cli/tessera.mjs';

let t;
let outbox = [];
let sent = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
let reply = () => ({ status: 200 });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await jsonTransport.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
  __setOutboundFetch(async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    const r = reply(url);
    return new Response(r.body ?? 'ok', { status: r.status });
  }, [0, 0, 0]);
});
after(async () => { __setTransport(null); __setOutboundFetch(null); __setGitlabFetch(null); await t.stop(); });
beforeEach(() => { outbox = []; sent = []; reply = () => ({ status: 200 }); });

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `IN${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  return { admin, dev, project: body.project, base: `/api/projects/${body.project.id}` };
}
const settle = async () => { await flushHooks(); await flushNotifications(); };

test('personal API tokens: shown once, read or write, never for account security, revocable', async () => {
  const c = await team();
  const made = await t.api('POST', '/api/me/tokens', { token: c.dev.token, body: { name: 'Laptop', scope: 'read' } });
  assert.equal(made.status, 201);
  const read = made.body.token.token;
  assert.match(read, /^tsp_[A-Za-z0-9_-]{43}$/);
  const listed = (await t.api('GET', '/api/me/tokens', { token: c.dev.token })).body.tokens;
  assert.equal(listed[0].prefix, read.slice(0, 10));
  assert.ok(!JSON.stringify(listed).includes(read), 'the token itself is never shown again');
  assert.equal((await ApiToken.findById(made.body.token.id).lean()).hash.length, 64, 'only a hash is stored');

  assert.equal((await t.api('GET', '/api/projects', { token: read })).status, 200);
  assert.equal((await t.api('POST', `${c.base}/tickets`, { token: read, body: { title: 'Nope' } })).body.error.code, 'read_only_token');
  const write = (await t.api('POST', '/api/me/tokens', { token: c.dev.token, body: { name: 'CI', scope: 'write', expiresInDays: 30 } })).body.token;
  for (const [method, path] of [['POST', '/api/me/tokens'], ['GET', '/api/auth/sessions'], ['POST', '/api/auth/logout-all'], ['GET', '/api/auth/2fa']]) {
    assert.equal((await t.api(method, path, { token: write.token, body: method === 'POST' ? { name: 'x' } : undefined })).body.error.code, 'login_required', path);
  }
  assert.equal((await t.api('POST', `${c.base}/tickets`, { token: write.token, body: { title: 'From a script' } })).status, 201);
  await t.api('DELETE', `/api/me/tokens/${made.body.token.id}`, { token: c.dev.token });
  assert.equal((await t.api('GET', '/api/projects', { token: read })).status, 401);
  await ApiToken.updateOne({ _id: write.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await t.api('GET', '/api/projects', { token: write.token })).body.error.code, 'token_expired');
});

test('the CLI works tickets with a token', async () => {
  const c = await team();
  const token = (await t.api('POST', '/api/me/tokens', { token: c.dev.token, body: { name: 'CLI', scope: 'write' } })).body.token.token;
  const dir = mkdtempSync(join(tmpdir(), 'tessera-cli-'));
  const configPath = join(dir, 'config.json');
  const lines = [];
  const run = (...argv) => cli(argv, { out: { log: (s) => lines.push(String(s)) }, env: {}, configPath });
  try {
    await run('login', t.base, token);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { url: t.base, token });
    await run('whoami');
    assert.match(lines.at(-1), /^Dev </);
    await run('create', c.project.key, 'Checkout', 'button', 'broken', '--type', 'bug', '--priority', 'high');
    assert.equal(lines.at(-1), `Created ${c.project.key}-1: Checkout button broken`);
    await run('assign', `${c.project.key}-1`, 'me');
    assert.equal(lines.at(-1), `${c.project.key}-1 assigned to Dev`);
    await run('move', `${c.project.key}-1`, 'In Progress');
    assert.equal(lines.at(-1), `${c.project.key}-1 is now in In Progress`);
    await run('comment', `${c.project.key}-1`, 'Fixing', 'it', 'now');
    await run('list', c.project.key, '--mine', '--open');
    assert.match(lines.at(-2), new RegExp(`^${c.project.key}-1 +In Progress +high +Dev +Checkout button broken$`));
    assert.equal(lines.at(-1), '1 of 1');
    await run('show', `${c.project.key.toLowerCase()}-1`);
    assert.match(lines.join('\n'), /bug · high · In Progress · Dev/);
    await assert.rejects(run('move', `${c.project.key}-1`, 'Nowhere'), /No column "Nowhere"/);
    await assert.rejects(run('show', 'not-a-key'), /is not a ticket key/);
    await assert.rejects(run('list', 'ZZZ'), /No project ZZZ/);
    const comments = (await t.api('GET', `${c.base}/tickets/1/comments`, { token: c.dev.token })).body.comments;
    assert.equal(comments[0].body, 'Fixing it now');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
const DISCORD = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz_1234';

test('Slack and Discord alerts: chosen events and priorities, no pings, failures recorded', async () => {
  const c = await team();
  assert.equal((await t.api('POST', `${c.base}/integrations/alerts`, { token: c.dev.token, body: { kind: 'slack', name: 'x', url: SLACK } })).status, 403);
  assert.equal((await t.api('POST', `${c.base}/integrations/alerts`, { token: c.admin.token, body: { kind: 'slack', name: 'x', url: 'https://evil.example/hook' } })).body.error.code, 'bad_url');
  const slack = (await t.api('POST', `${c.base}/integrations/alerts`, { token: c.admin.token, body: { kind: 'slack', name: '#bugs', url: SLACK, events: ['ticket.created', 'ticket.done'], priorities: ['critical', 'high'] } })).body.alert;
  assert.ok(!JSON.stringify(slack).includes('abcdefghijklmnop'), 'the webhook URL is a secret and never shown again');
  await t.api('POST', `${c.base}/integrations/alerts`, { token: c.admin.token, body: { kind: 'discord', name: 'dev', url: DISCORD, events: ['ticket.moved'] } });
  assert.equal(await Project.countDocuments({ _id: c.project.id, 'alerts.url': SLACK }), 0, 'stored sealed');

  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Low thing', priority: 'low' } });
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Pay fails <for> @everyone', priority: 'critical' } });
  await settle();
  assert.deepEqual(sent.map((s) => s.url), [SLACK], 'only the critical one, only to Slack');
  const slackBody = JSON.parse(sent[0].body);
  assert.match(slackBody.blocks[0].text.text, /Pay fails &lt;for&gt; @everyone/);
  assert.ok(slackBody.blocks[0].text.text.includes(`/projects/${c.project.id}/tickets/${c.project.key}-2|`));

  sent = [];
  await t.api('POST', `${c.base}/tickets/2/move`, { token: c.admin.token, body: { status: 'done' } });
  await settle();
  assert.deepEqual(sent.map((s) => s.url).sort(), [DISCORD, SLACK].sort());
  const discord = JSON.parse(sent.find((s) => s.url === DISCORD).body);
  assert.deepEqual(discord.allowed_mentions, { parse: [] }, 'a title can never ping a Discord server');
  assert.equal(discord.embeds[0].description, 'Moved: To Do → Done');

  reply = () => ({ status: 500 });
  const test1 = (await t.api('POST', `${c.base}/integrations/alerts/${slack.id}/test`, { token: c.admin.token })).body.delivery;
  assert.deepEqual([test1.ok, test1.status, test1.attempts], [false, 500, 3], 'server errors are retried');
  reply = () => ({ status: 404 });
  const test2 = (await t.api('POST', `${c.base}/integrations/alerts/${slack.id}/test`, { token: c.admin.token })).body.delivery;
  assert.deepEqual([test2.ok, test2.attempts], [false, 1], 'a 404 is not retried');
  const list = (await t.api('GET', `${c.base}/integrations/outbound`, { token: c.admin.token })).body;
  assert.equal(list.alerts.find((a) => a.id === slack.id).failures, 2);
  assert.equal(list.deliveries[0].error, 'HTTP 404');
  await t.api('DELETE', `${c.base}/integrations/alerts/${slack.id}`, { token: c.admin.token });
  assert.equal((await t.api('GET', `${c.base}/integrations/outbound`, { token: c.admin.token })).body.alerts.length, 1);
});

test('outgoing webhooks are signed with a secret shown once', async () => {
  const c = await team();
  assert.equal((await t.api('POST', `${c.base}/integrations/webhooks`, { token: c.admin.token, body: { name: 'x', url: 'ftp://example.com/x' } })).body.error.code, 'https_required');
  const hook = (await t.api('POST', `${c.base}/integrations/webhooks`, { token: c.admin.token, body: { name: 'Zapier', url: 'https://hooks.example.com/tessera', events: ['ticket.created', 'ticket.commented'] } })).body.webhook;
  assert.match(hook.secret, /^whsec_/);
  assert.ok(!JSON.stringify((await t.api('GET', `${c.base}/integrations/outbound`, { token: c.admin.token })).body).includes(hook.secret));
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Signed' } });
  await settle();
  await t.api('POST', `${c.base}/tickets/1/comments`, { token: c.admin.token, body: { body: 'Hello hooks' } });
  await settle();
  assert.deepEqual(sent.map((s) => s.headers['x-tessera-event']), ['ticket.created', 'ticket.commented']);
  for (const s of sent) {
    assert.equal(s.headers['x-tessera-signature'], `sha256=${createHmac('sha256', hook.secret).update(s.body).digest('hex')}`);
    assert.equal(JSON.parse(s.body).id, s.headers['x-tessera-delivery']);
  }
  const created = JSON.parse(sent[0].body);
  assert.deepEqual([created.project.key, created.ticket.key, created.ticket.title], [c.project.key, `${c.project.key}-1`, 'Signed']);
  assert.equal(JSON.parse(sent[1].body).change.comment.body, 'Hello hooks');
  await t.api('PATCH', `${c.base}/integrations/webhooks/${hook.id}`, { token: c.admin.token, body: { active: false } });
  sent = [];
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Paused' } });
  await settle();
  assert.equal(sent.length, 0, 'a paused webhook gets nothing');
});

test('quiet hours hold emails for one summary; a digest replaces single emails', async () => {
  const c = await team();
  await User.updateMany({ _id: { $in: [c.admin.user.id, c.dev.user.id] } }, { $set: { emailVerifiedAt: new Date() } });
  const devEmail = (await User.findById(c.dev.user.id).lean()).email;
  const now = new Date();
  const hm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const settings = await t.api('PUT', '/api/me/notifications', { token: c.dev.token, body: { timeZone: 'UTC', quiet: { enabled: true, from: hm(new Date(+now - 60_000)), to: hm(new Date(+now + 3_600_000)) } } });
  assert.equal(settings.body.settings.quiet.enabled, true);
  assert.equal((await t.api('PUT', '/api/me/notifications', { token: c.dev.token, body: { timeZone: 'Mars/Olympus' } })).body.error.code, 'bad_timezone');

  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Mention me', assigneeId: c.dev.user.id } });
  await settle();
  // Account emails (like "confirm your email") are not notifications and are never held.
  assert.deepEqual(outbox.filter((m) => m.to[0].address === devEmail && !/Confirm your email/.test(m.subject)).map((m) => m.subject), [], 'no notification email during quiet hours');
  assert.equal(await Notification.countDocuments({ user: c.dev.user.id, emailHeld: true }), 1, 'the bell has it and the email is held');
  assert.equal((await runDigestSweep(now)).released, 0, 'still quiet');
  assert.equal((await runDigestSweep(new Date(+now + 2 * 3_600_000))).released, 1);
  const summary = outbox.find((m) => m.to[0].address === devEmail && /paused/.test(m.subject));
  assert.match(summary.subject, /While your notifications were paused: 1 update$/);
  assert.match(summary.text, /Mention me: assigned to you/);
  assert.equal(await Notification.countDocuments({ user: c.dev.user.id, emailHeld: true }), 0);

  // Daily digest at 09:00 UTC: no single emails, one summary at the hour, not twice.
  outbox = [];
  await t.api('PUT', '/api/me/notifications', { token: c.dev.token, body: { quiet: { enabled: false }, digest: 'daily', digestHour: 9 } });
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Digest me', assigneeId: c.dev.user.id } });
  await settle();
  assert.equal(outbox.length, 0);
  const nine = new Date();
  nine.setUTCHours(9, 5, 0, 0);
  if (nine < new Date()) nine.setUTCDate(nine.getUTCDate() + 1);
  assert.equal((await runDigestSweep(new Date(+nine - 3_600_000))).digests, 0, 'not at 08:05');
  assert.equal((await runDigestSweep(nine)).digests, 1);
  assert.match(outbox[0].subject, /Your daily Tessera digest: 2 updates/);
  assert.equal((await runDigestSweep(new Date(+nine + 10 * 60_000))).digests, 0, 'once a day');
});

test('GitLab: secret token checked, commits and merge requests link and close tickets', async () => {
  const c = await team();
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Fix the cart' } });
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Speed up search' } });
  assert.equal((await t.api('PUT', `${c.base}/integrations/gitlab`, { token: c.dev.token })).status, 403);
  const gl = (await t.api('PUT', `${c.base}/integrations/gitlab`, { token: c.admin.token })).body.gitlab;
  const hook = (event, payload, secret = gl.secret) => fetch(`${t.base}/api/hooks/gitlab/${c.project.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-event': event, 'x-gitlab-token': secret }, body: JSON.stringify(payload) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const push = { ref: 'refs/heads/main', project: { id: 42, default_branch: 'main' }, commits: [{ id: 'abcdef1234567', message: `Fix rounding\n\nCloses ${c.project.key}-1`, url: 'https://gitlab.com/acme/shop/-/commit/abcdef1', author: { name: 'Ana' } }] };
  assert.equal((await hook('Push Hook', push, 'x'.repeat(gl.secret.length))).status, 401);
  const r = await hook('Push Hook', push);
  assert.deepEqual([r.status, r.body.linked, r.body.closed], [200, [`${c.project.key}-1`], [`${c.project.key}-1`]]);
  const t1 = await Ticket.findOne({ project: c.project.id, number: 1 }).lean();
  assert.deepEqual([t1.status, t1.links[0].kind, Boolean(t1.mergedAt)], ['done', 'commit', true]);

  // With a token, a merge request brings its pipeline status.
  __setGitlabFetch(async (url) => {
    if (url.endsWith('/api/v4/user')) return new Response(JSON.stringify({ username: 'ana' }), { status: 200 });
    if (url.includes('/merge_requests/7')) return new Response(JSON.stringify({ head_pipeline: { status: 'running' } }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const tok = await t.api('PUT', `${c.base}/integrations/gitlab/token`, { token: c.admin.token, body: { token: 'glpat-xxxxxxxxxxxxxxxxxxxx' } });
  assert.deepEqual(tok.body.gitlab.token, { login: 'ana', baseUrl: 'https://gitlab.com' });
  const mr = { user: { username: 'ben' }, project: { id: 42 }, object_attributes: { iid: 7, title: `Faster search ${c.project.key}-2`, description: '', source_branch: 'feat/search', url: 'https://gitlab.com/acme/shop/-/merge_requests/7', state: 'opened', action: 'open', draft: false, detailed_merge_status: 'mergeable' } };
  const opened = await hook('Merge Request Hook', mr);
  assert.deepEqual([opened.body.linked, opened.body.closed, opened.body.pipeline], [[`${c.project.key}-2`], [], 'running']);
  const link = (await Ticket.findOne({ project: c.project.id, number: 2 }).lean()).links[0];
  assert.deepEqual([link.kind, link.ref, link.pr.state, link.pr.pipeline], ['merge_request', '!7', 'opened', 'running']);
  const merged = await hook('Merge Request Hook', { ...mr, object_attributes: { ...mr.object_attributes, state: 'merged', action: 'merge' } });
  assert.deepEqual(merged.body.closed, [], 'a merge closes only with "Closes KEY-n"');
  assert.equal((await Ticket.findOne({ project: c.project.id, number: 2 }).lean()).links[0].pr.state, 'merged', 'the link status follows the merge request');
  __setGitlabFetch(null);
});
