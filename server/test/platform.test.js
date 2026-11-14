// Platform (E14): workspaces, project backup and import, storage warnings and clean-up, push
// notifications, and project JSON that never carries secrets (throwaway MongoDB; push sends are
// captured; the VAPID keys are made here for the test only).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.ATTACHMENT_QUOTA_MB = '1';
const { startTestServer } = await import('./helpers.js');
const { flushNotifications } = await import('../src/services/notification.service.js');
const { __setPushSender } = await import('../src/services/push.service.js');
const { Attachment, Project, PushSubscription, Ticket, User, Workspace } = await import('../src/models/index.js');

let t;
let pushed = [];
let pushReply = () => ({ statusCode: 201 });
before(async () => {
  t = await startTestServer();
  __setPushSender(async (sub, payload, options) => {
    pushed.push({ endpoint: sub.endpoint, message: JSON.parse(payload), options });
    const r = pushReply(sub);
    if (r.statusCode >= 400) throw Object.assign(new Error('push failed'), { statusCode: r.statusCode });
    return r;
  });
});
after(async () => { __setPushSender(null); await t.stop(); });
beforeEach(() => { pushed = []; pushReply = () => ({ statusCode: 201 }); });

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `PL${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  return { admin, dev, viewer, project: body.project, base: `/api/projects/${body.project.id}` };
}
const emailOf = async (person) => (await User.findById(person.user.id).lean()).email;

test('project JSON carries no tokens or secrets (share links, roadmap, GitLab, alerts, webhooks)', async () => {
  const c = await team();
  await t.api('PUT', `${c.base}/roadmap`, { token: c.admin.token, body: { enabled: true } });
  const link = (await t.api('POST', `${c.base}/share-links`, { token: c.admin.token, body: { name: 'Client' } })).body.link;
  const gitlab = (await t.api('PUT', `${c.base}/integrations/gitlab`, { token: c.admin.token })).body.gitlab;
  await t.api('POST', `${c.base}/integrations/webhooks`, { token: c.admin.token, body: { name: 'Hook', url: 'https://hooks.example.com/x' } });
  for (const who of [c.viewer, c.admin]) {
    const project = (await t.api('GET', c.base, { token: who.token })).body.project;
    const raw = JSON.stringify(project);
    assert.ok(!raw.includes(gitlab.secret) && !raw.includes(link.url.split('/shared/')[1]), 'no secrets or tokens');
    assert.deepEqual([project.gitlab, project.roadmap, project.shareLinks, project.alerts, project.webhooks], [{ connected: true }, { enabled: true }, undefined, undefined, undefined]);
  }
});

test('workspaces group projects and people; owners are protected', async () => {
  const c = await team();
  const other = await t.signUp('Outsider');
  const ws = (await t.api('POST', '/api/workspaces', { token: c.admin.token, body: { name: 'Acme' } })).body.workspace;
  assert.equal(ws.myRole, 'owner');
  assert.equal((await t.api('POST', `/api/workspaces/${ws.id}/members`, { token: c.admin.token, body: { email: 'nobody@example.com' } })).body.error.code, 'no_account');
  await t.api('POST', `/api/workspaces/${ws.id}/members`, { token: c.admin.token, body: { email: await emailOf(other) } });
  assert.equal((await t.api('POST', `/api/workspaces/${ws.id}/members`, { token: other.token, body: { email: await emailOf(c.dev) } })).status, 403, 'members cannot add people');
  assert.equal((await t.api('GET', `/api/workspaces/${ws.id}`, { token: c.dev.token })).status, 404, 'invisible to non-members');

  assert.equal((await t.api('PUT', `${c.base}/workspace`, { token: c.dev.token, body: { workspaceId: ws.id } })).status, 403);
  await t.api('PUT', `${c.base}/workspace`, { token: c.admin.token, body: { workspaceId: ws.id } });
  const shown = (await t.api('GET', `/api/workspaces/${ws.id}`, { token: other.token })).body.workspace;
  assert.deepEqual(shown.projects.map((p) => [p.key, p.myRole]), [[c.project.key, null]], 'listed, but not theirs');
  const added = (await t.api('POST', `${c.base}/members/from-workspace`, { token: c.admin.token, body: { role: 'viewer' } })).body;
  assert.equal(added.added, 1);
  assert.equal((await Project.findById(c.project.id).lean()).members.find((m) => String(m.user) === other.user.id).role, 'viewer');
  assert.deepEqual((await t.api('GET', '/api/workspaces', { token: c.admin.token })).body.workspaces.map((w) => [w.name, w.members, w.projects]), [['Acme', 2, 1]]);

  assert.equal((await t.api('DELETE', `/api/workspaces/${ws.id}/members/${c.admin.user.id}`, { token: c.admin.token })).body.error.code, 'last_owner');
  await t.api('PATCH', `/api/workspaces/${ws.id}/members/${other.user.id}`, { token: c.admin.token, body: { role: 'owner' } });
  assert.equal((await t.api('DELETE', `/api/workspaces/${ws.id}/members/${c.admin.user.id}`, { token: c.admin.token })).status, 200, 'can leave once someone else owns it');
  await t.api('DELETE', `/api/workspaces/${ws.id}`, { token: other.token });
  assert.equal(await Workspace.countDocuments({ _id: ws.id }), 0);
  assert.equal((await Project.findById(c.project.id).lean()).workspace, null, 'deleting a workspace never deletes its projects');
});

test('backup: export without secrets, import as a new project with people matched by email', async () => {
  const c = await team();
  await t.api('PUT', `${c.base}/portal`, { token: c.admin.token, body: { enabled: true } });
  const sprint = (await t.api('POST', `${c.base}/sprints`, { token: c.admin.token, body: { name: 'Sprint 1' } })).body.sprint;
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Epic: checkout', type: 'epic' } });
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Pay button', assigneeId: c.dev.user.id, labels: ['ui'], storyPoints: 3 } });
  await t.api('PUT', `${c.base}/tickets/2/epic`, { token: c.admin.token, body: { epic: `${c.project.key}-1` } });
  await t.api('PUT', `${c.base}/tickets/2/sprint`, { token: c.admin.token, body: { sprint: sprint.id } });
  await t.api('POST', `${c.base}/tickets/2/comments`, { token: c.dev.token, body: { body: 'Working on it' } });

  assert.equal((await t.api('GET', `${c.base}/export`, { token: c.dev.token })).status, 403, 'admins only');
  const res = await fetch(`${t.base}${c.base}/export`, { headers: { authorization: `Bearer ${c.admin.token}` } });
  assert.match(res.headers.get('content-disposition'), new RegExp(`${c.project.key}-backup-\\d{4}-\\d{2}-\\d{2}\\.json`));
  const text = await res.text();
  const backup = JSON.parse(text);
  const portalToken = (await Project.findById(c.project.id).lean()).portal.token;
  assert.ok(!text.includes(portalToken), 'no portal token');
  assert.deepEqual([backup.format, backup.version, backup.tickets.length, backup.comments.length, backup.sprints.length], ['tessera-backup', 1, 2, 1, 1]);
  assert.deepEqual([backup.tickets[1].assignee, backup.tickets[1].epic, backup.tickets[1].sprint], [await emailOf(c.dev), 1, 'Sprint 1']);

  const form = (file, fields = {}) => { const f = new FormData(); f.append('file', new Blob([file]), 'backup.json'); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };
  const post = (f) => fetch(`${t.base}/api/projects/import`, { method: 'POST', headers: { authorization: `Bearer ${c.admin.token}` }, body: f }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal((await post(form('not json'))).body.error.code, 'not_json');
  assert.equal((await post(form('{"hello":1}'))).body.error.code, 'not_a_backup');
  assert.equal((await post(form(text))).body.error.code, 'key_taken', 'the same key is already yours');
  const imported = await post(form(text, { key: `IM${n}`, name: 'Shop copy' }));
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.imported, { tickets: 2, comments: 1, sprints: 1, milestones: 0, members: 3 });
  const copy = imported.body.project;
  const pay = (await t.api('GET', `/api/projects/${copy.id}/tickets/2`, { token: c.dev.token })).body.ticket;
  assert.deepEqual([pay.title, pay.assignee?.id, pay.labels, pay.storyPoints, Boolean(pay.epic), Boolean(pay.sprint)], ['Pay button', c.dev.user.id, ['ui'], 3, true, true]);
  const comments = (await t.api('GET', `/api/projects/${copy.id}/tickets/2/comments`, { token: c.dev.token })).body.comments;
  assert.equal(comments[0].author.id, c.dev.user.id);
  const next = (await t.api('POST', `/api/projects/${copy.id}/tickets`, { token: c.admin.token, body: { title: 'After import' } })).body.ticket;
  assert.equal(next.number, 3, 'numbering continues after the imported tickets');
});

test('storage: usage, warnings, and clearing files on long-finished tickets', async () => {
  const c = await team();
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Old bug' } });
  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Current bug' } });
  const png = (size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 1)]);
  const upload = async (num, size, name) => {
    const f = new FormData();
    f.append('file', new Blob([png(size)]), name);
    return (await fetch(`${t.base}${c.base}/tickets/${num}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${c.admin.token}` }, body: f }).then((r) => r.json())).attachment;
  };
  const old = await upload(1, 500_000, 'old.png');
  await upload(2, 350_000, 'new.png');
  const summary = (await t.api('GET', `${c.base}/storage/summary`, { token: c.viewer.token })).body;
  assert.deepEqual([summary.level, Math.round(summary.percent)], ['warning', 81]);
  await t.api('POST', `${c.base}/tickets/1/move`, { token: c.admin.token, body: { status: 'done' } });
  await Ticket.updateOne({ project: c.project.id, number: 1 }, { $set: { resolvedAt: new Date(Date.now() - 40 * 86_400_000) } });
  assert.equal((await t.api('GET', `${c.base}/storage`, { token: c.dev.token })).status, 403);
  const report = (await t.api('GET', `${c.base}/storage`, { token: c.admin.token })).body;
  assert.deepEqual(report.largest.map((f) => f.name), ['old.png', 'new.png']);
  assert.deepEqual(report.cleanup.files.map((f) => [f.name, f.ticket.key]), [['old.png', `${c.project.key}-1`]]);
  const done = (await t.api('POST', `${c.base}/storage/cleanup`, { token: c.admin.token, body: { attachmentIds: [old.id] } })).body;
  assert.deepEqual([done.removed, done.freed, done.storage.level], [1, 500_008, 'ok']);
  assert.equal(await Attachment.countDocuments({ project: c.project.id }), 1);
  const history = (await t.api('GET', `${c.base}/tickets/1/history`, { token: c.admin.token })).body.events;
  assert.ok(history.some((e) => e.type === 'attachment_removed'));
});

test('push: only real push services, sent to people who are away, gone subscriptions forgotten', async () => {
  const c = await team();
  const key = (await t.api('GET', '/api/me/push', { token: c.dev.token })).body.key;
  assert.equal(key, keys.publicKey);
  const sub = (endpoint) => ({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
  assert.equal((await t.api('POST', '/api/me/push', { token: c.dev.token, body: sub('https://evil.example/push/1') })).body.error.code, 'bad_subscription');
  assert.equal((await t.api('POST', '/api/me/push', { token: c.dev.token, body: sub('http://fcm.googleapis.com/fcm/send/x') })).body.error.code, 'bad_subscription');
  const listed = (await t.api('POST', '/api/me/push', { token: c.dev.token, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0' }, body: sub('https://fcm.googleapis.com/fcm/send/abc123') })).body.subscriptions;
  assert.deepEqual(listed.map((s) => [s.browser, s.endpointHost]), [['Chrome on Windows', 'fcm.googleapis.com']]);

  await t.api('POST', `${c.base}/tickets`, { token: c.admin.token, body: { title: 'Ship it', assigneeId: c.dev.user.id } });
  await flushNotifications();
  assert.equal(pushed.length, 1);
  assert.deepEqual([pushed[0].message.title, pushed[0].message.body, pushed[0].message.url], [`${c.project.key}-1: Admin assigned this to you`, 'Ship it', `/projects/${c.project.id}/tickets/${c.project.key}-1`]);
  assert.equal(pushed[0].options.vapidDetails.publicKey, keys.publicKey);

  // Quiet hours: no push.
  pushed = [];
  await User.updateOne({ _id: c.dev.user.id }, { $set: { notify: { timeZone: 'UTC', quiet: { enabled: true, from: '00:00', to: '23:59' } } } });
  await t.api('PATCH', `${c.base}/tickets/1`, { token: c.admin.token, body: { assigneeId: null } });
  await t.api('PATCH', `${c.base}/tickets/1`, { token: c.admin.token, body: { assigneeId: c.dev.user.id } });
  await flushNotifications();
  assert.equal(pushed.length, 0);

  // The push service says the subscription is gone: it is forgotten.
  await User.updateOne({ _id: c.dev.user.id }, { $set: { 'notify.quiet.enabled': false } });
  pushReply = () => ({ statusCode: 410 });
  assert.deepEqual((await t.api('POST', '/api/me/push/test', { token: c.dev.token })).body, { sent: 0 });
  assert.equal(await PushSubscription.countDocuments({ user: c.dev.user.id }), 0);
});
