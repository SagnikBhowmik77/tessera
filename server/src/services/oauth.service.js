// "Sign in with GitHub / Google" (OAuth 2.0 authorization code flow, run by the API).
//
// 1. The browser opens /api/auth/oauth/:provider/start. The API sets a short HttpOnly cookie
//    (a random nonce, plus Google's PKCE verifier) and redirects to the provider with a signed
//    `state` naming that nonce. The cookie ties the callback to the same browser, so nobody can
//    sign a victim into the attacker's account by sending them a callback link.
// 2. The provider redirects back to /callback. The API checks state + cookie, exchanges the code,
//    reads the profile, and finds, links or creates the Tessera account.
// 3. The API redirects to the web app with a one-time code in the URL fragment (never sent to
//    servers or logs); the app trades it for the session token with POST /oauth/exchange. The
//    login token itself never appears in a URL.
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { User } from '../models/index.js';
import { issueLoginToken, twoFactorTicket } from './auth.service.js';

export const PROVIDERS = ['github', 'google'];
export const COOKIE = 'tessera_oauth';
const STATE_TTL = '10m';
const HANDOFF_MS = 60_000;

export const configured = (provider) => Boolean(config.oauth[provider]?.clientId && config.oauth[provider]?.clientSecret);
export const providerStatus = () => Object.fromEntries(PROVIDERS.map((p) => [p, configured(p)]));
const callbackUrl = (provider) => `${config.apiUrl}/api/auth/oauth/${provider}/callback`;
const label = { github: 'GitHub', google: 'Google' };
const b64url = (buf) => buf.toString('base64url');

async function getJson(url, init, what) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new HttpError(502, 'oauth_provider_error', `${what} failed${body?.error_description ? `: ${body.error_description}` : ''}`);
  }
  return body;
}

// The real providers. Tests swap `exchange` for a stub (no network).
const providers = {
  github: {
    authorizeUrl: ({ state }) => `https://github.com/login/oauth/authorize?${new URLSearchParams({
      client_id: config.oauth.github.clientId,
      redirect_uri: callbackUrl('github'),
      scope: 'read:user user:email',
      state,
      allow_signup: 'true',
    })}`,
    async exchange({ code }) {
      const token = await getJson('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: config.oauth.github.clientId, client_secret: config.oauth.github.clientSecret, code, redirect_uri: callbackUrl('github') }),
      }, 'GitHub sign-in');
      const auth = { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'Tessera' };
      const profile = await getJson('https://api.github.com/user', { headers: auth }, 'Reading your GitHub profile');
      const emails = await getJson('https://api.github.com/user/emails', { headers: auth }, 'Reading your GitHub email');
      // Only the primary, verified address counts (GitHub lets people add unverified ones).
      const primary = emails.find((e) => e.primary && e.verified);
      return { id: String(profile.id), login: profile.login, name: profile.name || profile.login, email: primary?.email ?? null, emailVerified: Boolean(primary) };
    },
  },
  google: {
    authorizeUrl: ({ state, challenge }) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: config.oauth.google.clientId,
      redirect_uri: callbackUrl('google'),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })}`,
    async exchange({ code, verifier }) {
      const token = await getJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: config.oauth.google.clientId, client_secret: config.oauth.google.clientSecret,
          redirect_uri: callbackUrl('google'), grant_type: 'authorization_code', code_verifier: verifier,
        }),
      }, 'Google sign-in');
      // Read straight from Google over TLS with the fresh access token.
      const info = await getJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } }, 'Reading your Google profile');
      return { id: String(info.sub), name: info.name || info.email, email: info.email ?? null, emailVerified: info.email_verified === true };
    },
  },
};
for (const p of PROVIDERS) providers[p].originalExchange = providers[p].exchange;

// Tests only: replace the network exchange with a stub (null restores the real one).
export function __setProviderExchange(provider, fn) {
  providers[provider].exchange = fn ?? providers[provider].originalExchange;
}

function requireProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new HttpError(404, 'oauth_unknown', 'Unknown sign-in provider');
  if (!configured(provider)) throw new HttpError(503, 'oauth_not_configured', `${label[provider]} sign-in is not set up on this server`);
}

// Where to land after signing in: a path inside the app only (no open redirect).
const safeFrom = (from) => (typeof from === 'string' && /^\/(?!\/)[^\s\\]{0,300}$/.test(from) ? from : '/projects');

// Linking needs the signed-in user, but /start is a plain browser navigation (no Authorization
// header). So the app first asks for a 2-minute "link intent" with its token, then navigates.
export function linkIntent(user, provider) {
  requireProvider(provider);
  return jwt.sign({ purpose: 'oauth-link', p: provider }, config.jwt.secret, {
    algorithm: 'HS256', subject: String(user._id), issuer: config.jwt.issuer, expiresIn: '2m',
  });
}

// Returns { url, cookie }: the provider page to send the browser to, and the cookie to set.
export function start(provider, { mode = 'login', intent, from }) {
  requireProvider(provider);
  let uid = null;
  if (mode === 'link') {
    try {
      const claims = jwt.verify(String(intent ?? ''), config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer });
      if (claims.purpose !== 'oauth-link' || claims.p !== provider) throw new Error('wrong purpose');
      uid = claims.sub;
    } catch {
      throw new HttpError(401, 'oauth_link_expired', 'That took too long. Open your account page and try again.');
    }
  }
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = jwt.sign({ purpose: 'oauth-state', p: provider, mode, uid, from: safeFrom(from), nonce }, config.jwt.secret, {
    algorithm: 'HS256', issuer: config.jwt.issuer, expiresIn: STATE_TTL,
  });
  return { url: providers[provider].authorizeUrl({ state, challenge }), cookie: b64url(Buffer.from(JSON.stringify({ nonce, verifier }))) };
}

// One-time codes handed to the web app (60 seconds, single use). Kept in memory: a code only
// lives for the redirect from the provider back to the app.
const handoffs = new Map();
function handoff(result) {
  const code = b64url(randomBytes(24));
  handoffs.set(code, { result, expires: Date.now() + HANDOFF_MS });
  for (const [k, v] of handoffs) if (v.expires < Date.now()) handoffs.delete(k);
  return code;
}
export function exchangeHandoff(code) {
  const entry = handoffs.get(String(code));
  handoffs.delete(String(code));
  if (!entry || entry.expires < Date.now()) throw new HttpError(400, 'oauth_code_invalid', 'That sign-in link expired. Please try again.');
  return entry.result;
}

const appRedirect = (params) => `${config.appUrl}/oauth#${new URLSearchParams(params)}`;

