// Auth against a real throwaway MongoDB (never Atlas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startTestServer } from './helpers.js';
import { User, Project, Ticket, TicketEvent, Session } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let n = 0;
const PASSWORD = 'correct-horse-1';
async function signUp(overrides = {}) {
  n += 1;
  const body = { name: 'Asha Rao', email: `user${n}@example.com`, password: PASSWORD, ...overrides };
  const res = await t.api('POST', '/api/auth/register', { body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body, email: body.email.trim().toLowerCase() };
}

test('register returns a token and a user without secrets', async () => {
  const { token, user } = await signUp({ email: '  Mixed.Case@Example.COM ' });
  assert.ok(token);
  assert.equal(user.email, 'mixed.case@example.com');
  assert.ok(user.id);
  for (const secret of ['passwordHash', 'tokenVersion', '_id', '__v']) assert.equal(user[secret], undefined, secret);
  const stored = await User.findById(user.id).select('+passwordHash');
  assert.match(stored.passwordHash, /^\$2[aby]\$/);
  assert.notEqual(stored.passwordHash, PASSWORD);
});

test('the token is HS256, issued by tessera, for this user, valid for 7 days', async () => {
  const { token, user } = await signUp();
  const { header, payload } = jwt.decode(token, { complete: true });
  assert.equal(header.alg, 'HS256');
  assert.equal(payload.iss, 'tessera');
  assert.equal(payload.sub, user.id);
  assert.ok(payload.jti);
  assert.equal(payload.exp - payload.iat, 7 * 24 * 3600);
});

test('register validation and duplicate email', async () => {
  const bad = await t.api('POST', '/api/auth/register', { body: { name: '', email: 'nope', password: 'short' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'validation_failed');
  const fields = bad.body.error.details.map((d) => d.field);
  for (const f of ['name', 'email', 'password']) assert.ok(fields.includes(f), f);

  const noDigit = await t.api('POST', '/api/auth/register', { body: { name: 'A', email: 'x@example.com', password: 'onlyletters' } });
  assert.equal(noDigit.status, 400);
  const tooLong = await t.api('POST', '/api/auth/register', { body: { name: 'A', email: 'y@example.com', password: `a1${'é'.repeat(40)}` } });
  assert.equal(tooLong.status, 400, 'over 72 bytes is refused');

  const { email } = await signUp();
  const dup = await t.api('POST', '/api/auth/register', { body: { name: 'B', email: email.toUpperCase(), password: PASSWORD } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'email_taken');
});

test('login works with any email case; wrong password and unknown email give the same answer', async () => {
  const { email } = await signUp();
  const ok = await t.api('POST', '/api/auth/login', { body: { email: email.toUpperCase(), password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.user.passwordHash, undefined);

  const wrong = await t.api('POST', '/api/auth/login', { body: { email, password: 'wrong-password-1' } });
  const unknown = await t.api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: PASSWORD } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('protected routes need a valid Bearer token', async () => {
  assert.equal((await t.api('GET', '/api/auth/me')).body.error.code, 'auth_required');
  assert.equal((await t.api('GET', '/api/auth/me', { headers: { authorization: 'Basic abc' } })).status, 401);
  assert.equal((await t.api('GET', '/api/auth/me', { token: 'not.a.jwt' })).body.error.code, 'invalid_token');

  const { token, user } = await signUp();
  const me = await t.api('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, user.id);

  // Signed with a different secret, or with "none": refused.
  const claims = jwt.decode(token);
  const forged = jwt.sign({ tv: 0 }, 'another-secret-another-secret-0123456789', { subject: claims.sub, issuer: 'tessera', jwtid: 'x' });
  assert.equal((await t.api('GET', '/api/auth/me', { token: forged })).status, 401);
  const unsigned = jwt.sign({ tv: 0, sub: claims.sub, iss: 'tessera', jti: 'y' }, null, { algorithm: 'none' });
  assert.equal((await t.api('GET', '/api/auth/me', { token: unsigned })).status, 401);
});

test('an expired token says so', async () => {
  const { user } = await signUp();
  const expired = jwt.sign({ tv: 0 }, process.env.JWT_SECRET, {
    subject: user.id, issuer: 'tessera', jwtid: 'old', expiresIn: -10,
  });
  const res = await t.api('GET', '/api/auth/me', { token: expired });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'token_expired');
});

test('logout ends only this token; its session expires with the token', async () => {
  const { token, email } = await signUp();
  const other = (await t.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.token;
  assert.equal((await t.api('POST', '/api/auth/logout', { token })).status, 204);
  assert.equal((await t.api('GET', '/api/auth/me', { token })).status, 401);
  assert.equal((await t.api('GET', '/api/auth/me', { token: other })).status, 200);
  const row = await Session.findOne({ jti: jwt.decode(token).jti });
  assert.ok(row.revokedAt, 'the session is marked signed out');
  assert.equal(row.expiresAt.getTime(), jwt.decode(token).exp * 1000);
});

test('logout-all ends every token of that user, and only that user', async () => {
  const a = await signUp();
  const b = await signUp();
  const a2 = (await t.api('POST', '/api/auth/login', { body: { email: a.email, password: PASSWORD } })).body.token;
  assert.equal((await t.api('POST', '/api/auth/logout-all', { token: a.token })).status, 204);
  assert.equal((await t.api('GET', '/api/auth/me', { token: a.token })).status, 401);
  assert.equal((await t.api('GET', '/api/auth/me', { token: a2 })).status, 401);
  assert.equal((await t.api('GET', '/api/auth/me', { token: b.token })).status, 200);
  // Logging in again works.
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email: a.email, password: PASSWORD } })).status, 200);
});

test('update name', async () => {
  const { token } = await signUp();
  const res = await t.api('PATCH', '/api/auth/me', { token, body: { name: '  Asha R  ' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, 'Asha R');
  assert.equal((await t.api('PATCH', '/api/auth/me', { token, body: { name: '' } })).status, 400);
});

test('change password: needs the current one, signs out other devices, keeps this one', async () => {
  const { token, email } = await signUp();
  const other = (await t.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.token;

  const wrong = await t.api('POST', '/api/auth/password', { token, body: { currentPassword: 'nope-nope-1', newPassword: 'new-password-2' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'wrong_password');

  const ok = await t.api('POST', '/api/auth/password', { token, body: { currentPassword: PASSWORD, newPassword: 'new-password-2' } });
  assert.equal(ok.status, 200);
  assert.equal((await t.api('GET', '/api/auth/me', { token: ok.body.token })).status, 200);
  assert.equal((await t.api('GET', '/api/auth/me', { token })).status, 401);
  assert.equal((await t.api('GET', '/api/auth/me', { token: other })).status, 401);
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status, 401);
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email, password: 'new-password-2' } })).status, 200);
});

test('delete account: needs the password; solo projects go, shared ones keep going', async () => {
  const me = await signUp();
  const teammate = await signUp();
  const meId = me.user.id;
  const mateId = teammate.user.id;

  const solo = await Project.create({ name: 'Solo', key: 'SOLO', owner: meId, members: [{ user: meId, role: 'admin' }] });
  const soloTicket = await Ticket.create({ project: solo._id, number: 1, title: 'Mine', status: 'todo', rank: 'a0' });
  await TicketEvent.create({ project: solo._id, ticket: soloTicket._id, actor: meId, type: 'created' });
  const shared = await Project.create({
    name: 'Shared', key: 'SHR', owner: meId,
    members: [{ user: meId, role: 'admin' }, { user: mateId, role: 'admin' }],
  });
  const sharedTicket = await Ticket.create({ project: shared._id, number: 1, title: 'Ours', status: 'todo', rank: 'a0', assignee: meId });

  const wrong = await t.api('DELETE', '/api/auth/me', { token: me.token, body: { password: 'wrong-pass-1' } });
  assert.equal(wrong.status, 403);

  const res = await t.api('DELETE', '/api/auth/me', { token: me.token, body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deletedProjects: 1, leftProjects: 1 });

  assert.equal(await User.exists({ _id: meId }), null);
  assert.equal(await Project.exists({ _id: solo._id }), null);
  assert.equal(await Ticket.countDocuments({ project: solo._id }), 0);
  assert.equal(await TicketEvent.countDocuments({ project: solo._id }), 0);

  const after = await Project.findById(shared._id).lean();
  assert.deepEqual(after.members.map((m) => String(m.user)), [mateId]);
  assert.equal((await Ticket.findById(sharedTicket._id)).assignee, null);
  const unassigned = await TicketEvent.findOne({ ticket: sharedTicket._id, type: 'assigned' }).lean();
  assert.equal(String(unassigned.from), meId);
  assert.equal(unassigned.to, null);

  assert.equal((await t.api('GET', '/api/auth/me', { token: me.token })).status, 401);
  assert.equal((await t.api('GET', '/api/auth/me', { token: teammate.token })).status, 200);
});

test('delete account is refused while you are the only admin of a shared project', async () => {
  const me = await signUp();
  const dev = await signUp();
  const project = await Project.create({
    name: 'Team', key: 'TEAM', owner: me.user.id,
    members: [{ user: me.user.id, role: 'admin' }, { user: dev.user.id, role: 'developer' }],
  });
  const res = await t.api('DELETE', '/api/auth/me', { token: me.token, body: { password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'sole_admin');
  assert.deepEqual(res.body.error.details, [{ project: String(project._id), key: 'TEAM', name: 'Team' }]);
  assert.ok(await User.exists({ _id: me.user.id }));
});
