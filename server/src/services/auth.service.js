import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { parseUserAgent } from '../bugs/stacktrace.js';
import {
  EmailToken, Notification, Project, SavedFilter, Session, User, Leave, ApiToken, PushSubscription } from '../models/index.js';
import { leaveAllWorkspaces } from './workspace.service.js';
import {
  hashBackupCode, newBackupCodes, newSecret, openSecret, otpauthUri, sealSecret, verifyCode,
} from '../security/twoFactor.js';
import { purgeProjects, unassignMember } from './project.service.js';
import { forgetMember } from './follow.service.js';
import { sendResetEmail, sendVerifyEmail } from './accountMail.js';

export const authConfigured = () => Boolean(config.jwt.secret);

const invalidCredentials = () => new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Compared against when the email is unknown, so a login takes the same time whether or not
// the account exists (otherwise response time would reveal which emails are registered).
let dummyHash;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync('not-a-real-password-0', config.bcryptRounds));

// ---- Sessions ---------------------------------------------------------------------------
// Every login creates a Session (one per device). The token carries its id (jti), and a token
// only works while that session is live, so each device can be signed out on its own.

// meta: { userAgent, ip } of the request that signs in.
async function issueToken(user, meta = {}) {
  const jti = randomUUID();
  const token = jwt.sign({ tv: user.tokenVersion }, config.jwt.secret, {
    algorithm: 'HS256',
    subject: String(user._id),
    jwtid: jti,
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.expiresIn,
  });
  const env = parseUserAgent(meta.userAgent);
  const now = new Date();
  await Session.create({
    user: user._id,
    jti,
    browser: env?.browser ?? null,
    os: env?.os ?? null,
    ip: meta.ip ? String(meta.ip).slice(0, 64) : null,
    lastSeenAt: now,
    expiresAt: new Date(jwt.decode(token).exp * 1000),
  });
  return token;
}

// "Last active" is refreshed at most every few minutes, so most requests don't write.
const SEEN_EVERY_MS = 5 * 60 * 1000;

// Returns { user, claims } or throws 401. A token stops working when it expires, when its
// session was signed out, or when the user logged out everywhere / changed their password.
export async function verifyToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new HttpError(401, 'token_expired', 'Your session has expired. Please log in again.');
    throw new HttpError(401, 'invalid_token', 'Please log in to continue');
  }
  if (claims.purpose) throw new HttpError(401, 'invalid_token', 'Please log in to continue');
  const [user, session] = await Promise.all([
    User.findById(claims.sub),
    Session.findOne({ jti: claims.jti, user: claims.sub }, { revokedAt: 1, lastSeenAt: 1 }).lean(),
  ]);
  if (!user || !session || session.revokedAt || user.tokenVersion !== claims.tv) {
    throw new HttpError(401, 'invalid_token', 'Please log in to continue');
  }
  if (Date.now() - session.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    await Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });
  }
  return { user, claims };
}

export async function listSessions(user, currentJti) {
  const rows = await Session.find({ user: user._id, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 }).lean();
  return rows.map((s) => ({
    id: String(s._id),
    browser: s.browser,
    os: s.os,
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    current: s.jti === currentJti,
  }));
}

