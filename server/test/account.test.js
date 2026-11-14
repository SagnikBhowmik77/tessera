// Account security: sessions, forgot password, email verification, two-factor (throwaway MongoDB;
// emails captured, never sent).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { flushNotifications } from '../src/services/notification.service.js';
import { Project, User } from '../src/models/index.js';
import { base32Encode, codeAt, stepAt, verifyCode } from '../src/security/twoFactor.js';

let t;
let outbox = [];
const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail(m) { const info = await jsonTransport.sendMail(m); outbox.push(JSON.parse(info.message)); return info; } });
});
beforeEach(async () => { await flushNotifications(); outbox = []; });
after(async () => { await flushNotifications(); __setTransport(null); await t.stop(); });

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const PASSWORD = 'test-password-1';
let n = 0;
const fresh = () => { n += 1; return `account.${n}@example.com`; };
const linkIn = (mail, kind) => new RegExp(`/${kind}/([A-Za-z0-9_-]+)`).exec(mail.text)?.[1];
const mailTo = (email) => outbox.filter((m) => m.to.some((x) => x.address === email));

test('TOTP matches the RFC 6238 test vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  // RFC 6238 appendix B (SHA-1), last 6 of the 8 digits.
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(codeAt(secret, stepAt(seconds * 1000)), code, `T=${seconds}`);
  }
  const now = 1234567890 * 1000;
  assert.equal(verifyCode(secret, '005924', { now }), stepAt(now));
  assert.equal(verifyCode(secret, '005924', { now, notAfterStep: stepAt(now) }), null, 'a used step is refused');
  assert.equal(verifyCode(secret, '000000', { now }), null);
});

test('sessions: each sign-in is a device; one can be signed out without the others', async () => {
  const email = fresh();
  const reg = await t.api('POST', '/api/auth/register', { body: { name: 'Multi Device', email, password: PASSWORD }, headers: { 'user-agent': CHROME } });
  const phone = (await t.api('POST', '/api/auth/login', { body: { email, password: PASSWORD }, headers: { 'user-agent': IPHONE } })).body.token;

  const list = await t.api('GET', '/api/auth/sessions', { token: reg.body.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  const mine = list.body.sessions.find((s) => s.current);
  const other = list.body.sessions.find((s) => !s.current);
  assert.deepEqual([mine.browser, mine.os], ['Chrome 130', 'Windows']);
  assert.match(other.os, /iOS/);

  assert.equal((await t.api('DELETE', `/api/auth/sessions/${other.id}`, { token: reg.body.token })).status, 204);
  assert.equal((await t.api('GET', '/api/auth/me', { token: phone })).status, 401, 'the phone is signed out');
  assert.equal((await t.api('GET', '/api/auth/me', { token: reg.body.token })).status, 200, 'this device is not');
  assert.equal((await t.api('DELETE', `/api/auth/sessions/${other.id}`, { token: reg.body.token })).status, 404);

  // Someone else's session can't be touched.
  const stranger = await t.signUp('Stranger');
  assert.equal((await t.api('DELETE', `/api/auth/sessions/${mine.id}`, { token: stranger.token })).status, 404);
  assert.equal((await t.api('GET', '/api/auth/me', { token: reg.body.token })).status, 200);
});

test('forgot password: same answer for unknown emails; the link works once and signs out every device', async () => {
  const unknown = await t.api('POST', '/api/auth/forgot', { body: { email: 'nobody.here@example.com' } });
  assert.deepEqual([unknown.status, unknown.body], [200, { sent: true }]);

  const email = fresh();
  const reg = await t.api('POST', '/api/auth/register', { body: { name: 'Forgetful', email, password: PASSWORD } });
  await flushNotifications();
  outbox = [];
  const known = await t.api('POST', '/api/auth/forgot', { body: { email: email.toUpperCase() } });
  assert.deepEqual(known.body, { sent: true });
  await flushNotifications();
  assert.equal(mailTo('nobody.here@example.com').length, 0);
  const mail = mailTo(email)[0];
  assert.match(mail.subject, /Reset your Tessera password/);
  const token = linkIn(mail, 'reset');
  assert.ok(token);

  const weak = await t.api('POST', '/api/auth/reset', { body: { token, password: 'short' } });
  assert.equal(weak.status, 400);
  const done = await t.api('POST', '/api/auth/reset', { body: { token, password: 'brand-new-pass-2' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await t.api('GET', '/api/auth/me', { token: reg.body.token })).status, 401, 'old sessions end');
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status, 401);
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email, password: 'brand-new-pass-2' } })).status, 200);
  const again = await t.api('POST', '/api/auth/reset', { body: { token, password: 'another-pass-3' } });
  assert.equal(again.body.error.code, 'link_invalid');
  assert.ok((await User.findOne({ email })).emailVerifiedAt, 'the reset proved the inbox');
});

