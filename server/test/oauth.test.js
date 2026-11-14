// Sign in with GitHub / Google (throwaway MongoDB; the providers' token/profile calls are stubbed,
// everything else, redirects, state, cookie, linking and sessions, is the real code).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { config } from '../src/config.js';
import { User } from '../src/models/index.js';
import { __setProviderExchange } from '../src/services/oauth.service.js';
import { codeAt, stepAt } from '../src/security/twoFactor.js';

let t;
before(async () => { t = await startTestServer(); });
afterEach(() => { __setProviderExchange('github', null); __setProviderExchange('google', null); });
after(() => t.stop());

// A browser step that must not follow redirects (we want to read where they point).
const nav = (path, headers = {}) => fetch(t.base + path, { redirect: 'manual', headers });

// Runs start -> provider -> callback like a browser. Returns { location, params } of the final
// redirect into the app (params = the URL fragment).
async function flow(provider, profile, { mode = 'login', intent, from, cookieOverride } = {}) {
  __setProviderExchange(provider, async ({ code }) => { assert.equal(code, 'code-from-provider'); return profile; });
  const q = new URLSearchParams({ mode, ...(intent && { intent }), ...(from && { from }) });
  const startRes = await nav(`/api/auth/oauth/${provider}/start?${q}`);
  assert.equal(startRes.status, 302);
  const providerUrl = new URL(startRes.headers.get('location'));
  const setCookie = startRes.headers.get('set-cookie');
  const cookie = cookieOverride ?? setCookie.split(';')[0];
  const state = providerUrl.searchParams.get('state');
  const cb = await nav(`/api/auth/oauth/${provider}/callback?${new URLSearchParams({ code: 'code-from-provider', state })}`, cookie ? { cookie } : {});
  assert.equal(cb.status, 302);
  const location = cb.headers.get('location');
  return { location, params: Object.fromEntries(new URLSearchParams(location.split('#')[1])), providerUrl, setCookie };
}
const exchange = (code) => t.api('POST', '/api/auth/oauth/exchange', { body: { code } });

let n = 0;
const gh = (extra = {}) => { n += 1; return { id: `gh-${n}`, login: `octo${n}`, name: `Octo ${n}`, email: `octo${n}@example.com`, emailVerified: true, ...extra }; };

test('providers are listed, and start sends the browser to GitHub with state and a strict cookie', async () => {
  assert.deepEqual((await t.api('GET', '/api/auth/oauth/providers')).body, { providers: { github: true, google: true } });
  const res = await nav('/api/auth/oauth/github/start');
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-github-client');
  assert.equal(url.searchParams.get('redirect_uri'), `${config.apiUrl}/api/auth/oauth/github/callback`);
  assert.ok(url.searchParams.get('state'));
  assert.match(res.headers.get('set-cookie'), /^tessera_oauth=[^;]+; HttpOnly; SameSite=Lax; Path=\/api\/auth\/oauth; Max-Age=600/);

  const g = new URL((await nav('/api/auth/oauth/google/start')).headers.get('location'));
  assert.equal(g.hostname, 'accounts.google.com');
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256', 'Google uses PKCE');
});

test('first sign-in creates a password-less, verified account; the one-time code works once', async () => {
  const profile = gh();
  const { location, params } = await flow('github', profile, { from: '/my-work' });
  assert.ok(location.startsWith(`${config.appUrl}/oauth#`));
  assert.equal(params.from, '/my-work');
  assert.ok(!location.includes('token'), 'no login token in any URL');

  const res = await exchange(params.code);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.email, profile.email);
  assert.equal(res.body.user.passwordSet, false);
  assert.ok(res.body.user.emailVerifiedAt);
  assert.equal(res.body.user.oauth.github.login, profile.login);
  assert.equal((await t.api('GET', '/api/auth/me', { token: res.body.token })).status, 200);
  assert.equal((await exchange(params.code)).body.error.code, 'oauth_code_invalid', 'single use');

  // Signing in again finds the same account.
  const again = await exchange((await flow('github', profile)).params.code);
  assert.equal(again.body.user.id, res.body.user.id);
  // No password: password login can't be used.
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email: profile.email, password: 'anything-1' } })).status, 401);
});

