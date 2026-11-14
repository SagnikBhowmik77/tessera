// Live collaboration with real Socket.IO clients against the test server (throwaway MongoDB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { startTestServer } from './helpers.js';
import { Project } from '../src/models/index.js';

let t;
const sockets = [];
before(async () => { t = await startTestServer(); });
after(async () => {
  for (const s of sockets) s.disconnect();
  await t.stop();
});

function open(token) {
  const s = connect(t.base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  return s;
}
const connected = (s) => new Promise((resolve, reject) => {
  s.once('connect', resolve);
  s.once('connect_error', reject);
});
// Resolves with the next `event` that passes `where`, or rejects after `ms`.
const next = (s, event, where = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const handler = (data) => {
    if (!where(data)) return;
    clearTimeout(timer);
    s.off(event, handler);
    resolve(data);
  };
  const timer = setTimeout(() => { s.off(event, handler); reject(new Error(`no matching ${event} within ${ms} ms`)); }, ms);
  s.on(event, handler);
});
// Resolves true if `event` does NOT arrive within `ms`.
const silent = (s, event, ms = 300) => new Promise((resolve) => {
  const handler = () => { clearTimeout(timer); s.off(event, handler); resolve(false); };
  const timer = setTimeout(() => { s.off(event, handler); resolve(true); }, ms);
  s.on(event, handler);
});
const names = (p) => p.users.map((u) => u.name).sort();

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Live', key: `RT${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  return { admin, dev, project: body.project, url: `/api/projects/${body.project.id}/tickets` };
}

test('the socket needs a valid login', async () => {
  await assert.rejects(connected(open(undefined)), /auth_required/);
  await assert.rejects(connected(open('not-a-token')), /invalid_token/);
});

test('only members can join a project room', async () => {
  const { project, dev } = await team();
  const stranger = await t.signUp('Stranger');
  const s = open(stranger.token);
  await connected(s);
  assert.deepEqual(await s.emitWithAck('project:join', project.id), { ok: false, error: 'project_not_found' });
  assert.deepEqual(await s.emitWithAck('project:join', 'nonsense'), { ok: false, error: 'project_not_found' });
  const d = open(dev.token);
  await connected(d);
  assert.deepEqual(await d.emitWithAck('project:join', project.id), { ok: true });
});

test('board changes reach everyone in the project as they happen', async () => {
  const { project, admin, dev, url } = await team();
  const watcher = open(dev.token);
  await connected(watcher);
  await watcher.emitWithAck('project:join', project.id);

  const created = next(watcher, 'ticket');
  await t.api('POST', url, { token: admin.token, body: { title: 'Live card' } });
  const c = await created;
  assert.equal(c.action, 'created');
  assert.equal(c.ticket.key, `${project.key}-1`);
  assert.equal(c.actorId, admin.user.id);

  const moved = next(watcher, 'ticket');
  await t.api('POST', `${url}/1/move`, { token: admin.token, body: { status: 'in_progress' } });
  const m = await moved;
  assert.deepEqual([m.action, m.ticket.status], ['moved', 'in_progress']);

  const commented = next(watcher, 'comment');
  await t.api('POST', `${url}/1/comments`, { token: admin.token, body: { body: 'On it' } });
  const cm = await commented;
  assert.deepEqual([cm.action, cm.number, cm.comment.body], ['added', 1, 'On it']);

  const deleted = next(watcher, 'ticket');
  await t.api('DELETE', `${url}/1`, { token: admin.token });
  assert.deepEqual(await deleted, { action: 'deleted', number: 1, actorId: admin.user.id });

  // Another project's changes don't leak in.
  const other = await team();
  const quiet = silent(watcher, 'ticket');
  await t.api('POST', other.url, { token: other.admin.token, body: { title: 'Elsewhere' } });
  assert.equal(await quiet, true);
});

