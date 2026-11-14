// Following tickets: catch me up, Watch, snooze reminders, and ageing cards (throwaway MongoDB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Project, Snooze, Ticket, TicketEvent, TicketVisit } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await flushNotifications(); await t.stop(); });

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Follow', key: `FL${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  const base = `/api/projects/${body.project.id}`;
  return { admin, dev, viewer, project: body.project, base, url: `${base}/tickets` };
}
const inbox = async (who) => (await t.api('GET', '/api/notifications', { token: who.token })).body.notifications;

test('catch me up: what other people changed since my last visit, never my own changes', async () => {
  const { admin, dev, url } = await team();
  const { body } = await t.api('POST', url, { token: admin.token, body: { title: 'Checkout freezes', type: 'bug' } });
  const ref = body.ticket.key;

  const first = await t.api('POST', `${url}/${ref}/visit`, { token: admin.token });
  assert.equal(first.status, 200);
  assert.equal(first.body.previousVisit, null, 'first visit: nothing to catch up on');
  assert.deepEqual(first.body.changes, []);

  await t.api('PATCH', `${url}/${ref}`, { token: admin.token, body: { assigneeId: dev.user.id } }); // mine: not reported
  await t.api('POST', `${url}/${ref}/move`, { token: dev.token, body: { status: 'in_progress' } });
  await t.api('POST', `${url}/${ref}/comments`, { token: dev.token, body: { body: 'Found it, a race in the cart lock.' } });
  await t.api('PATCH', `${url}/${ref}`, { token: dev.token, body: { priority: 'high' } });

  const second = await t.api('POST', `${url}/${ref}/visit`, { token: admin.token });
  assert.ok(second.body.previousVisit);
  assert.deepEqual(second.body.changes.map((c) => [c.type, c.actor.name]), [
    ['status_changed', 'Dev'], ['commented', 'Dev'], ['updated', 'Dev'],
  ]);
  assert.equal(second.body.changes[2].field, 'priority');

  const third = await t.api('POST', `${url}/${ref}/visit`, { token: admin.token });
  assert.deepEqual(third.body.changes, [], 'nothing new since the visit just made');
});

test('watchers hear about column moves and comments; one notice per person; unwatch stops it', async () => {
  const { admin, dev, viewer, url } = await team();
  const { body } = await t.api('POST', url, { token: admin.token, body: { title: 'Refund email missing', assigneeId: dev.user.id } });
  const ref = body.ticket.key;

  const w = await t.api('PUT', `${url}/${ref}/watch`, { token: viewer.token });
  assert.deepEqual(w.body, { watching: true });
  await t.api('PUT', `${url}/${ref}/watch`, { token: admin.token }); // the reporter watches too
  assert.equal((await Ticket.findById(body.ticket.id)).watchers.length, 2);
  assert.equal((await t.api('POST', `${url}/${ref}/visit`, { token: viewer.token })).body.watching, true);

  await t.api('POST', `${url}/${ref}/move`, { token: dev.token, body: { status: 'in_progress' } });
  await t.api('POST', `${url}/${ref}/comments`, { token: dev.token, body: { body: 'On it.' } });
  const mine = await inbox(viewer);
  assert.deepEqual(mine.map((n) => n.type).sort(), ['comment', 'status_changed']);
  assert.equal(mine.find((n) => n.type === 'status_changed').excerpt, 'To Do → In Progress');

  // Finished: the reporter gets "resolved" only, not a second "status changed" for the same move.
  await t.api('POST', `${url}/${ref}/move`, { token: dev.token, body: { status: 'done' } });
  const reporter = (await inbox(admin)).filter((n) => n.ticketKey === ref);
  assert.deepEqual(reporter.map((n) => n.type).sort(), ['comment', 'resolved', 'status_changed']);
  assert.equal(reporter.filter((n) => n.type === 'status_changed').length, 1, 'only the first move');

  await t.api('DELETE', `${url}/${ref}/watch`, { token: viewer.token });
  const count = (await inbox(viewer)).length;
  await t.api('POST', `${url}/${ref}/move`, { token: dev.token, body: { status: 'todo' } });
  assert.equal((await inbox(viewer)).length, count, 'unwatched: nothing new');
});