test('email verification: link emailed at sign-up; unverified addresses get no notification emails', async () => {
  const email = fresh();
  const reg = await t.api('POST', '/api/auth/register', { body: { name: 'New Person', email, password: PASSWORD } });
  assert.equal(reg.body.user.emailVerifiedAt, null);
  await flushNotifications();
  const token = linkIn(mailTo(email)[0], 'verify');
  assert.ok(token, 'a verification link was emailed');

  // While unverified, being assigned while away sends no email.
  const admin = await t.signUp('Admin');
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Verify', key: 'VER' } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: reg.body.user.id, role: 'developer' } } });
  outbox = [];
  await t.api('POST', `/api/projects/${body.project.id}/tickets`, { token: admin.token, body: { title: 'One', assigneeId: reg.body.user.id } });
  await flushNotifications();
  assert.equal(mailTo(email).length, 0, 'no email to an unproven address');

  const ok = await t.api('POST', '/api/auth/verify', { body: { token } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.user.emailVerifiedAt);
  assert.equal((await t.api('POST', '/api/auth/verify', { body: { token } })).body.error.code, 'link_invalid');
  assert.deepEqual((await t.api('POST', '/api/auth/verify/resend', { token: reg.body.token })).body, { alreadyVerified: true });

  await t.api('POST', `/api/projects/${body.project.id}/tickets`, { token: admin.token, body: { title: 'Two', assigneeId: reg.body.user.id } });
  await flushNotifications();
  assert.equal(mailTo(email).length, 1, 'verified: the assignment email arrives');
});

test('two-factor: setup needs a code, login asks for it, codes and backup codes work once', async () => {
  const me = await t.signUp('Careful');
  const setup = await t.api('POST', '/api/auth/2fa/setup', { token: me.token });
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\/Tessera%3A.+\?secret=[A-Z2-7]+&issuer=Tessera/);
  const secret = setup.body.secret;

  assert.equal((await t.api('POST', '/api/auth/2fa/confirm', { token: me.token, body: { code: '000000' } })).body.error.code, 'invalid_2fa_code');
  const confirm = await t.api('POST', '/api/auth/2fa/confirm', { token: me.token, body: { code: codeAt(secret, stepAt()) } });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  const backup = confirm.body.backupCodes;
  assert.equal(backup.length, 10);
  assert.match(backup[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);

  // Secrets never leave the server.
  const meNow = (await t.api('GET', '/api/auth/me', { token: me.token })).body.user;
  assert.equal(meNow.twoFactorEnabled, true);
  assert.equal(meNow.twoFactor, undefined);

  const first = await t.api('POST', '/api/auth/login', { body: { email: me.email, password: me.password } });
  assert.equal(first.body.twoFactorRequired, true);
  assert.equal(first.body.token, undefined, 'no session from the password alone');
  const ticket = first.body.ticket;

  // The code used to confirm setup can't be used again; the next step's code can.
  const replay = await t.api('POST', '/api/auth/login/2fa', { body: { ticket, code: codeAt(secret, stepAt()) } });
  assert.equal(replay.body.error.code, 'invalid_2fa_code');
  const ok = await t.api('POST', '/api/auth/login/2fa', { body: { ticket, code: codeAt(secret, stepAt() + 1) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.email, me.email);

  // A ticket is not a login token.
  assert.equal((await t.api('GET', '/api/auth/me', { token: ticket })).status, 401);

  // Backup code: works once, and says how many are left.
  const ticket2 = (await t.api('POST', '/api/auth/login', { body: { email: me.email, password: me.password } })).body.ticket;
  const viaBackup = await t.api('POST', '/api/auth/login/2fa', { body: { ticket: ticket2, code: backup[0].toUpperCase() } });
  assert.equal(viaBackup.status, 200);
  assert.equal(viaBackup.body.backupCodesLeft, 9);
  const ticket3 = (await t.api('POST', '/api/auth/login', { body: { email: me.email, password: me.password } })).body.ticket;
  assert.equal((await t.api('POST', '/api/auth/login/2fa', { body: { ticket: ticket3, code: backup[0] } })).body.error.code, 'invalid_2fa_code');

  // Turning it off needs the password and a code.
  const noPass = await t.api('POST', '/api/auth/2fa/disable', { token: ok.body.token, body: { password: 'wrong-pass-9', code: backup[1] } });
  assert.equal(noPass.status, 403);
  const off = await t.api('POST', '/api/auth/2fa/disable', { token: ok.body.token, body: { password: me.password, code: backup[1] } });
  assert.deepEqual(off.body, { enabled: false });
  const plain = await t.api('POST', '/api/auth/login', { body: { email: me.email, password: me.password } });
  assert.ok(plain.body.token, 'password alone works again');
});