// Signs out one device. Returns its jti so the caller can close that device's live connection.
export async function revokeSession(user, sessionId) {
  const session = await Session.findOneAndUpdate(
    { _id: sessionId, user: user._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (!session) throw new HttpError(404, 'session_not_found', 'That session is already signed out');
  return session.jti;
}

const revokeAll = (userId, exceptJti = null) => Session.updateMany(
  { user: userId, revokedAt: null, ...(exceptJti && { jti: { $ne: exceptJti } }) },
  { $set: { revokedAt: new Date() } },
);

async function checkPassword(userId, password) {
  const withHash = await User.findById(userId).select('+passwordHash');
  return Boolean(withHash?.passwordHash) && bcrypt.compare(String(password ?? ''), withHash.passwordHash);
}

// For sign-in through GitHub / Google (oauth.service): the same session token as a password login.
export const issueLoginToken = (user, meta) => issueToken(user, meta);

// ---- Register and log in ----------------------------------------------------------------

export async function register({ name, email, password }, meta) {
  if (await User.exists({ email })) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists');
  }
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  let user;
  try {
    user = await User.create({ name, email, passwordHash });
  } catch (err) {
    // Two sign-ups with the same email at the same moment: the unique index decides.
    if (err.code === 11000) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    throw err;
  }
  await startVerification(user);
  return { user, token: await issueToken(user, meta) };
}

// With 2FA on, a correct password only earns a short-lived "ticket" for the code step.
const TICKET_TTL = '5m';

export async function login({ email, password }, meta) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const ok = await bcrypt.compare(password, user?.passwordHash ?? getDummyHash());
  if (!user || !ok) throw invalidCredentials();
  user.passwordHash = undefined;
  if (user.twoFactorEnabled) return twoFactorTicket(user);
  return { user, token: await issueToken(user, meta) };
}

// The "now enter your code" step, shared by password and GitHub / Google sign-in.
export function twoFactorTicket(user) {
  const ticket = jwt.sign({ purpose: '2fa', tv: user.tokenVersion }, config.jwt.secret, {
    algorithm: 'HS256', subject: String(user._id), issuer: config.jwt.issuer, expiresIn: TICKET_TTL,
  });
  return { twoFactorRequired: true, ticket };
}

const badCode = () => new HttpError(401, 'invalid_2fa_code', 'That code is not right. Use the current code from your authenticator app, or a backup code.');

// Accepts a 6-digit code from the app (each one only once) or an unused backup code.
async function consumeSecondFactor(userId, code) {
  const user = await User.findById(userId).select('+twoFactor');
  if (!user?.twoFactor?.enabled) return null;
  const given = String(code ?? '').trim();
  if (/^\d{6}$/.test(given.replace(/\s+/g, ''))) {
    const secret = openSecret(user.twoFactor.secret, config.jwt.secret);
    const step = verifyCode(secret, given, { notAfterStep: user.twoFactor.lastStep });
    if (step === null) return null;
    // Only moves forward, so a code used once (even in a race) can't be used again.
    const res = await User.updateOne({ _id: user._id, 'twoFactor.lastStep': { $lt: step } }, { $set: { 'twoFactor.lastStep': step } });
    return res.modifiedCount ? { user, usedBackupCode: false } : null;
  }
  const hash = hashBackupCode(given);
  const res = await User.updateOne({ _id: user._id, 'twoFactor.backupCodes': hash }, { $pull: { 'twoFactor.backupCodes': hash } });
  return res.modifiedCount ? { user, usedBackupCode: true } : null;
}

export async function loginSecondStep({ ticket, code }, meta) {
  let claims;
  try {
    claims = jwt.verify(ticket, config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer });
  } catch {
    throw new HttpError(401, 'ticket_expired', 'That sign-in took too long. Enter your password again.');
  }
  if (claims.purpose !== '2fa') throw new HttpError(401, 'invalid_token', 'Please log in to continue');
  const found = await consumeSecondFactor(claims.sub, code);
  if (!found) throw badCode();
  const user = await User.findById(claims.sub);
  if (!user || user.tokenVersion !== claims.tv) throw new HttpError(401, 'ticket_expired', 'Please log in again.');
  const left = found.usedBackupCode ? (await User.findById(user._id).select('+twoFactor')).twoFactor.backupCodes.length : null;
  return { user, token: await issueToken(user, meta), ...(left !== null && { backupCodesLeft: left }) };
}

export async function logout(claims) {
  await Session.updateOne({ jti: claims.jti }, { $set: { revokedAt: new Date() } });
}

export async function logoutAll(user) {
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  await revokeAll(user._id);
}

export async function updateProfile(user, { name, emailNotifications }) {
  if (name !== undefined) user.name = name;
  if (emailNotifications !== undefined) user.emailNotifications = emailNotifications;
  await user.save();
  return user;
}

