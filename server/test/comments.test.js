// Comments against a real throwaway MongoDB (never Atlas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { Project, Comment, TicketEvent } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function setup() {
  const admin = await t.signUp('Admin');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Chat', key: `CM${keyN}` } });
  const people = { admin, project: body.project };
  for (const role of ['manager', 'developer', 'viewer']) {
    const person = await t.signUp(role);
    await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: person.user.id, role } } });
    people[role] = person;
  }
  await t.api('POST', `/api/projects/${body.project.id}/tickets`, { token: admin.token, body: { title: 'Talk about me' } });
  people.url = `/api/projects/${body.project.id}/tickets/1/comments`;
  return people;
}
const mention = (person) => `@[${person.user.name}](${person.user.id})`;

test('anyone in the project, viewers included, can comment; outsiders cannot', async () => {
  const { url, viewer, developer } = await setup();
  const res = await t.api('POST', url, { token: viewer.token, body: { body: 'Seeing this on **Firefox** too' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.comment.author.name, 'viewer');
  assert.equal(res.body.comment.parent, null);
  assert.equal((await t.api('POST', url, { token: developer.token, body: { body: '   ' } })).status, 400);
  const outsider = await t.signUp();
  assert.equal((await t.api('POST', url, { token: outsider.token, body: { body: 'hi' } })).status, 404);
});

test('mentions keep only project members, without duplicates', async () => {
  const { url, developer, manager } = await setup();
  const outsider = await t.signUp('Outsider');
  const body = `${mention(manager)} can you check? cc ${mention(manager)} ${mention(outsider)} @[Fake](000000000000000000000000)`;
  const res = await t.api('POST', url, { token: developer.token, body: { body } });
  assert.deepEqual(res.body.comment.mentions, [manager.user.id]);
  assert.equal(res.body.comment.body, body, 'the text itself is kept as written');
});

test('threads are one level deep; replying to a reply joins the same thread', async () => {
  const { url, developer, manager, viewer } = await setup();
  const root = (await t.api('POST', url, { token: developer.token, body: { body: 'Root' } })).body.comment;
  const reply = (await t.api('POST', url, { token: manager.token, body: { body: 'Reply', parentId: root.id } })).body.comment;
  const nested = (await t.api('POST', url, { token: viewer.token, body: { body: 'Reply to reply', parentId: reply.id } })).body.comment;
  assert.equal(reply.parent, root.id);
  assert.equal(nested.parent, root.id);
  await t.api('POST', url, { token: viewer.token, body: { body: 'Second thread' } });

  const list = (await t.api('GET', url, { token: viewer.token })).body.comments;
  assert.deepEqual(list.map((c) => [c.body, c.replies.map((r) => r.body)]), [
    ['Root', ['Reply', 'Reply to reply']],
    ['Second thread', []],
  ]);
  const bad = await t.api('POST', url, { token: viewer.token, body: { body: 'x', parentId: '0123456789abcdef01234567' } });
  assert.equal(bad.body.error.code, 'parent_not_found');
});

test('only the author edits; edits re-read mentions and mark the comment edited', async () => {
  const { url, developer, manager } = await setup();
  const c = (await t.api('POST', url, { token: developer.token, body: { body: 'Typo hree' } })).body.comment;
  assert.equal((await t.api('PATCH', `${url}/${c.id}`, { token: manager.token, body: { body: 'Hijack' } })).status, 403);
  const edited = await t.api('PATCH', `${url}/${c.id}`, { token: developer.token, body: { body: `Typo here ${mention(manager)}` } });
  assert.equal(edited.status, 200);
  assert.ok(edited.body.comment.editedAt);
  assert.deepEqual(edited.body.comment.mentions, [manager.user.id]);
  // Saving the same text again changes nothing.
  const same = await t.api('PATCH', `${url}/${c.id}`, { token: developer.token, body: { body: `Typo here ${mention(manager)}` } });
  assert.equal(same.body.comment.editedAt, edited.body.comment.editedAt);
});

test('deleting: authors their own, managers any; a deleted starter stays only while it has replies', async () => {
  const { url, developer, manager, viewer } = await setup();
  const root = (await t.api('POST', url, { token: developer.token, body: { body: 'Starter' } })).body.comment;
  await t.api('POST', url, { token: viewer.token, body: { body: 'Answer', parentId: root.id } });
  const lonely = (await t.api('POST', url, { token: viewer.token, body: { body: 'Spam' } })).body.comment;

  assert.equal((await t.api('DELETE', `${url}/${root.id}`, { token: viewer.token })).status, 403);
  assert.equal((await t.api('DELETE', `${url}/${root.id}`, { token: developer.token })).status, 204);
  assert.equal((await t.api('DELETE', `${url}/${lonely.id}`, { token: manager.token })).status, 204);
  assert.equal((await t.api('DELETE', `${url}/${lonely.id}`, { token: manager.token })).status, 404);

  const list = (await t.api('GET', url, { token: viewer.token })).body.comments;
  assert.equal(list.length, 1);
  assert.equal(list[0].body, null, 'deleted text is not sent');
  assert.ok(list[0].deletedAt);
  assert.deepEqual(list[0].replies.map((r) => r.body), ['Answer']);
  assert.equal((await Comment.findById(root.id).lean()).body, '', 'and not kept in the database either');
});

test('comments appear in the ticket activity feed; archived projects and deleted tickets take none', async () => {
  const { url, project, admin, developer } = await setup();
  await t.api('POST', url, { token: developer.token, body: { body: 'Logged' } });
  const feed = (await t.api('GET', url.replace('/comments', '/history'), { token: developer.token })).body.events;
  assert.deepEqual(feed.map((e) => e.type), ['created', 'commented']);
  assert.equal(await TicketEvent.countDocuments({ type: 'commented', project: project.id }), 1);

  await t.api('DELETE', url.replace('/comments', ''), { token: admin.token });
  assert.equal((await t.api('POST', url, { token: developer.token, body: { body: 'x' } })).body.error.code, 'ticket_deleted');
  await t.api('POST', url.replace('/comments', '/restore'), { token: admin.token });
  await t.api('POST', `/api/projects/${project.id}/archive`, { token: admin.token });
  assert.equal((await t.api('POST', url, { token: developer.token, body: { body: 'x' } })).body.error.code, 'project_archived');
  assert.equal((await t.api('GET', url, { token: developer.token })).status, 200);
});
