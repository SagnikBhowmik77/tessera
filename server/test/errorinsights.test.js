// Bug intelligence II (E5A) through the API: report history, impact, timeline, environments,
// fix memory and muting (throwaway MongoDB; emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { ErrorOccurrence, Project, Ticket, TicketEvent } from '../src/models/index.js';
import { impactScore, whoOf, environmentsOf } from '../src/services/errorinsights.service.js';

let t;
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail() { return {}; } });
});
after(async () => { __setTransport(null); await t.stop(); });

const TRACE = (second = 'onSubmit', hash = '4f9a2c1e') => `TypeError: Cannot read properties of undefined (reading 'total')
    at calculateTotal (https://shop.example.com/assets/checkout.${hash}.js:120:31)
    at ${second} (https://shop.example.com/assets/checkout.${hash}.js:88:12)`;
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:132.0) Gecko/20100101 Firefox/132.0';

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Crashes', key: `EI${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  return { admin, dev, viewer, project: body.project, url: `/api/projects/${body.project.id}/tickets` };
}

test('impact score: four parts with fixed shares, capped at 100', () => {
  const none = impactScore({ recent: 0, people: 0, comebacks: 0, priority: 'low' });
  assert.deepEqual([none.score, none.level], [0, 'low']);
  const some = impactScore({ recent: 3, people: 1, comebacks: 1, priority: 'high' });
  assert.deepEqual(some.parts.map((p) => p.points), [20, 8, 8, 12]);
  assert.deepEqual([some.score, some.level], [48, 'high']);
  const max = impactScore({ recent: 500, people: 500, comebacks: 9, priority: 'critical' });
  assert.deepEqual([max.score, max.level], [100, 'severe']);
  assert.deepEqual(max.parts.map((p) => p.points), [40, 25, 15, 20]);
});

test('who reported: teammates by id, outside reporters by a hash, never the address', () => {
  assert.equal(whoOf('abc', null), 'user:abc');
  const a = whoOf(null, { email: ' Ana@Example.com ' });
  assert.equal(a, whoOf(null, { email: 'ana@example.com' }));
  assert.match(a, /^email:[0-9a-f]{32}$/);
  assert.equal(a.includes('ana'), false);
  assert.equal(whoOf(null, null), null);
});

test('environments: grouped by browser, version, OS; unknown counted apart', () => {
  const env = environmentsOf([
    { environment: { browser: 'Chrome 130', os: 'Windows' } },
    { environment: { browser: 'Chrome 131', os: 'Windows' } },
    { environment: { browser: 'Firefox 132', os: 'macOS' } },
    { environment: null },
  ]);
  assert.deepEqual(env.browsers, [{ name: 'Chrome', count: 2 }, { name: 'Firefox', count: 1 }]);
  assert.deepEqual(env.os[0], { name: 'Windows', count: 2 });
  assert.equal(env.versions.length, 3);
  assert.deepEqual([env.total, env.unknown], [4, 1]);
});

test('every report is kept: impact, environments and history come from them', async () => {
  const { admin, dev, viewer, url, project } = await team();
  await t.api('POST', url, { token: dev.token, body: { errorText: TRACE(), userAgent: CHROME_WIN, priority: 'high' } });
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE(), userAgent: FIREFOX_MAC } });
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  const rows = await ErrorOccurrence.find({ project: project.id }).sort({ at: 1 }).lean();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.who), [`user:${dev.user.id}`, `user:${admin.user.id}`, `user:${admin.user.id}`]);
  assert.deepEqual(rows[1].environment, { browser: 'Firefox 132', os: 'macOS' });

  const res = await t.api('GET', `${url}/1/error/insights`, { token: viewer.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { insights } = res.body;
  // 3 reports this week (20), 2 people (13), never came back (0), high priority (12).
  assert.deepEqual(insights.impact.parts.map((p) => [p.value, p.points]), [[3, 20], [2, 13], [0, 0], ['high', 12]]);
  assert.equal(insights.impact.score, 45);
  assert.deepEqual(insights.history, { tracked: 3, untracked: 0, since: rows[0].at.toISOString() });
  assert.deepEqual(insights.environments.browsers.map((b) => b.name), ['Chrome', 'Firefox']);
  assert.equal(insights.environments.unknown, 1);
  assert.equal(insights.timeline.days.at(-1).count, 3);
  assert.deepEqual(insights.timeline.markers.map((m) => m.kind), ['created']);

  // A count from before history was kept shows up as untracked, not invented.
  await Ticket.updateOne({ project: project.id, number: 1 }, { $set: { 'error.occurrences': 10 } });
  const later = (await t.api('GET', `${url}/1/error/insights`, { token: viewer.token })).body.insights;
  assert.deepEqual([later.history.tracked, later.history.untracked], [3, 7]);

  // The project's error list ranks by the same score.
  const list = (await t.api('GET', `/api/projects/${project.id}/errors`, { token: viewer.token })).body.errors;
  assert.deepEqual([list[0].impact, list[0].recent, list[0].muted], [{ score: 45, level: 'high' }, 3, false]);
  assert.equal(list[0].topBrowser.name, 'Chrome');

  // Not an error ticket: 404.
  await t.api('POST', url, { token: dev.token, body: { title: 'Plain task' } });
  assert.equal((await t.api('GET', `${url}/2/error/insights`, { token: viewer.token })).status, 404);
});