// Saves some of the person's preferences; the rest stay as they were.
export async function updatePreferences(user, changes) {
  const { board, ...rest } = changes;
  Object.assign(user.preferences, rest);
  if (board) Object.assign(user.preferences.board, board);
  user.markModified('preferences');
  await user.save();
  return user;
}

// Signs out every other device; this one gets a fresh token and stays signed in.
// Someone who joined with GitHub / Google has no password yet and can set one without it.
export async function changePassword(user, { currentPassword, newPassword }, meta) {
  if (user.passwordSet && !(await checkPassword(user._id, currentPassword))) {
    throw new HttpError(403, 'wrong_password', 'Your current password is incorrect');
  }
  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { passwordHash, passwordSet: true }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' },
  );
  await revokeAll(user._id);
  return { user: updated, token: await issueToken(updated, meta) };
}

// ---- Emailed links: verify email, reset password -----------------------------------------

const LINK_TTL = { verify: 48 * 3600 * 1000, reset: 3600 * 1000 };

async function newLink(user, purpose) {
  const token = randomBytes(32).toString('base64url');
  // Only the newest link of each kind works.
  await EmailToken.deleteMany({ user: user._id, purpose, usedAt: null });
  await EmailToken.create({ user: user._id, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + LINK_TTL[purpose]) });
  return token;
}

