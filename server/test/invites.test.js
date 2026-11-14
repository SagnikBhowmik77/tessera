// Email invites against a real throwaway MongoDB. Mail goes to nodemailer's JSON transport
// (captured here), never to a real inbox.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { ProjectInvite } from '../src/models/index.js';

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

before(async () => { t = await startTestServer(); });
after(() => t.stop());
beforeEach(() => { outbox = []; __setTransport(capturing); });

let keyN = 0;
async function setup() {
  const admin = await t.signUp('Admin');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Mobile <App>', key: `M${keyN}X` } });
  return { admin, project: body.project };
}
const invite = (project, token, body) => t.api('POST', `/api/projects/${project.id}/invites`, { token, body });
const tokenFrom = (url) => url.split('/invite/')[1];

test('an admin invites by email; the email has a working link and escapes the project name', async () => {
  const { admin, project } = await setup();
  const res = await invite(project, admin.token, { email: ' New.Person@Example.com ', role: 'manager' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.email, { sent: true });
  assert.equal(res.body.invite.email, 'new.person@example.com');
  assert.equal(res.body.invite.tokenHash, undefined);
  assert.match(res.body.acceptUrl, /^http:\/\/localhost:5210\/invite\/[A-Za-z0-9_-]{43}$/);

  assert.equal(outbox.length, 1);
  const [mail] = outbox;
  assert.equal(mail.to[0].address, 'new.person@example.com');
  assert.match(mail.subject, /Admin invited you to Mobile <App> on Tessera/);
  assert.ok(mail.text.includes(res.body.acceptUrl));
  assert.ok(mail.html.includes('Mobile &lt;App&gt;'));
  assert.ok(!mail.html.includes('Mobile <App>'));

  // Only the hash is stored.
  const stored = await ProjectInvite.findById(res.body.invite.id).lean();
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(tokenFrom(res.body.acceptUrl)));
});

test('without email configured the invite still works and says so honestly', async () => {
  __setTransport(null);
  const { admin, project } = await setup();
  const res = await invite(project, admin.token, { email: 'quiet@example.com' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.email, { sent: false, reason: 'not_configured' });
  assert.equal(res.body.invite.role, 'developer');
  assert.ok(res.body.acceptUrl);
  assert.equal(outbox.length, 0);
});

test('who may invite whom', async () => {
  const { admin, project } = await setup();
  const manager = await t.signUp('Manager');
  const r = await invite(project, admin.token, { email: manager.email, role: 'manager' });
  await t.api('POST', `/api/invites/${tokenFrom(r.body.acceptUrl)}/accept`, { token: manager.token });

  assert.equal((await invite(project, manager.token, { email: 'a@example.com', role: 'developer' })).status, 201);
  assert.equal((await invite(project, manager.token, { email: 'b@example.com', role: 'manager' })).status, 403);
  assert.equal((await invite(project, manager.token, { email: 'c@example.com', role: 'admin' })).status, 403);
  const dup = await invite(project, admin.token, { email: manager.email });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'already_member');
  assert.equal((await invite(project, admin.token, { email: 'not-an-email' })).status, 400);
});

test('preview works signed out; accepting needs the invited account', async () => {
  const { admin, project } = await setup();
  const invitee = await t.signUp('Invitee');
  const res = await invite(project, admin.token, { email: invitee.email, role: 'viewer' });
  const token = tokenFrom(res.body.acceptUrl);

  const preview = await t.api('GET', `/api/invites/${token}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.invite.project, { id: project.id, name: project.name, key: project.key });
  assert.equal(preview.body.invite.role, 'viewer');
  assert.equal(preview.body.invite.invitedBy, 'Admin');

  assert.equal((await t.api('POST', `/api/invites/${token}/accept`)).status, 401);
  const someoneElse = await t.signUp('Forwarded');
  const mismatch = await t.api('POST', `/api/invites/${token}/accept`, { token: someoneElse.token });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error.code, 'invite_email_mismatch');

  const accepted = await t.api('POST', `/api/invites/${token}/accept`, { token: invitee.token });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.project.myRole, 'viewer');
  // Used once only.
  const again = await t.api('POST', `/api/invites/${token}/accept`, { token: invitee.token });
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'invite_invalid');
  assert.equal((await t.api('GET', `/api/projects/${project.id}`, { token: invitee.token })).status, 200);
});

test('clicking accept twice at once adds the person once', async () => {
  const { admin, project } = await setup();
  const invitee = await t.signUp('Double');
  const token = tokenFrom((await invite(project, admin.token, { email: invitee.email })).body.acceptUrl);
  const results = await Promise.all([1, 2, 3].map(() => t.api('POST', `/api/invites/${token}/accept`, { token: invitee.token })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const members = await t.api('GET', `/api/projects/${project.id}/members`, { token: admin.token });
  assert.equal(members.body.members.filter((m) => m.user.email === invitee.email).length, 1);
});

test('re-inviting replaces the old link; revoke, decline and expiry all end a link', async () => {
  const { admin, project } = await setup();
  const first = tokenFrom((await invite(project, admin.token, { email: 'x@example.com' })).body.acceptUrl);
  const second = tokenFrom((await invite(project, admin.token, { email: 'x@example.com', role: 'viewer' })).body.acceptUrl);
  assert.equal((await t.api('GET', `/api/invites/${first}`)).status, 404);
  assert.equal((await t.api('GET', `/api/invites/${second}`)).body.invite.role, 'viewer');

  const list = await t.api('GET', `/api/projects/${project.id}/invites`, { token: admin.token });
  assert.equal(list.body.invites.length, 1);
  assert.equal(list.body.invites[0].invitedBy.name, 'Admin');
  const revoke = await t.api('DELETE', `/api/projects/${project.id}/invites/${list.body.invites[0].id}`, { token: admin.token });
  assert.equal(revoke.status, 204);
  assert.equal((await t.api('GET', `/api/invites/${second}`)).status, 404);

  const third = tokenFrom((await invite(project, admin.token, { email: 'y@example.com' })).body.acceptUrl);
  assert.equal((await t.api('POST', `/api/invites/${third}/decline`)).status, 204);
  assert.equal((await t.api('GET', `/api/invites/${third}`)).status, 404);

  const fourth = await invite(project, admin.token, { email: 'z@example.com' });
  await ProjectInvite.updateOne({ _id: fourth.body.invite.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await t.api('GET', `/api/invites/${tokenFrom(fourth.body.acceptUrl)}`)).status, 404);

  assert.equal((await t.api('GET', '/api/invites/short')).status, 400);
});

test('no invites while the project is archived', async () => {
  const { admin, project } = await setup();
  await t.api('POST', `/api/projects/${project.id}/archive`, { token: admin.token });
  const res = await invite(project, admin.token, { email: 'late@example.com' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'project_archived');
});