test('regression timeline and fix memory: fixed, linked, came back', async () => {
  const { admin, dev, url, project } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE(), assigneeId: dev.user.id } });
  const ticket = await Ticket.findOne({ project: project.id, number: 1 });
  // A commit linked while it was being fixed (as the GitHub webhook records it).
  await TicketEvent.create({
    project: project.id, ticket: ticket._id, actor: null, source: 'github', type: 'linked',
    to: { kind: 'commit', url: 'https://github.com/acme/shop/commit/abc1234', title: 'Guard empty cart', ref: 'abc1234' },
  });
  await t.api('POST', `${url}/1/move`, { token: dev.token, body: { status: 'done' } });
  const back = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  assert.equal(back.body.regression, true);

  const { insights } = (await t.api('GET', `${url}/1/error/insights`, { token: dev.token })).body;
  assert.deepEqual(insights.timeline.markers.map((m) => m.kind), ['created', 'linked', 'fixed', 'regressed']);
  assert.equal(insights.fixes.length, 1);
  const [fix] = insights.fixes;
  assert.equal(fix.by.name, 'Dev');
  assert.deepEqual(fix.links.map((l) => l.ref), ['abc1234']);
  assert.ok(fix.cameBackAt, 'records when it came back');
  // One comeback: 7.5 rounds to 8 points.
  assert.equal(insights.impact.parts.find((p) => p.key === 'comebacks').points, 8);
  const occ = await ErrorOccurrence.find({ ticket: ticket._id }).sort({ at: 1 }).lean();
  assert.deepEqual(occ.map((o) => o.regression), [false, true]);
});

test('fix memory for a new crash: similar finished tickets and how they were fixed', async () => {
  const { admin, dev, url, project } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('onSubmit') } });
  await Ticket.updateOne({ project: project.id, number: 1 }, { $push: { links: { kind: 'pull_request', url: 'https://github.com/acme/shop/pull/7', title: 'Fix totals', ref: '#7', author: 'dev' } } });
  await t.api('POST', `${url}/1/move`, { token: dev.token, body: { status: 'done' } });

  // Same error type and top frame, but reached another way: a different crash (new fingerprint).
  const preview = (await t.api('POST', `${url}/parse-error`, { token: dev.token, body: { text: TRACE('applyCoupon') } })).body;
  assert.equal(preview.seenBefore, null);
  assert.equal(preview.fixedBefore.length, 1);
  assert.equal(preview.fixedBefore[0].number, 1);
  assert.deepEqual(preview.fixedBefore[0].because, ['same TypeError', 'both fail in calculateTotal (checkout.js)', 'same message']);
  assert.deepEqual(preview.fixedBefore[0].links.map((l) => l.ref), ['#7']);

  // Once created, the drawer shows the same match; an unrelated crash matches nothing.
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE('applyCoupon') } });
  const { insights } = (await t.api('GET', `${url}/2/error/insights`, { token: dev.token })).body;
  assert.deepEqual(insights.related.map((r) => r.number), [1]);
  const other = (await t.api('POST', `${url}/parse-error`, { token: dev.token, body: { text: 'KeyError: user_id' } })).body;
  assert.deepEqual(other.fixedBefore, []);
});

