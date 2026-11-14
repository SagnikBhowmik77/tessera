// Client-facing (E11): private tracking links with a two-way conversation, "fixed / still broken",
// merged duplicate reports, the public roadmap with voting, and read-only board links
// (throwaway MongoDB; emails captured).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Project, RoadmapVote, Ticket, Tracker } from '../src/models/index.js';

let t;
let outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await jsonTransport.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
});
after(async () => { __setTransport(null); await t.stop(); });
beforeEach(() => { outbox = []; });

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `CF${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  const base = `/api/projects/${body.project.id}`;
  const portal = (await t.api('PUT', `${base}/portal`, { token: admin.token, body: { enabled: true } })).body.portal.url.split('/report/')[1];
  const report = async (b) => (await t.api('POST', `/api/portal/${portal}/reports`, { body: b })).body;
  return { admin, dev, viewer, project: body.project, base, report };
}
const tokenOf = (url) => url.split('/track/')[1];

test('tracking link: progress, a two-way conversation, and "still broken" reopens it', async () => {
  const c = await team();
  const sent = await c.report({ title: 'Cannot pay with UPI', name: 'Meera', email: 'meera@example.com' });
  const tk = tokenOf(sent.trackUrl);
  await flushNotifications();
  const receipt = outbox.find((m) => m.to[0].address === 'meera@example.com');
  assert.ok(receipt.text.includes(sent.trackUrl), 'the receipt carries the private link');
  assert.ok(!/reply to this email/i.test(receipt.text), 'no promise of email replies Tessera cannot receive');

  let page = (await t.api('GET', `/api/track/${tk}`)).body.report;
  assert.deepEqual([page.reference, page.title, page.state, page.canAnswer, page.messages], [`${c.project.key}-1`, 'Cannot pay with UPI', 'received', false, []]);
  assert.equal((await t.api('GET', '/api/track/aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);

  // The reporter writes; the project's managers hear (nobody is assigned yet).
  page = (await t.api('POST', `/api/track/${tk}/messages`, { body: { body: 'It happens on Android only.' } })).body.report;
  assert.deepEqual(page.messages.map((m) => [m.from, m.name, m.body]), [['you', 'Meera', 'It happens on Android only.']]);
  await flushNotifications();
  const inbox = (await t.api('GET', '/api/notifications', { token: c.admin.token })).body.notifications;
  assert.equal(inbox[0].type, 'reporter_message');
  assert.match(inbox[0].excerpt, /^Meera: It happens on Android only\./);
  const thread = (await t.api('GET', `${c.base}/tickets/1/comments`, { token: c.dev.token })).body.comments;
  assert.deepEqual(thread.map((x) => [x.fromReporter, x.external?.login, x.visibility]), [[true, 'Meera', 'reporter']]);

  // The team answers @-mentioning a teammate: the reporter sees a plain name, by email and on the page.
  outbox = [];
  await t.api('POST', `${c.base}/tickets/1/comments`, { token: c.dev.token, body: { body: `Thanks! @[Admin](${c.admin.user.id}) is on it.`, visibility: 'reporter' } });
  await t.api('POST', `${c.base}/tickets/1/comments`, { token: c.dev.token, body: { body: 'Internal: probably the UPI SDK.' } });
  await flushNotifications();
  const reply = outbox.find((m) => m.to[0].address === 'meera@example.com');
  assert.ok(reply.text.includes('Thanks! @Admin is on it.') && reply.text.includes(sent.trackUrl));
  page = (await t.api('GET', `/api/track/${tk}`)).body.report;
  assert.deepEqual(page.messages.map((m) => [m.from, m.body]), [['you', 'It happens on Android only.'], ['team', 'Thanks! @Admin is on it.']], 'internal comments never show');

  await t.api('POST', `${c.base}/tickets/1/accept`, { token: c.dev.token });
  await t.api('PATCH', `${c.base}/tickets/1`, { token: c.admin.token, body: { assigneeId: c.dev.user.id } });
  assert.equal((await t.api('POST', `/api/track/${tk}/answer`, { body: { answer: 'fixed' } })).body.error.code, 'not_fixed');
  await t.api('POST', `${c.base}/tickets/1/move`, { token: c.dev.token, body: { status: 'in_progress' } });
  assert.equal((await t.api('GET', `/api/track/${tk}`)).body.report.state, 'in_progress');

  outbox = [];
  await t.api('POST', `${c.base}/tickets/1/move`, { token: c.dev.token, body: { status: 'done' } });
  await flushNotifications();
  const fixed = outbox.find((m) => m.subject.startsWith('Fixed:'));
  assert.ok(fixed.text.includes(`${sent.trackUrl}?answer=fixed`) && fixed.text.includes(`${sent.trackUrl}?answer=broken`));
  assert.ok(fixed.html.includes(`href="${sent.trackUrl}?answer=broken"`), 'the links are clickable');

  page = (await t.api('POST', `/api/track/${tk}/answer`, { body: { answer: 'broken' } })).body.report;
  assert.equal(page.state, 'accepted', 'reopened');
  assert.equal((await Ticket.findOne({ project: c.project.id, number: 1 }).lean()).status, 'todo');
  await flushNotifications();
  const devInbox = (await t.api('GET', '/api/notifications', { token: c.dev.token })).body.notifications;
  assert.equal(devInbox[0].type, 'reporter_answer');
  const history = (await t.api('GET', `${c.base}/tickets/1/history`, { token: c.dev.token })).body.events;
  assert.ok(history.some((e) => e.type === 'reporter_answer' && e.to.value === 'broken'));

  // Fixed again: the old answer no longer counts and they can confirm this time.
  await new Promise((r) => setTimeout(r, 5));
  await t.api('POST', `${c.base}/tickets/1/move`, { token: c.dev.token, body: { status: 'done' } });
  assert.equal((await t.api('GET', `/api/track/${tk}`)).body.report.answer, null);
  assert.equal((await t.api('POST', `/api/track/${tk}/answer`, { body: { answer: 'fixed' } })).body.report.answer.value, 'fixed');
  const reporters = (await t.api('GET', `${c.base}/tickets/1/reporters`, { token: c.dev.token })).body.reporters;
  assert.deepEqual(reporters.map((r) => [r.name, r.email, r.answer.value]), [['Meera', 'meera@example.com', 'fixed']]);
  assert.equal((await t.api('GET', `${c.base}/tickets/1/reporters`, { token: c.viewer.token })).status, 403, 'outside addresses stay with the people who work on tickets');
});

test('a reporter without an email still gets their answers on the page', async () => {
  const c = await team();
  const sent = await c.report({ title: 'Typo on the pricing page' });
  await t.api('POST', `${c.base}/tickets/1/comments`, { token: c.dev.token, body: { body: 'Fixed the typo, thanks.', visibility: 'reporter' } });
  await flushNotifications();
  assert.equal(outbox.filter((m) => m.subject.startsWith('Re:')).length, 0);
  const page = (await t.api('GET', `/api/track/${tokenOf(sent.trackUrl)}`)).body.report;
  assert.deepEqual(page.messages.map((m) => m.body), ['Fixed the typo, thanks.']);
  await t.api('POST', `${c.base}/tickets`, { token: c.dev.token, body: { title: 'Made by the team' } });
  assert.equal((await t.api('POST', `${c.base}/tickets/2/comments`, { token: c.dev.token, body: { body: 'hi', visibility: 'reporter' } })).body.error.code, 'no_reporter');
});

test('merging duplicates: every reporter moves over, keeps their link, and hears when it is fixed', async () => {
  const c = await team();
  const a = await c.report({ title: 'Checkout is slow', name: 'Ana', email: 'ana@example.com' });
  const b = await c.report({ title: 'Payment takes forever', name: 'Ben', email: 'ben@example.com' });
  await flushNotifications();
  outbox = [];
  assert.equal((await t.api('POST', `${c.base}/tickets/2/merge`, { token: c.viewer.token, body: { into: '1' } })).status, 403);
  assert.equal((await t.api('POST', `${c.base}/tickets/2/merge`, { token: c.dev.token, body: { into: '2' } })).body.error.code, 'same_ticket');
  const merged = (await t.api('POST', `${c.base}/tickets/2/merge`, { token: c.dev.token, body: { into: `${c.project.key}-1` } })).body;
  assert.equal(merged.reportersMoved, 1);
  assert.equal(merged.ticket.otherReporters, 1);
  const dup = (await t.api('GET', `${c.base}/tickets/2`, { token: c.dev.token })).body.ticket;
  assert.deepEqual([dup.duplicateOf, dup.status, dup.labels.includes('duplicate'), dup.contact], [`${c.project.key}-1`, 'done', true, null]);
  assert.equal((await t.api('POST', `${c.base}/tickets/2/merge`, { token: c.dev.token, body: { into: '1' } })).body.error.code, 'already_merged');
  await flushNotifications();
  assert.deepEqual(outbox.map((m) => [m.to[0].address, m.subject]), [['ben@example.com', `Your report "Payment takes forever" is now followed as ${c.project.key}-1`]], 'closing the duplicate emailed nobody "fixed"');

  const benPage = (await t.api('GET', `/api/track/${tokenOf(b.trackUrl)}`)).body.report;
  assert.deepEqual([benPage.reference, benPage.title, benPage.merged], [`${c.project.key}-1`, 'Payment takes forever', true]);

  outbox = [];
  await t.api('POST', `${c.base}/tickets/1/accept`, { token: c.dev.token });
  await t.api('POST', `${c.base}/tickets/1/move`, { token: c.dev.token, body: { status: 'done' } });
  await flushNotifications();
  assert.deepEqual(outbox.map((m) => m.to[0].address).sort(), ['ana@example.com', 'ben@example.com']);
  assert.ok(outbox.find((m) => m.to[0].address === 'ben@example.com').text.includes(b.trackUrl));
  assert.ok(outbox.find((m) => m.to[0].address === 'ana@example.com').text.includes(a.trackUrl));
});

test('public roadmap: managers choose what is on it, visitors vote once per browser', async () => {
  const c = await team();
  for (const title of ['Dark mode', 'Export to PDF', 'Old thing']) await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title, type: 'feature' } });
  assert.equal((await t.api('PUT', `${c.base}/roadmap`, { token: c.dev.token, body: { enabled: true } })).status, 403);
  const url = (await t.api('PUT', `${c.base}/roadmap`, { token: c.admin.token, body: { enabled: true, intro: 'What we are building' } })).body.roadmap.url;
  const rt = url.split('/roadmap/')[1];
  assert.equal((await t.api('PUT', `${c.base}/tickets/1/roadmap`, { token: c.dev.token, body: { onRoadmap: true } })).status, 403);
  for (const k of [1, 2, 3]) await t.api('PUT', `${c.base}/tickets/${k}/roadmap`, { token: c.admin.token, body: { onRoadmap: true } });
  await t.api('POST', `${c.base}/tickets/3/move`, { token: c.admin.token, body: { status: 'done' } });

  const ana = { 'x-roadmap-voter': 'browser-ana-0123456789' };
  const ben = { 'x-roadmap-voter': 'browser-ben-0123456789' };
  const vote = (num, headers) => t.api('POST', `/api/roadmap/${rt}/items/${num}/vote`, { headers });
  assert.deepEqual((await vote(2, ana)).body, { number: 2, votes: 1, voted: true });
  await vote(2, ben);
  await vote(1, ben);
  assert.deepEqual((await vote(1, ben)).body, { number: 1, votes: 0, voted: false }, 'voting again takes it back');
  assert.equal((await vote(3, ana)).body.error.code, 'item_done');
  assert.equal((await vote(2, {})).body.error.code, 'invalid_voter');

  const pub = (await t.api('GET', `/api/roadmap/${rt}`, { headers: ana })).body;
  assert.equal(pub.intro, 'What we are building');
  assert.deepEqual(pub.items.map((i) => [i.title, i.stage, i.votes, i.voted]), [['Export to PDF', 'planned', 2, true], ['Dark mode', 'planned', 0, false], ['Old thing', 'done', 0, false]]);
  assert.ok(!JSON.stringify(pub).includes('browser-ana'), 'voter ids are not echoed back');
  assert.ok((await RoadmapVote.find({ project: c.project.id }).lean()).every((v) => /^[a-f0-9]{64}$/.test(v.voter)), 'only hashes are stored');
  const forTeam = (await t.api('GET', `${c.base}/roadmap`, { token: c.viewer.token })).body;
  assert.deepEqual([forTeam.roadmap.url, forTeam.items[0].votes], [null, 2]);

  await t.api('PUT', `${c.base}/roadmap`, { token: c.admin.token, body: { enabled: false } });
  assert.equal((await t.api('GET', `/api/roadmap/${rt}`)).status, 404);
});

test('read-only board links: no login, optional names, revocable', async () => {
  const c = await team();
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Build login', assigneeId: c.dev.user.id, labels: ['auth'] } });
  await c.report({ title: 'Untriaged report', email: 'x@example.com' });
  assert.equal((await t.api('POST', `${c.base}/share-links`, { token: c.dev.token, body: { name: 'Client' } })).status, 403);
  const plain = (await t.api('POST', `${c.base}/share-links`, { token: c.admin.token, body: { name: 'Client: Acme' } })).body.link;
  const named = (await t.api('POST', `${c.base}/share-links`, { token: c.admin.token, body: { name: 'Investors', showPeople: true } })).body.link;
  const st = (l) => l.url.split('/shared/')[1];

  const board = (await t.api('GET', `/api/shared/${st(plain)}`)).body;
  assert.deepEqual(board.tickets.map((x) => [x.key, x.title, x.labels, 'assignee' in x]), [[`${c.project.key}-1`, 'Build login', ['auth'], false]], 'triage reports and people stay hidden');
  assert.ok(!JSON.stringify(board).includes('example.com'));
  assert.equal((await t.api('GET', `/api/shared/${st(named)}`)).body.tickets[0].assignee, 'Dev');

  const listed = (await t.api('GET', `${c.base}/share-links`, { token: c.admin.token })).body.links;
  assert.ok(listed.find((l) => l.id === plain.id).lastUsedAt, 'last use is shown to the team');
  const revoked = (await t.api('DELETE', `${c.base}/share-links/${plain.id}`, { token: c.admin.token })).body.link;
  assert.deepEqual([revoked.url, Boolean(revoked.revokedAt)], [null, true]);
  assert.equal((await t.api('GET', `/api/shared/${st(plain)}`)).status, 404);
  assert.equal((await t.api('GET', `/api/shared/${st(named)}`)).status, 200, 'other links keep working');
});

test('deleting a project removes its trackers', async () => {
  const c = await team();
  await c.report({ title: 'Something broke' });
  assert.equal(await Tracker.countDocuments({ project: c.project.id }), 1);
  await t.api('DELETE', `/api/projects/${c.project.id}`, { token: c.admin.token, body: { confirmKey: c.project.key } });
  assert.equal(await Tracker.countDocuments({ project: c.project.id }), 0);
});
