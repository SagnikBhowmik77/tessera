import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../errors.js';
import { ApiToken, User } from '../models/index.js';

// Personal API tokens (E13) for scripts and the Tessera CLI. A token acts as its owner, inside
// the projects they belong to. Read tokens can only look; neither kind can manage the account
// (password, 2FA, sessions, other tokens): that always needs a real login.

export const TOKEN_PREFIX = 'tsp_';
const hash = (token) => createHash('sha256').update(token).digest('hex');
const MAX_ACTIVE = 20;

const json = (t) => ({
  id: String(t._id), name: t.name, prefix: t.prefix, scope: t.scope, createdAt: t.createdAt,
  expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt,
  expired: Boolean(t.expiresAt && t.expiresAt < new Date()),
});

export async function listTokens(user) {
  return (await ApiToken.find({ user: user._id }).sort({ createdAt: -1 }).limit(50).lean()).map(json);
}

export async function createToken(user, { name, scope, expiresInDays }) {
  const active = await ApiToken.countDocuments({ user: user._id, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
  if (active >= MAX_ACTIVE) throw new HttpError(409, 'too_many_tokens', `At most ${MAX_ACTIVE} active tokens. Revoke one first.`);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const doc = await ApiToken.create({
    user: user._id, name, scope, hash: hash(token), prefix: token.slice(0, 10),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
  });
  // Shown this once; only the hash is kept.
  return { ...json(doc), token };
}

export async function revokeToken(user, tokenId) {
  const t = await ApiToken.findOne({ _id: tokenId, user: user._id });
  if (!t) throw new HttpError(404, 'token_not_found', 'That token is not yours or does not exist');
  if (!t.revokedAt) { t.revokedAt = new Date(); await t.save(); }
  return json(t);
}

// Used by requireAuth for "Authorization: Bearer tsp_...".
export async function userFromApiToken(token) {
  const t = await ApiToken.findOne({ hash: hash(token), revokedAt: null });
  if (!t) throw new HttpError(401, 'invalid_token', 'This API token is not valid or was revoked');
  if (t.expiresAt && t.expiresAt < new Date()) throw new HttpError(401, 'token_expired', 'This API token has expired. Make a new one in your profile.');
  const user = await User.findById(t.user);
  if (!user) throw new HttpError(401, 'invalid_token', 'This API token is not valid or was revoked');
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000) await ApiToken.updateOne({ _id: t._id }, { $set: { lastUsedAt: new Date() } });
  return { user, claims: { sub: String(user._id), apiToken: String(t._id), scope: t.scope } };
}