test('muted errors are counted but do not reopen, notify or count as comebacks', async () => {
  const { admin, dev, viewer, url, project } = await team();
  await t.api('POST', url, { token: admin.token, body: { errorText: TRACE(), assigneeId: dev.user.id } });
  await t.api('POST', `${url}/1/move`, { token: dev.token, body: { status: 'done' } });

  assert.equal((await t.api('PUT', `${url}/1/error/mute`, { token: viewer.token, body: { for: '7d' } })).status, 403);
  assert.equal((await t.api('PUT', `${url}/1/error/mute`, { token: dev.token, body: { for: '2w' } })).status, 400);
  const muted = await t.api('PUT', `${url}/1/error/mute`, { token: dev.token, body: { for: '7d', reason: 'Old app version, users are being upgraded' } });
  assert.equal(muted.status, 200);
  assert.equal(muted.body.mute.active, true);
  assert.equal(muted.body.mute.reason, 'Old app version, users are being upgraded');

  await flushNotifications();
  const before = (await t.api('GET', '/api/notifications', { token: dev.token })).body.notifications.length;
  const again = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  assert.deepEqual([again.body.grouped, again.body.regression, again.body.ticket.status], [true, false, 'done']);
  assert.equal(again.body.ticket.error.occurrences, 2);
  assert.equal(again.body.ticket.error.muted.active, true);
  await flushNotifications();
  assert.equal((await t.api('GET', '/api/notifications', { token: dev.token })).body.notifications.length, before);
  const last = await ErrorOccurrence.findOne({ project: project.id }).sort({ at: -1 }).lean();
  assert.deepEqual([last.muted, last.regression], [true, false]);

  // The paste preview says it is muted.
  const preview = (await t.api('POST', `${url}/parse-error`, { token: dev.token, body: { text: TRACE() } })).body;
  assert.equal(preview.seenBefore.muted, true);

  // Unmuted: the next report reopens it as usual.
  assert.equal((await t.api('DELETE', `${url}/1/error/mute`, { token: dev.token })).status, 200);
  const reopened = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  assert.deepEqual([reopened.body.regression, reopened.body.ticket.status, reopened.body.ticket.error.muted], [true, 'todo', null]);
  const { insights } = (await t.api('GET', `${url}/1/error/insights`, { token: dev.token })).body;
  assert.deepEqual(insights.timeline.markers.map((m) => m.kind), ['created', 'fixed', 'muted', 'unmuted', 'regressed']);
  const history = (await t.api('GET', `${url}/1/history`, { token: dev.token })).body.events.map((e) => e.type);
  assert.ok(history.includes('error_muted') && history.includes('error_unmuted'));

  // An expired mute no longer holds anything back.
  await t.api('POST', `${url}/1/move`, { token: dev.token, body: { status: 'done' } });
  await t.api('PUT', `${url}/1/error/mute`, { token: dev.token, body: { for: '1h' } });
  await Ticket.updateOne({ project: project.id, number: 1 }, { $set: { 'error.muted.until': new Date(Date.now() - 1000) } });
  const expired = await t.api('POST', url, { token: admin.token, body: { errorText: TRACE() } });
  assert.equal(expired.body.regression, true);
  // Only tickets made from an error can be muted.
  await t.api('POST', url, { token: dev.token, body: { title: 'Plain task' } });
  assert.equal((await t.api('PUT', `${url}/2/error/mute`, { token: dev.token, body: { for: '1d' } })).status, 400);
});

test('portal reports count distinct outside people', async () => {
  const { admin, url, project } = await team();
  const portal = await t.api('PUT', `/api/projects/${project.id}/portal`, { token: admin.token, body: { enabled: true } });
  const token = portal.body.portal.url.split('/report/')[1];
  for (const email of ['ana@example.org', 'ben@example.org', 'ANA@example.org']) {
    const r = await t.api('POST', `/api/portal/${token}/reports`, {
      body: { title: 'Checkout crashed', description: 'It broke when I paid', name: 'Someone', email, errorText: TRACE() },
      headers: { 'user-agent': CHROME_WIN },
    });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  }
  const rows = await ErrorOccurrence.find({ project: project.id }).lean();
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.who)).size, 2);
  assert.ok(rows.every((r) => r.source === 'portal' && !String(r.who).includes('@')));
  assert.deepEqual(rows[0].environment, { browser: 'Chrome 130', os: 'Windows' });
  const { insights } = (await t.api('GET', `${url}/1/error/insights`, { token: admin.token })).body;
  assert.equal(insights.impact.parts.find((p) => p.key === 'reach').value, 2);
  assert.equal(await Ticket.countDocuments({ project: project.id }), 1);
});

test('every outside reporter of a known crash is told when it is fixed, as the portal promises', async () => {
  const { admin, url, project } = await team();
  const portal = await t.api('PUT', `/api/projects/${project.id}/portal`, { token: admin.token, body: { enabled: true } });
  const token = portal.body.portal.url.split('/report/')[1];
  const send = (extra) => t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Checkout crashed', errorText: TRACE(), ...extra } });
  const answers = [];
  for (const extra of [{ name: 'Ana', email: 'ana@example.org' }, { email: 'ben@example.org' }, { email: 'ANA@example.org' }, {}]) {
    answers.push((await send(extra)).body);
  }
  assert.deepEqual(answers.map((a) => [a.alreadyKnown, a.willEmail]), [[false, true], [true, true], [true, true], [true, false]]);
  const stored = await Ticket.findOne({ project: project.id, number: 1 }).lean();
  assert.equal(stored.contact.email, 'ana@example.org');
  assert.deepEqual(stored.otherReporters.map((r) => r.email), ['ben@example.org']);
  // The team sees how many, not the addresses.
  assert.equal((await t.api('GET', `${url}/1`, { token: admin.token })).body.ticket.otherReporters, 1);

  const sent = [];
  __setTransport({ async sendMail(m) { sent.push([m.to, m.subject]); return {}; } });
  await t.api('POST', `${url}/1/accept`, { token: admin.token });
  await t.api('POST', `${url}/1/move`, { token: admin.token, body: { status: 'done' } });
  await flushNotifications();
  __setTransport({ async sendMail() { return {}; } });
  const fixed = sent.filter(([, s]) => s.startsWith('Fixed:')).map(([to]) => to).sort();
  assert.deepEqual(fixed, ['ana@example.org', 'ben@example.org']);
});