// Claims a link exactly once. Returns the user it belongs to, or throws.
async function useLink(token, purpose) {
  const row = await EmailToken.findOneAndUpdate(
    { tokenHash: sha256(String(token)), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  if (!row) {
    throw new HttpError(400, 'link_invalid', purpose === 'reset'
      ? 'This reset link has expired or was already used. Ask for a new one.'
      : 'This verification link has expired or was already used. Send a new one from your account page.');
  }
  return row.user;
}

async function startVerification(user) {
  const token = await newLink(user, 'verify');
  sendVerifyEmail(user, `${config.appUrl}/verify/${token}`);
}

export async function resendVerification(user) {
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  await startVerification(user);
  return { sent: true };
}

export async function verifyEmail({ token }) {
  const userId = await useLink(token, 'verify');
  const user = await User.findByIdAndUpdate(userId, { $set: { emailVerifiedAt: new Date() } }, { returnDocument: 'after' });
  return { user };
}

// Always answers the same way, so the form can't be used to find out who has an account.
export async function requestPasswordReset({ email }) {
  const user = await User.findOne({ email });
  if (user) {
    const token = await newLink(user, 'reset');
    sendResetEmail(user, `${config.appUrl}/reset/${token}`);
  }
  return { sent: true };
}

// A reset proves the person controls the inbox, so it also verifies the email. Every device
// is signed out; they sign in again with the new password (and 2FA, if it is on).
export async function resetPassword({ token, password }) {
  const userId = await useLink(token, 'reset');
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await User.findById(userId);
  await User.updateOne({ _id: userId }, {
    $set: { passwordHash, ...(!user.emailVerifiedAt && { emailVerifiedAt: new Date() }) },
    $inc: { tokenVersion: 1 },
  });
  await revokeAll(userId);
  await EmailToken.deleteMany({ user: userId, purpose: 'reset', usedAt: null });
  return { reset: true, email: user.email };
}

// ---- Two-factor setup -------------------------------------------------------------------

// Step 1: a new secret for the authenticator app (not active until a code confirms it).
export async function startTwoFactor(user) {
  if (user.twoFactorEnabled) throw new HttpError(409, '2fa_already_on', 'Two-factor authentication is already on');
  const secret = newSecret();
  await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.pendingSecret': sealSecret(secret, config.jwt.secret) } });
  return { secret, otpauthUrl: otpauthUri(secret, user.email) };
}

// Step 2: the first code from the app proves it was set up right. Returns the backup codes,
// which are shown once and only stored hashed.
export async function confirmTwoFactor(user, { code }) {
  const full = await User.findById(user._id).select('+twoFactor');
  if (full.twoFactorEnabled) throw new HttpError(409, '2fa_already_on', 'Two-factor authentication is already on');
  if (!full.twoFactor?.pendingSecret) throw new HttpError(400, '2fa_not_started', 'Start the setup again');
  const secret = openSecret(full.twoFactor.pendingSecret, config.jwt.secret);
  const step = verifyCode(secret, code);
  if (step === null) throw badCode();
  const backupCodes = newBackupCodes();
  await User.updateOne({ _id: user._id }, {
    $set: {
      twoFactor: { enabled: true, secret: full.twoFactor.pendingSecret, pendingSecret: null, lastStep: step, backupCodes: backupCodes.map(hashBackupCode) },
      twoFactorEnabled: true,
    },
  });
  return { enabled: true, backupCodes };
}

// Turning it off needs the password and a current code (or a backup code).
export async function disableTwoFactor(user, { password, code }) {
  // Without a password (GitHub / Google account), the code alone proves it's them.
  if (user.passwordSet && !(await checkPassword(user._id, password))) throw new HttpError(403, 'wrong_password', 'Your password is incorrect');
  if (!user.twoFactorEnabled) return { enabled: false };
  if (!(await consumeSecondFactor(user._id, code))) throw badCode();
  await User.updateOne({ _id: user._id }, { $set: { twoFactor: {}, twoFactorEnabled: false } });
  return { enabled: false };
}

export async function regenerateBackupCodes(user, { code }) {
  if (!user.twoFactorEnabled) throw new HttpError(400, '2fa_off', 'Two-factor authentication is off');
  if (!(await consumeSecondFactor(user._id, code))) throw badCode();
  const backupCodes = newBackupCodes();
  await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.backupCodes': backupCodes.map(hashBackupCode) } });
  return { backupCodes };
}

export async function backupCodesLeft(user) {
  const full = await User.findById(user._id).select('+twoFactor');
  return full.twoFactor?.enabled ? full.twoFactor.backupCodes.length : null;
}

// ---- Delete account -----------------------------------------------------------------------

// Projects only this user is in are deleted with their tickets. In shared projects the user is
// removed and their tickets become unassigned. Refused while they are the only admin of a shared
// project, so a team is never left without anyone who can manage it.
export async function deleteAccount(user, { password, confirmEmail }) {
  if (user.passwordSet) {
    if (!(await checkPassword(user._id, password))) throw new HttpError(403, 'wrong_password', 'Your password is incorrect');
  } else if (String(confirmEmail ?? '').trim().toLowerCase() !== user.email) {
    // No password to check (GitHub / Google account): typing the email confirms it.
    throw new HttpError(403, 'confirm_email', 'Type your email address to confirm');
  }
  const me = String(user._id);
  const projects = await Project.find({ 'members.user': user._id });
  const solo = projects.filter((p) => p.members.length === 1);
  const shared = projects.filter((p) => p.members.length > 1);

  const orphaned = shared.filter((p) => !p.members.some((m) => String(m.user) !== me && m.role === 'admin'));
  if (orphaned.length) {
    throw new HttpError(409, 'sole_admin', 'Make someone else an admin of these projects first, or delete them',
      orphaned.map((p) => ({ project: String(p._id), key: p.key, name: p.name })));
  }

  const soloIds = solo.map((p) => p._id);
  await purgeProjects(soloIds);

  const sharedIds = shared.map((p) => p._id);
  if (sharedIds.length) {
    await unassignMember(sharedIds, user._id);
    await forgetMember(sharedIds, user._id);
    await Project.updateMany({ _id: { $in: sharedIds } }, { $pull: { members: { user: user._id } } });
  }
  // Pending invites this person sent stay valid: the project, not the inviter, owns them.

  // Their saved views go with them (shared ones too: they were theirs to keep).
  await SavedFilter.deleteMany({ owner: user._id });
  await Notification.deleteMany({ user: user._id });
  await Session.deleteMany({ user: user._id });
  await ApiToken.deleteMany({ user: user._id });
  await PushSubscription.deleteMany({ user: user._id });
  await leaveAllWorkspaces(user._id);
  await Leave.deleteMany({ user: user._id });
  await EmailToken.deleteMany({ user: user._id });
  await User.deleteOne({ _id: user._id });
  return { deletedProjects: soloIds.length, leftProjects: sharedIds.length };
}
