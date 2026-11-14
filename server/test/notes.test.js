// Handoff notes, pinned decisions, and internal notes vs replies to the reporter (throwaway MongoDB;
// emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Comment, Project, Ticket } from '../src/models/index.js';

let t;
let outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await jsonTransport.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
});
after(async () => { await flushNotifications(); __setTransport(null); await t.stop(); });

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const dev2 = await t.signUp('Dev Two');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Notes', key: `NT${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [
    { user: dev.user.id, role: 'developer' }, { user: dev2.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' },
  ] } } });
  return { admin, dev, dev2, viewer, project: body.project, url: `/api/projects/${body.project.id}/tickets` };
}
const inbox = async (who) => (await t.api('GET', '/api/notifications', { token: who.token })).body.notifications;

test('handoff: the note is saved as a handoff comment and reaches the new assignee', async () => {
  const { admin, dev, dev2, url } = await team();
  const { body } = await t.api('POST', url, { token: admin.token, body: { title: 'Payment page times out', assigneeId: dev.user.id } });
  const ref = body.ticket.key;
  await flushNotifications();
  outbox = [];

  const note = 'Logs are in the gateway dashboard. It only happens with saved cards; I suspect the retry loop.';
  const res = await t.api('PATCH', `${url}/${ref}`, { token: dev.token, body: { assigneeId: dev2.user.id, handoffNote: note } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ticket.assignee.id, dev2.user.id);

  const comments = (await t.api('GET', `${url}/${ref}/comments`, { token: admin.token })).body.comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].kind, 'handoff');
  assert.equal(comments[0].body, note);
  assert.equal(comments[0].author.name, 'Dev');

  const assigned = (await inbox(dev2)).find((n) => n.type === 'assigned');
  assert.ok(assigned.excerpt.startsWith('Logs are in the gateway dashboard'));
  await flushNotifications();
  const mail = outbox.find((m) => m.to.some((x) => x.address === dev2.user.email));
  assert.ok(mail, 'the new assignee is emailed while away');
  assert.match(mail.text, /saved cards/);

  // A note without a reassignment is refused, and nothing is saved.
  const noMove = await t.api('PATCH', `${url}/${ref}`, { token: dev2.token, body: { assigneeId: dev2.user.id, handoffNote: 'hi' } });
  assert.equal(noMove.status, 400);
  assert.equal(noMove.body.error.code, 'handoff_without_reassign');
  assert.equal(await Comment.countDocuments({ ticket: body.ticket.id }), 1);
});

test('decisions: developers pin and unpin, viewers cannot, deleting unpins, history records it', async () => {
  const { admin, dev, viewer, url } = await team();
  const { body } = await t.api('POST', url, { token: admin.token, body: { title: 'Pick a payment provider' } });
  const ref = body.ticket.key;
  const c = (await t.api('POST', `${url}/${ref}/comments`, { token: admin.token, body: { body: 'Decision: we go with Razorpay, Stripe is not live in India for us.' } })).body.comment;

  assert.equal((await t.api('PUT', `${url}/${ref}/comments/${c.id}/pin`, { token: viewer.token })).status, 403);
  const pinned = await t.api('PUT', `${url}/${ref}/comments/${c.id}/pin`, { token: dev.token });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.ok(pinned.body.comment.pinnedAt);
  assert.equal(pinned.body.comment.pinnedBy.name, 'Dev');

  const listed = (await t.api('GET', `${url}/${ref}/comments`, { token: viewer.token })).body.comments[0];
  assert.equal(listed.pinnedBy.name, 'Dev');
  const history = (await t.api('GET', `${url}/${ref}/history`, { token: admin.token })).body.events;
  const ev = history.find((e) => e.type === 'decision_pinned');
  assert.match(ev.to.excerpt, /Razorpay/);

  const unpinned = await t.api('DELETE', `${url}/${ref}/comments/${c.id}/pin`, { token: dev.token });
  assert.equal(unpinned.body.comment.pinnedAt, null);
  await t.api('PUT', `${url}/${ref}/comments/${c.id}/pin`, { token: dev.token });
  await t.api('DELETE', `${url}/${ref}/comments/${c.id}`, { token: admin.token });
  const gone = await Comment.findById(c.id).lean();
  assert.equal(gone.pinnedAt, null, 'a deleted comment is not a decision');
});

test('internal notes stay in the team; replies to the reporter are emailed to them', async () => {
  const { admin, dev, viewer, url } = await team();
  const { body } = await t.api('POST', url, { token: admin.token, body: { title: 'Coupon rejected', type: 'bug' } });
  const ref = body.ticket.key;
  await Ticket.updateOne({ _id: body.ticket.id }, { $set: { contact: { name: 'Priya', email: 'priya.customer@example.org' }, source: 'portal' } });
  await flushNotifications();
  outbox = [];

  const internal = await t.api('POST', `${url}/${ref}/comments`, { token: dev.token, body: { body: 'Internal: probably the new rounding code.' } });
  assert.equal(internal.status, 201);
  assert.equal(internal.body.comment.visibility, 'internal');
  assert.equal(internal.body.comment.sentTo, null);

  const reply = await t.api('POST', `${url}/${ref}/comments`, {
    token: dev.token,
    body: { body: `Thanks Priya, @[Admin](${admin.user.id}) found the cause. A fix ships tomorrow.`, visibility: 'reporter' },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.comment.visibility, 'reporter');
  assert.equal(reply.body.comment.sentTo, 'priya.customer@example.org');
  assert.ok(reply.body.comment.sentAt);
  assert.equal(reply.body.comment.author.name, 'Dev');

  await flushNotifications();
  const toReporter = outbox.filter((m) => m.to.some((x) => x.address === 'priya.customer@example.org'));
  assert.equal(toReporter.length, 1, 'only the reply is emailed to the reporter');
  assert.match(toReporter[0].subject, /^Re: Coupon rejected/);
  assert.match(toReporter[0].text, /Hi Priya, Dev from the Notes team replied/);
  assert.match(toReporter[0].text, /@Admin found the cause/, 'mentions become plain names');
  assert.doesNotMatch(toReporter[0].text, /rounding code/, 'internal notes never go out');

  const asViewer = await t.api('POST', `${url}/${ref}/comments`, { token: viewer.token, body: { body: 'hi', visibility: 'reporter' } });
  assert.equal(asViewer.status, 403);
  const inThread = await t.api('POST', `${url}/${ref}/comments`, { token: dev.token, body: { body: 'hi', visibility: 'reporter', parentId: internal.body.comment.id } });
  assert.equal(inThread.body.error.code, 'reporter_reply_in_thread');

  const plain = (await t.api('POST', url, { token: admin.token, body: { title: 'Team-only ticket' } })).body.ticket;
  const noReporter = await t.api('POST', `${url}/${plain.key}/comments`, { token: dev.token, body: { body: 'hi', visibility: 'reporter' } });
  assert.equal(noReporter.body.error.code, 'no_reporter');
});
