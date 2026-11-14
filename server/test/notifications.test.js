// Notifications and the workload heatmap against a real throwaway MongoDB.
// Emails go to nodemailer's JSON transport (captured here), never a real inbox.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { io as connect } from 'socket.io-client';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Project } from '../src/models/index.js';
import { addDays, todayIn } from '../src/dates.js';

let t;
let outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
const capturing = {
  async sendMail(message) {
    const info = await jsonTransport.sendMail(message);
    const mail = JSON.parse(info.message);
    // Sign-ups also send an email-verification link; these tests count the other emails.
    if (!/^Confirm your email/.test(mail.subject)) outbox.push(mail);
    return info;
  },
};
const sockets = [];
before(async () => { t = await startTestServer(); __setTransport(capturing); });
after(async () => {
  for (const s of sockets) s.disconnect();
  __setTransport(null);
  await t.stop();
});
beforeEach(() => { outbox = []; });

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const dev2 = await t.signUp('Dev Two');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Notify', key: `NT${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, {
    $push: { members: { $each: [
      { user: dev.user.id, role: 'developer' }, { user: dev2.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' },
    ] } },
  });
  return { admin, dev, dev2, viewer, project: body.project, url: `/api/projects/${body.project.id}/tickets` };
}
const inbox = async (who, qs = '') => (await t.api('GET', `/api/notifications${qs}`, { token: who.token })).body;
const mention = (p) => `@[${p.user.name}](${p.user.id})`;

test('assigning someone notifies them (not when you assign yourself), and emails them while away', async () => {
  const { admin, dev, url, project } = await team();
  await t.api('POST', url, { token: admin.token, body: { title: 'Fix login', assigneeId: dev.user.id } });
  await t.api('POST', url, { token: admin.token, body: { title: 'Mine', assigneeId: admin.user.id } });
  await flushNotifications();

  const box = await inbox(dev);
  assert.equal(box.unread, 1);
  const [n] = box.notifications;
  assert.deepEqual([n.type, n.ticketKey, n.ticketTitle, n.actor.name], ['assigned', `${project.key}-1`, 'Fix login', 'Admin']);
  assert.equal((await inbox(admin)).unread, 0);

  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to[0].address, dev.email);
  assert.equal(outbox[0].subject, `Admin assigned ${project.key}-1 to you: Fix login`);
  assert.ok(outbox[0].text.includes(`/projects/${project.id}/tickets/${project.key}-1`));
});

test('comments: mentions first, then reporter and assignee; the author hears nothing', async () => {
  const { admin, dev, dev2, viewer, url } = await team();
  await t.api('POST', url, { token: dev.token, body: { title: 'Bug', assigneeId: dev2.user.id } });
  await flushNotifications();
  outbox = [];
  await t.api('POST', `${url}/1/comments`, { token: viewer.token, body: { body: `${mention(dev)} ${mention(admin)} can you look at **this**?` } });
  await flushNotifications();

  // dev reported it AND is mentioned: one "mention", no extra "comment".
  assert.deepEqual((await inbox(dev)).notifications.map((n) => n.type), ['mention']);
  assert.deepEqual((await inbox(admin)).notifications.map((n) => n.type), ['mention']);
  assert.deepEqual((await inbox(dev2)).notifications.map((n) => n.type), ['comment', 'assigned']);
  assert.equal((await inbox(viewer)).unread, 0);
  const m = (await inbox(admin)).notifications[0];
  assert.equal(m.excerpt, '@Dev @Admin can you look at **this**?');

  // Emails only for mentions (not plain comments).
  assert.deepEqual(outbox.map((e) => e.subject), [
    `Viewer mentioned you on ${m.ticketKey}: Bug`, `Viewer mentioned you on ${m.ticketKey}: Bug`,
  ]);

  // Editing a comment only notifies people newly mentioned.
  const c = (await t.api('POST', `${url}/1/comments`, { token: admin.token, body: { body: `${mention(dev2)} fyi` } })).body.comment;
  await t.api('PATCH', `${url}/1/comments/${c.id}`, { token: admin.token, body: { body: `${mention(dev2)} ${mention(viewer)} fyi` } });
  await flushNotifications();
  assert.deepEqual((await inbox(viewer)).notifications.map((n) => n.type), ['mention']);
  assert.equal((await inbox(dev2)).notifications.filter((n) => n.type === 'mention').length, 1);
});

test('finishing a ticket tells its reporter', async () => {
  const { admin, dev, url } = await team();
  await t.api('POST', url, { token: dev.token, body: { title: 'Please fix' } });
  await t.api('POST', `${url}/1/move`, { token: admin.token, body: { status: 'done' } });
  await t.api('POST', `${url}/1/move`, { token: admin.token, body: { status: 'done', after: null } });
  await flushNotifications();
  assert.deepEqual((await inbox(dev)).notifications.map((n) => n.type), ['resolved']);
});

