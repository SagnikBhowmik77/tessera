import { config } from '../config.js';
import * as auth from '../services/auth.service.js';
import * as oauth from '../services/oauth.service.js';
import { disconnectSession, disconnectUser } from '../realtime.js';

// Controllers translate HTTP <-> service calls; all rules live in the service.

// The device signing in, shown later in "Active sessions".
const metaOf = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

export async function register(req, res) {
  res.status(201).json(await auth.register(req.valid.body, metaOf(req)));
}

export async function login(req, res) {
  res.json(await auth.login(req.valid.body, metaOf(req)));
}

export function me(req, res) {
  res.json({ user: req.user });
}

export async function updateMe(req, res) {
  res.json({ user: await auth.updateProfile(req.user, req.valid.body) });
}

export async function updatePreferences(req, res) {
  res.json({ user: await auth.updatePreferences(req.user, req.valid.body) });
}

export async function logout(req, res) {
  await auth.logout(req.auth);
  res.status(204).end();
}

// The three below also close that person's live connections, which were opened with old tokens.
export async function logoutAll(req, res) {
  await auth.logoutAll(req.user);
  disconnectUser(String(req.user._id));
  res.status(204).end();
}

export async function changePassword(req, res) {
  const result = await auth.changePassword(req.user, req.valid.body, metaOf(req));
  disconnectUser(String(req.user._id));
  res.json(result);
}

export async function deleteMe(req, res) {
  const result = await auth.deleteAccount(req.user, req.valid.body);
  disconnectUser(String(req.user._id));
  res.json(result);
}


export async function loginSecondStep(req, res) {
  res.json(await auth.loginSecondStep(req.valid.body, metaOf(req)));
}

export async function sessions(req, res) {
  res.json({ sessions: await auth.listSessions(req.user, req.auth.jti) });
}

export async function revokeSession(req, res) {
  const jti = await auth.revokeSession(req.user, req.valid.params.sessionId);
  disconnectSession(jti);
  res.status(204).end();
}

export async function forgot(req, res) {
  res.json(await auth.requestPasswordReset(req.valid.body));
}

export async function reset(req, res) {
  const result = await auth.resetPassword(req.valid.body);
  res.json(result);
}

export async function verify(req, res) {
  res.json(await auth.verifyEmail(req.valid.body));
}

export async function resendVerification(req, res) {
  res.json(await auth.resendVerification(req.user));
}

export async function twoFactorStatus(req, res) {
  res.json({ enabled: req.user.twoFactorEnabled, backupCodesLeft: await auth.backupCodesLeft(req.user) });
}

export async function twoFactorStart(req, res) {
  res.json(await auth.startTwoFactor(req.user));
}

export async function twoFactorConfirm(req, res) {
  res.json(await auth.confirmTwoFactor(req.user, req.valid.body));
}

export async function twoFactorDisable(req, res) {
  res.json(await auth.disableTwoFactor(req.user, req.valid.body));
}

export async function twoFactorBackupCodes(req, res) {
  res.json(await auth.regenerateBackupCodes(req.user, req.valid.body));
}

// ---- Sign in with GitHub / Google (see services/oauth.service.js) ----

const COOKIE_PATH = '/api/auth/oauth';
const secureCookie = () => config.apiUrl.startsWith('https://');
const oauthCookie = (value, maxAge) => `${oauth.COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAge}${secureCookie() ? '; Secure' : ''}`;
const readCookie = (req, name) => (req.get('cookie') || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

export function oauthProviders(_req, res) {
  res.json({ providers: oauth.providerStatus() });
}

// A browser navigation: on success it goes on to GitHub / Google, on failure back to the app.
export function oauthStart(req, res) {
  const { provider } = req.valid.params;
  const { mode, intent, from } = req.valid.query;
  try {
    const { url, cookie } = oauth.start(provider, { mode, intent, from });
    res.setHeader('Set-Cookie', oauthCookie(cookie, 600));
    res.redirect(302, url);
  } catch (err) {
    res.redirect(302, `${config.appUrl}/oauth#${new URLSearchParams({ error: err.message, mode: mode ?? 'login' })}`);
  }
}

export async function oauthCallback(req, res) {
  const { provider } = req.valid.params;
  const target = await oauth.callback(provider, { ...req.query, cookie: readCookie(req, oauth.COOKIE) }, metaOf(req));
  // The cookie has done its job either way.
  res.setHeader('Set-Cookie', oauthCookie('', 0));
  res.redirect(302, target);
}

export function oauthLinkIntent(req, res) {
  res.json({ intent: oauth.linkIntent(req.user, req.valid.params.provider) });
}

// The web app trades the one-time code from the redirect for what the sign-in produced.
export async function oauthExchange(req, res) {
  const result = oauth.exchangeHandoff(req.valid.body.code);
  if (result.token) {
    const { user } = await auth.verifyToken(result.token);
    return res.json({ user, token: result.token });
  }
  res.json(result);
}

export async function oauthUnlink(req, res) {
  res.json({ user: await oauth.unlink(req.user, req.valid.params.provider) });
}
