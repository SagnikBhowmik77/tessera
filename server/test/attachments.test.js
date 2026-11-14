// Attachments against a real throwaway MongoDB with GridFS (never Atlas).
// A 1 MB project allowance for this file only, so the quota can be tested cheaply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ATTACHMENT_QUOTA_MB = '1';
const { startTestServer } = await import('./helpers.js');
const mongoose = (await import('mongoose')).default;
const { Project, Attachment, TicketEvent } = await import('../src/models/index.js');
const { sniff } = await import('../src/services/attachment.service.js');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

// Real file signatures (the first bytes that identify each format) followed by filler.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from('%PDF-1.7\n% test document\n');
const LOG = Buffer.from('2026-11-05T10:00:00Z ERROR TypeError: x is undefined\n    at app.js:12:5\n');

const files = () => mongoose.connection.db.collection('attachments.files');
const chunks = () => mongoose.connection.db.collection('attachments.chunks');
const filesOf = (project) => files().countDocuments({ 'metadata.project': new mongoose.Types.ObjectId(project.id) });

let keyN = 0;
async function setup() {
  const admin = await t.signUp('Admin');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Files', key: `FL${keyN}` } });
  const people = { admin, project: body.project };
  for (const role of ['manager', 'developer', 'viewer']) {
    const person = await t.signUp(role);
    await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: person.user.id, role } } });
    people[role] = person;
  }
  await t.api('POST', `/api/projects/${body.project.id}/tickets`, { token: admin.token, body: { title: 'Needs a screenshot' } });
  people.url = `/api/projects/${body.project.id}/tickets/1/attachments`;
  return people;
}

async function upload(url, who, bytes, name, claimedType = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: claimedType }), name);
  const res = await fetch(t.base + url, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

test('the real type comes from the bytes, not the name or the browser', () => {
  assert.equal(sniff(PNG, 'shot.png').contentType, 'image/png');
  assert.equal(sniff(PNG, 'notes.txt').contentType, 'image/png');
  assert.equal(sniff(PDF, 'spec.pdf').contentType, 'application/pdf');
  assert.equal(sniff(LOG, 'server.log').contentType, 'text/plain; charset=utf-8');
  assert.equal(sniff(Buffer.from('{"a":1}'), 'har.json').contentType, 'application/json');
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script>'), 'shot.png'), null, 'HTML named .png is refused');
  assert.equal(sniff(Buffer.from('<svg onload="alert(1)"/>'), 'logo.svg'), null, 'SVG is refused');
  assert.equal(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'tool.exe'), null);
  assert.equal(sniff(Buffer.from([0x61, 0x00, 0x62]), 'binary.log'), null, 'text with NUL bytes is refused');
});

test('upload, list, download and the activity feed', async () => {
  const { url, developer, viewer } = await setup();
  const res = await upload(url, developer, PNG, 'C:\\Users\\me\\Desktop\\login bug.png', 'text/html');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const a = res.body.attachment;
  assert.equal(a.name, 'login bug.png', 'folders are stripped');
  assert.equal(a.contentType, 'image/png', 'the claimed text/html is ignored');
  assert.equal(a.size, PNG.length);
  assert.equal(a.uploader.name, 'developer');
  assert.equal(a.fileId, undefined);

  const list = await t.api('GET', url, { token: viewer.token });
  assert.deepEqual(list.body.attachments.map((x) => x.name), ['login bug.png']);

  const dl = await fetch(`${t.base}${url}/${a.id}`, { headers: { authorization: `Bearer ${viewer.token}` } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.match(dl.headers.get('content-disposition'), /^inline; filename\*=UTF-8''login%20bug\.png$/);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG);

  const log = await upload(url, developer, LOG, 'server.log');
  const logDl = await fetch(`${t.base}${url}/${log.body.attachment.id}`, { headers: { authorization: `Bearer ${viewer.token}` } });
  assert.match(logDl.headers.get('content-disposition'), /^attachment;/, 'text is downloaded, never shown inline');
  await logDl.arrayBuffer();

  const feed = (await t.api('GET', url.replace('/attachments', '/history'), { token: viewer.token })).body.events;
  assert.deepEqual(feed.map((e) => e.type), ['created', 'attachment_added', 'attachment_added']);
  assert.equal(feed[1].to.name, 'login bug.png');
});

test('who may upload and remove', async () => {
  const { url, project, developer, manager, viewer, admin } = await setup();
  assert.equal((await upload(url, viewer, PNG, 'v.png')).status, 403, 'viewers read and comment only');
  const mine = (await upload(url, developer, PNG, 'mine.png')).body.attachment;
  const theirs = (await upload(url, admin, PDF, 'theirs.pdf')).body.attachment;
  assert.equal(await filesOf(project), 2);

  assert.equal((await t.api('DELETE', `${url}/${theirs.id}`, { token: developer.token })).status, 403);
  assert.equal((await t.api('DELETE', `${url}/${mine.id}`, { token: developer.token })).status, 204);
  assert.equal((await t.api('DELETE', `${url}/${theirs.id}`, { token: manager.token })).status, 204);
  assert.equal((await t.api('GET', `${url}/${mine.id}`, { token: developer.token })).status, 404);
  assert.equal(await filesOf(project), 0, 'the bytes are gone too');
  assert.equal(await TicketEvent.countDocuments({ project: project.id, type: 'attachment_removed' }), 2);
});

test('refused uploads: no file, wrong type, too big, over the project allowance', async () => {
  const { url, developer } = await setup();
  const none = await fetch(t.base + url, { method: 'POST', headers: { authorization: `Bearer ${developer.token}` }, body: new FormData() });
  assert.equal((await none.json()).error.code, 'file_required');

  const html = await upload(url, developer, Buffer.from('<html></html>'), 'page.png', 'image/png');
  assert.equal(html.status, 415);
  assert.equal(html.body.error.code, 'unsupported_type');

  const huge = await upload(url, developer, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), 'huge.png');
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'too_large');

  const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);
  assert.equal((await upload(url, developer, big, 'a.png')).status, 201);
  const over = await upload(url, developer, big, 'b.png');
  assert.equal(over.status, 413);
  assert.equal(over.body.error.code, 'quota_exceeded');
  assert.match(over.body.error.message, /of its 1 MB/);
});

test('deleting the project deletes its files, comments and history', async () => {
  const { url, project, admin, developer } = await setup();
  await upload(url, developer, PNG, 'gone.png');
  await t.api('POST', url.replace('/attachments', '/comments'), { token: developer.token, body: { body: 'bye' } });
  assert.equal(await filesOf(project), 1);
  assert.equal((await t.api('DELETE', `/api/projects/${project.id}`, { token: admin.token, body: { confirmKey: project.key } })).status, 204);
  assert.equal(await Attachment.countDocuments({ project: project.id }), 0);
  assert.equal(await filesOf(project), 0);
  const remaining = (await files().find({}, { projection: { _id: 1 } }).toArray()).map((f) => f._id);
  assert.equal(await chunks().countDocuments({ files_id: { $nin: remaining } }), 0, 'no orphaned chunks');
});