test('read and unread', async () => {
  const { admin, dev, url } = await team();
  for (const title of ['A', 'B', 'C']) await t.api('POST', url, { token: admin.token, body: { title, assigneeId: dev.user.id } });
  await flushNotifications();
  const box = await inbox(dev);
  assert.equal(box.unread, 3);
  const one = await t.api('POST', '/api/notifications/read', { token: dev.token, body: { ids: [box.notifications[0].id] } });
  assert.equal(one.body.unread, 2);
  assert.equal((await inbox(dev, '?unread=true')).notifications.length, 2);
  // Someone else's ids do nothing.
  const other = await t.api('POST', '/api/notifications/read', { token: admin.token, body: { ids: [box.notifications[1].id] } });
  assert.equal(other.status, 200);
  assert.equal((await inbox(dev)).unread, 2);
  assert.equal((await t.api('POST', '/api/notifications/read', { token: dev.token, body: {} })).body.unread, 0);
  assert.equal((await inbox(dev, '?limit=2')).notifications.length, 2);
  assert.equal((await t.api('GET', '/api/notifications?limit=0', { token: dev.token })).status, 400);
});

test('online people get it live instead of by email; the email setting is respected', async () => {
  const { admin, dev, dev2, url } = await team();
  const s = connect(t.base, { auth: { token: dev.token }, transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  await new Promise((resolve) => s.once('connect', resolve));

  const live = new Promise((resolve) => s.once('notification', resolve));
  const count = new Promise((resolve) => s.once('notification:count', resolve));
  await t.api('POST', url, { token: admin.token, body: { title: 'While online', assigneeId: dev.user.id } });
  const n = await live;
  assert.equal(n.type, 'assigned');
  assert.equal(n.actor.name, 'Admin');
  assert.deepEqual(await count, { unread: 1 });

  // dev2 turned emails off.
  assert.equal((await t.api('PATCH', '/api/auth/me', { token: dev2.token, body: { emailNotifications: false } })).body.user.emailNotifications, false);
  await t.api('POST', url, { token: admin.token, body: { title: 'Quiet', assigneeId: dev2.user.id } });
  await flushNotifications();
  assert.equal(outbox.length, 0, 'no email for the online person, none for the one who opted out');
  assert.equal((await inbox(dev2)).unread, 1, 'but the in-app notification is still there');
});

test('notifications with no person behind them (portal, GitHub) still arrive live', async () => {
  const { admin, project } = await team();
  const settings = await t.api('PUT', `/api/projects/${project.id}/portal`, { token: admin.token, body: { enabled: true } });
  const token = settings.body.portal.url.split('/report/')[1];
  const s = connect(t.base, { auth: { token: admin.token }, transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  await new Promise((resolve) => s.once('connect', resolve));
  const live = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no live notification')), 3000);
    s.once('notification', (n) => { clearTimeout(timer); resolve(n); });
  });
  await t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Portal report with no actor' } });
  const n = await live;
  assert.deepEqual([n.type, n.actor], ['portal_report', null]);
});

test('workload heatmap: open work per person by priority and due date, with a load level', async () => {
  const { admin, dev, dev2, viewer, url, project } = await team();
  const today = todayIn();
  const make = (b) => t.api('POST', url, { token: admin.token, body: b });
  await make({ title: 'c1', priority: 'critical', assigneeId: dev.user.id, dueDate: addDays(today, -1) });
  await make({ title: 'c2', priority: 'critical', assigneeId: dev.user.id, dueDate: addDays(today, 2) });
  await make({ title: 'h1', priority: 'high', assigneeId: dev.user.id, dueDate: addDays(today, 9) });
  await make({ title: 'p', assigneeId: dev.user.id, storyPoints: 3 });
  await make({ title: 'm1', priority: 'medium', assigneeId: dev2.user.id, dueDate: addDays(today, 30) });
  await make({ title: 'done', priority: 'critical', assigneeId: dev2.user.id, status: 'done' });

  const res = await t.api('GET', `/api/projects/${project.id}/workload`, { token: viewer.token });
  assert.equal(res.status, 200);
  const [top, second, third] = res.body.members;
  assert.equal(res.body.members.length, 3, 'viewers are not listed');
  assert.deepEqual([top.user.name, top.open, top.points, top.score], ['Dev', 4, 3, 16]);
  assert.deepEqual(top.byPriority, { low: 0, medium: 1, high: 1, critical: 2 });
  assert.deepEqual(top.byDue, { overdue: 1, thisWeek: 1, nextWeek: 1, later: 0, noDate: 1 });
  assert.equal(top.level, 'overloaded');
  assert.deepEqual([second.user.name, second.open, second.score, second.byDue.later], ['Dev Two', 1, 2, 1]);
  assert.equal(second.level, 'light');
  assert.deepEqual([third.user.name, third.open, third.level], ['Admin', 0, 'light']);
  assert.equal(res.body.team.openAssigned, 5);
  assert.equal(res.body.team.averageScore, 6);
});