// The provider sent the browser back. Always returns where to redirect it (errors included,
// so the person sees a readable message in the app instead of raw JSON).
export async function callback(provider, { code, state, error, cookie }, meta) {
  let from = '/projects';
  let mode = 'login';
  try {
    requireProvider(provider);
    if (error) throw new HttpError(400, 'oauth_cancelled', `${label[provider]} sign-in was cancelled`);
    let claims;
    try {
      claims = jwt.verify(String(state ?? ''), config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer });
    } catch {
      throw new HttpError(400, 'oauth_state', 'That sign-in took too long or came from another browser. Please try again.');
    }
    from = claims.from;
    mode = claims.mode;
    let saved = null;
    try { saved = JSON.parse(Buffer.from(String(cookie ?? ''), 'base64url').toString('utf8')); } catch { /* checked below */ }
    if (claims.purpose !== 'oauth-state' || claims.p !== provider || !saved || saved.nonce !== claims.nonce) {
      throw new HttpError(400, 'oauth_state', 'That sign-in took too long or came from another browser. Please try again.');
    }
    const profile = await providers[provider].exchange({ code: String(code ?? ''), verifier: saved.verifier });
    const result = mode === 'link'
      ? await linkAccount(claims.uid, provider, profile)
      : await signIn(provider, profile, meta);
    return appRedirect({ code: handoff(result), from });
  } catch (err) {
    // Our own errors are written for people; anything unexpected stays in the server log.
    if (!(err instanceof HttpError)) console.error(`OAuth ${provider} callback failed: ${err.message}`);
    return appRedirect({ error: err instanceof HttpError ? err.message : 'Sign-in failed. Please try again.', mode, from });
  }
}

const linkField = (provider, profile) => (provider === 'github'
  ? { id: profile.id, login: profile.login }
  : { id: profile.id, email: profile.email });

async function signIn(provider, profile, meta) {
  const key = `oauth.${provider}.id`;
  let user = await User.findOne({ [key]: profile.id });
  if (!user) {
    if (!profile.email || !profile.emailVerified) {
      throw new HttpError(400, 'oauth_email_unverified', `Your ${label[provider]} account has no verified email address, so it can't be used to sign in.`);
    }
    const email = profile.email.toLowerCase();
    // Same verified email as an existing account: it's the same person, so link the two.
    user = await User.findOneAndUpdate(
      { email, [key]: { $exists: false } },
      { $set: { [`oauth.${provider}`]: linkField(provider, profile) } },
      { returnDocument: 'after' },
    );
    if (user && !user.emailVerifiedAt) {
      // The provider has verified this address, so it counts as confirmed here too.
      user.emailVerifiedAt = new Date();
      await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: user.emailVerifiedAt } });
    }
    if (!user) {
      if (await User.exists({ email })) throw new HttpError(409, 'oauth_email_taken', `${email} already belongs to an account linked to a different ${label[provider]} account.`);
      user = await User.create({
        name: String(profile.name || email).slice(0, 80),
        email,
        passwordHash: null,
        passwordSet: false,
        emailVerifiedAt: new Date(),
        oauth: { [provider]: linkField(provider, profile) },
      });
    }
  }
  // 2FA still applies: the provider proves who you are on GitHub/Google, not your code.
  if (user.twoFactorEnabled) return twoFactorTicket(user);
  return { token: await issueLoginToken(user, meta) };
}

async function linkAccount(uid, provider, profile) {
  const user = await User.findById(uid);
  if (!user) throw new HttpError(401, 'oauth_link_expired', 'Please log in again.');
  const owner = await User.findOne({ [`oauth.${provider}.id`]: profile.id }, { _id: 1 });
  if (owner && String(owner._id) !== String(user._id)) {
    throw new HttpError(409, 'oauth_in_use', `That ${label[provider]} account is already connected to another Tessera account.`);
  }
  await User.updateOne({ _id: user._id }, { $set: { [`oauth.${provider}`]: linkField(provider, profile) } });
  return { linked: provider };
}

// Disconnect a provider. Never the last way in: someone without a password keeps at least one.
export async function unlink(user, provider) {
  if (!PROVIDERS.includes(provider)) throw new HttpError(404, 'oauth_unknown', 'Unknown sign-in provider');
  const others = PROVIDERS.filter((p) => p !== provider && user.oauth?.[p]?.id);
  if (!user.passwordSet && others.length === 0) {
    throw new HttpError(409, 'oauth_last_login', `Set a password first: ${label[provider]} is your only way to sign in.`);
  }
  await User.updateOne({ _id: user._id }, { $unset: { [`oauth.${provider}`]: 1 } });
  return User.findById(user._id);
}