test('a callback without the browser cookie, or with another browser\'s cookie, is refused', async () => {
  const noCookie = await flow('github', gh(), { cookieOverride: '' });
  assert.match(noCookie.params.error, /another browser/);
  const other = (await nav('/api/auth/oauth/github/start')).headers.get('set-cookie').split(';')[0];
  const mismatch = await flow('github', gh(), { cookieOverride: other });
  assert.match(mismatch.params.error, /another browser/);
  assert.equal(mismatch.params.code, undefined);
});

test('same verified email links to the existing account; an unverified email never does', async () => {
  const me = await t.signUp('Has Password');
  const unverified = await flow('github', gh({ email: me.email, emailVerified: false }));
  assert.match(unverified.params.error, /no verified email/);
  assert.equal((await User.findById(me.user.id)).oauth?.github, undefined);

  const linked = await exchange((await flow('github', gh({ email: me.email.toUpperCase() }))).params.code);
  assert.equal(linked.body.user.id, me.user.id, 'same account');
  assert.equal(linked.body.user.passwordSet, true);
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email: me.email, password: me.password } })).status, 200, 'password still works');
});

test('2FA still applies after Google sign-in', async () => {
  const me = await t.signUp('Two Factor');
  const setup = await t.api('POST', '/api/auth/2fa/setup', { token: me.token });
  await t.api('POST', '/api/auth/2fa/confirm', { token: me.token, body: { code: codeAt(setup.body.secret, stepAt()) } });
  const done = await exchange((await flow('google', { id: 'g-2fa', name: 'Two Factor', email: me.email, emailVerified: true })).params.code);
  assert.equal(done.body.twoFactorRequired, true);
  assert.equal(done.body.token, undefined);
  const ok = await t.api('POST', '/api/auth/login/2fa', { body: { ticket: done.body.ticket, code: codeAt(setup.body.secret, stepAt() + 1) } });
  assert.equal(ok.status, 200);
});

test('connect from the account page; one GitHub account can\'t be on two Tessera accounts', async () => {
  const a = await t.signUp('Linker A');
  const b = await t.signUp('Linker B');
  const profile = gh({ email: 'someone.else@example.com' });

  const intentA = (await t.api('POST', '/api/auth/oauth/github/link-intent', { token: a.token })).body.intent;
  const linkA = await flow('github', profile, { mode: 'link', intent: intentA, from: '/account' });
  assert.deepEqual((await exchange(linkA.params.code)).body, { linked: 'github' });
  assert.equal((await User.findById(a.user.id)).oauth.github.id, profile.id);

  const intentB = (await t.api('POST', '/api/auth/oauth/github/link-intent', { token: b.token })).body.intent;
  const linkB = await flow('github', profile, { mode: 'link', intent: intentB });
  assert.match(linkB.params.error, /already connected to another Tessera account/);
  assert.equal(linkB.params.mode, 'link');

  // A forged or expired intent can't link anything.
  const forged = await nav('/api/auth/oauth/github/start?mode=link&intent=not-a-real-intent');
  const forgedParams = new URLSearchParams(forged.headers.get('location').split('#')[1]);
  assert.match(forgedParams.get('error'), /try again/);
  assert.equal(forgedParams.get('mode'), 'link');
});

test('password-less accounts: no unlinking the last way in; can set a password; delete needs the email typed', async () => {
  const profile = gh();
  const s = await exchange((await flow('github', profile)).params.code);
  const token = s.body.token;
  assert.equal((await t.api('DELETE', '/api/auth/oauth/github', { token })).body.error.code, 'oauth_last_login');

  const set = await t.api('POST', '/api/auth/password', { token, body: { newPassword: 'first-pass-1' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const fresh = set.body.token;
  const unlinked = await t.api('DELETE', '/api/auth/oauth/github', { token: fresh });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.user.oauth?.github, undefined);
  assert.equal((await t.api('POST', '/api/auth/login', { body: { email: profile.email, password: 'first-pass-1' } })).status, 200);

  const other = await exchange((await flow('github', gh())).params.code);
  assert.equal((await t.api('DELETE', '/api/auth/me', { token: other.body.token, body: { confirmEmail: 'wrong@example.com' } })).body.error.code, 'confirm_email');
  assert.equal((await t.api('DELETE', '/api/auth/me', { token: other.body.token, body: { confirmEmail: other.body.user.email } })).status, 200);
});

test('"from" can only point inside the app', async () => {
  const { params } = await flow('github', gh(), { from: '//evil.example.com/x' });
  assert.equal(params.from, '/projects');
});