test('presence: who is viewing a ticket, across tabs, and typing', async () => {
  const { project, admin, dev, url } = await team();
  await t.api('POST', url, { token: admin.token, body: { title: 'Look at me' } });
  const a = open(admin.token);
  const a2 = open(admin.token); // the admin's second tab
  const d = open(dev.token);
  await Promise.all([connected(a), connected(a2), connected(d)]);
  for (const s of [a, a2, d]) await s.emitWithAck('project:join', project.id);

  assert.deepEqual(await a.emitWithAck('ticket:view', { projectId: project.id, number: 0 }), { ok: false, error: 'bad_ticket' });
  const first = await a.emitWithAck('ticket:view', { projectId: project.id, number: 1 });
  assert.deepEqual(names(first), ['Admin']);
  await a2.emitWithAck('ticket:view', { projectId: project.id, number: 1 });

  const both = next(a, 'presence', (p) => p.users.length === 2);
  const joined = await d.emitWithAck('ticket:view', { projectId: project.id, number: 1 });
  assert.deepEqual(names(joined), ['Admin', 'Dev'], 'two tabs count as one person');
  assert.deepEqual(names(await both), ['Admin', 'Dev']);

  // Typing reaches others, not the typist.
  const typing = next(a, 'typing');
  const selfQuiet = silent(d, 'typing');
  d.emit('ticket:typing', { typing: true });
  assert.deepEqual(await typing, { projectId: project.id, number: 1, user: { id: dev.user.id, name: 'Dev' }, typing: true });
  assert.equal(await selfQuiet, true);

  // Leaving (or closing the tab) updates everyone.
  const left = next(a, 'presence', (p) => p.users.length === 1);
  d.disconnect();
  assert.deepEqual(names(await left), ['Admin']);
});

test('drag: a card picked up shows for teammates, is let go on drop or disconnect', async () => {
  const { project, admin, dev, url } = await team();
  await t.api('POST', url, { token: admin.token, body: { title: 'Move me' } });
  // Signed up before any socket opens, so no socket connects before the test listens for it.
  const stranger = await t.signUp('Outsider');
  const a = open(admin.token);
  const d = open(dev.token);
  const outsider = open(stranger.token);
  await Promise.all([connected(a), connected(d), connected(outsider)]);
  for (const s of [a, d]) await s.emitWithAck('project:join', project.id);

  const picked = next(a, 'drag');
  const selfQuiet = silent(d, 'drag');
  d.emit('ticket:drag', { projectId: project.id, number: 1, dragging: true });
  assert.deepEqual(await picked, { projectId: project.id, number: 1, user: { id: dev.user.id, name: 'Dev' }, dragging: true });
  assert.equal(await selfQuiet, true, 'not echoed to the one dragging');

  const dropped = next(a, 'drag', (x) => x.dragging === false);
  d.emit('ticket:drag', { projectId: project.id, number: 1, dragging: false });
  assert.equal((await dropped).number, 1);

  // Not in the project room, or a bad ticket number: nothing is sent.
  const quiet = silent(a, 'drag');
  outsider.emit('ticket:drag', { projectId: project.id, number: 1, dragging: true });
  d.emit('ticket:drag', { projectId: project.id, number: 0, dragging: true });
  assert.equal(await quiet, true);

  // Closing the tab mid-drag lets go of the card.
  d.emit('ticket:drag', { projectId: project.id, number: 1, dragging: true });
  await next(a, 'drag', (x) => x.dragging === true);
  const released = next(a, 'drag', (x) => x.dragging === false);
  d.disconnect();
  assert.deepEqual(await released, { projectId: project.id, number: 1, user: { id: dev.user.id, name: 'Dev' }, dragging: false });
});

test('ticket views need the project joined first', async () => {
  const { project, dev } = await team();
  const s = open(dev.token);
  await connected(s);
  assert.deepEqual(await s.emitWithAck('ticket:view', { projectId: project.id, number: 1 }), { ok: false, error: 'join_project_first' });
});

test('removed members stop receiving updates; logging out everywhere closes sockets', async () => {
  const { project, admin, dev, url } = await team();
  const s = open(dev.token);
  await connected(s);
  await s.emitWithAck('project:join', project.id);

  await t.api('DELETE', `/api/projects/${project.id}/members/${dev.user.id}`, { token: admin.token });
  const quiet = silent(s, 'ticket');
  await t.api('POST', url, { token: admin.token, body: { title: 'Secret now' } });
  assert.equal(await quiet, true);

  const gone = next(s, 'disconnect');
  await t.api('POST', '/api/auth/logout-all', { token: dev.token });
  assert.equal(await gone, 'io server disconnect');
});
