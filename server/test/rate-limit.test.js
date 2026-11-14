// Low limits for this file only; they must be set before the app (and its config) is imported.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOGIN_RATE_LIMIT = '3';
process.env.REGISTER_RATE_LIMIT = '2';
const { startTestServer } = await import('./helpers.js');

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

test('registering is limited per network', async () => {
  const body = (i) => ({ name: 'R', email: `r${i}@example.com`, password: 'password-123' });
  assert.equal((await t.api('POST', '/api/auth/register', { body: body(1) })).status, 201);
  assert.equal((await t.api('POST', '/api/auth/register', { body: body(2) })).status, 201);
  const third = await t.api('POST', '/api/auth/register', { body: body(3) });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'rate_limited');
});

test('only failed logins count towards the login limit', async () => {
  const good = { email: 'r1@example.com', password: 'password-123' };
  const bad = { email: 'r1@example.com', password: 'wrong-password-1' };
  for (let i = 0; i < 5; i += 1) assert.equal((await t.api('POST', '/api/auth/login', { body: good })).status, 200);
  for (let i = 0; i < 3; i += 1) assert.equal((await t.api('POST', '/api/auth/login', { body: bad })).status, 401);
  const blocked = await t.api('POST', '/api/auth/login', { body: good });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('ratelimit'), 'standard RateLimit header is sent');
});