test('snooze: leaves My work, comes back with one reminder when due; bad times are refused', async () => {
  const { admin, dev, url } = await team();
  const mk = async (title) => (await t.api('POST', url, { token: admin.token, body: { title, assigneeId: dev.user.id } })).body.ticket;
  const a = await mk('Snooze me');
  await mk('Keep me');

  const past = await t.api('PUT', `${url}/${a.key}/snooze`, { token: dev.token, body: { until: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(past.status, 400);
  assert.equal(past.body.error.code, 'snooze_in_past');
  const bad = await t.api('PUT', `${url}/${a.key}/snooze`, { token: dev.token, body: { until: 'tomorrow' } });
  assert.equal(bad.status, 400);

  const until = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const s = await t.api('PUT', `${url}/${a.key}/snooze`, { token: dev.token, body: { until } });
  assert.equal(s.status, 200);
  let work = (await t.api('GET', '/api/me/tickets', { token: dev.token })).body;
  assert.deepEqual(work.tickets.map((x) => x.title), ['Keep me']);
  assert.equal(work.snoozedCount, 1);
  const sleeping = (await t.api('GET', '/api/me/tickets?snoozed=true', { token: dev.token })).body;
  assert.deepEqual(sleeping.tickets.map((x) => [x.title, new Date(x.snoozedUntil).toISOString()]), [['Snooze me', until]]);
  assert.equal(new Date((await t.api('POST', `${url}/${a.key}/visit`, { token: dev.token })).body.snoozedUntil).toISOString(), until);

  // Time passes: the snooze comes due, and reading the inbox delivers the reminder exactly once.
  await Snooze.updateOne({ ticket: a.id }, { $set: { until: new Date(Date.now() - 1000) } });
  const reminders = (await inbox(dev)).filter((n) => n.type === 'reminder');
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].ticketKey, a.key);
  assert.equal((await inbox(dev)).filter((n) => n.type === 'reminder').length, 1, 'not reminded twice');
  work = (await t.api('GET', '/api/me/tickets', { token: dev.token })).body;
  assert.equal(work.snoozedCount, 0);
  assert.deepEqual(work.tickets.map((x) => x.title).sort(), ['Keep me', 'Snooze me']);
});

test('leaving a project forgets what you watched, snoozed and visited there', async () => {
  const { admin, dev, base, url } = await team();
  const { body } = await t.api('POST', url, { token: admin.token, body: { title: 'Followed', assigneeId: dev.user.id } });
  await t.api('PUT', `${url}/${body.ticket.key}/watch`, { token: dev.token });
  await t.api('POST', `${url}/${body.ticket.key}/visit`, { token: dev.token });
  await t.api('PUT', `${url}/${body.ticket.key}/snooze`, { token: dev.token, body: { until: new Date(Date.now() + 864e5).toISOString() } });

  const left = await t.api('DELETE', `${base}/members/${dev.user.id}`, { token: dev.token });
  assert.equal(left.status, 200);
  assert.deepEqual((await Ticket.findById(body.ticket.id)).watchers, []);
  assert.equal(await Snooze.countDocuments({ user: dev.user.id }), 0);
  assert.equal(await TicketVisit.countDocuments({ user: dev.user.id }), 0);
});

// Rewrites a ticket's history: created in To Do at `t0`, then [status, at] moves.
async function history(ticketId, projectId, t0, moves) {
  await TicketEvent.deleteMany({ ticket: ticketId });
  await TicketEvent.insertMany([
    { project: projectId, ticket: ticketId, type: 'created', to: { status: 'todo' }, at: t0 },
    ...moves.map(([to, at], i) => ({ project: projectId, ticket: ticketId, type: 'status_changed', from: i ? moves[i - 1][0] : 'todo', to, at })),
  ]);
  await Ticket.updateOne({ _id: ticketId }, { $set: { status: moves.at(-1)?.[0] ?? 'todo' } });
}

test('ageing: cards in progress longer than the team 85th percentile are flagged, only with enough history', async () => {
  const { admin, project, base, url } = await team();
  const HOUR = 3600 * 1000;
  const now = Date.now();
  const mk = async (title) => (await t.api('POST', url, { token: admin.token, body: { title } })).body.ticket;

  // Four finished tickets: not enough to know what "usual" is.
  for (const hours of [1, 2, 3, 4]) {
    const done = await mk(`Done in ${hours}h`);
    const start = new Date(now - 48 * HOUR);
    await history(done.id, project.id, start, [['in_progress', start], ['done', new Date(start.getTime() + hours * HOUR)]]);
  }
  const slow = await mk('In progress 12h');
  await history(slow.id, project.id, new Date(now - 20 * HOUR), [['in_progress', new Date(now - 12 * HOUR)]]);
  const quick = await mk('In progress 5h');
  // Reopened: the age counts from the latest start, not the first.
  await history(quick.id, project.id, new Date(now - 40 * HOUR), [
    ['in_progress', new Date(now - 40 * HOUR)], ['done', new Date(now - 30 * HOUR)], ['in_progress', new Date(now - 5 * HOUR)],
  ]);

  let res = await t.api('GET', `${base}/ageing`, { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.sample, 4);
  assert.equal(res.body.p85Hours, null);
  assert.ok(res.body.tickets.every((x) => x.ageing === false && x.ratio === null));

  // A fifth: cycle times 1, 2, 3, 4, 10 h -> 85th percentile (nearest rank) is 10 h.
  const fifth = await mk('Done in 10h');
  const s5 = new Date(now - 30 * HOUR);
  await history(fifth.id, project.id, s5, [['in_progress', s5], ['done', new Date(s5.getTime() + 10 * HOUR)]]);

  res = await t.api('GET', `${base}/ageing`, { token: admin.token });
  assert.equal(res.body.sample, 5);
  assert.equal(res.body.p85Hours, 10);
  const byNumber = new Map(res.body.tickets.map((x) => [x.number, x]));
  assert.equal(byNumber.get(slow.number).ageing, true);
  assert.ok(Math.abs(byNumber.get(slow.number).ageHours - 12) < 0.2);
  assert.equal(byNumber.get(quick.number).ageing, false);
  assert.ok(Math.abs(byNumber.get(quick.number).ageHours - 5) < 0.2, 'counted from the reopen');
  assert.equal(res.body.tickets.length, 2, 'only cards in progress now');
});
