import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { escapeHtml, sendMail } from '../mailer.js';
import { Project, ProjectInvite, User } from '../models/index.js';

const INVITE_DAYS = 7;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const acceptUrl = (token) => `${config.appUrl}/invite/${token}`;

const pending = () => ({ acceptedAt: null, declinedAt: null, expiresAt: { $gt: new Date() } });

export async function createInvite(project, actor, inviter, { email, role }) {
  // Managers can bring in developers and viewers; only admins can invite managers or admins.
  if (actor.role !== 'admin' && ['admin', 'manager'].includes(role)) {
    throw new HttpError(403, 'forbidden', 'Only admins can invite managers or admins');
  }
  const existing = await User.findOne({ email }, { _id: 1 }).lean();
  if (existing && project.members.some((m) => String(m.user) === String(existing._id))) {
    throw new HttpError(409, 'already_member', 'This person is already a member of the project');
  }

  // Inviting the same email again replaces the earlier invite; its link stops working.
  await ProjectInvite.deleteMany({ project: project._id, email, ...pending() });

  const token = randomBytes(32).toString('base64url');
  const invite = await ProjectInvite.create({
    project: project._id,
    email,
    role,
    tokenHash: hashToken(token),
    invitedBy: inviter._id,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 3600 * 1000),
  });

  const url = acceptUrl(token);
  const subject = `${inviter.name} invited you to ${project.name} on Tessera`;
  const text = [
    `${inviter.name} (${inviter.email}) invited you to join the project "${project.name}" (${project.key}) on Tessera as ${role}.`,
    '',
    `Accept the invite: ${url}`,
    '',
    `The link works for ${INVITE_DAYS} days and only for an account using ${email}.`,
    "If you weren't expecting this, you can ignore this email.",
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18181b">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e4e4e7">
<div style="font-size:20px;font-weight:600;letter-spacing:-.01em">Tessera</div>
<p style="font-size:15px;line-height:1.6;margin:24px 0 8px"><strong>${escapeHtml(inviter.name)}</strong> invited you to join
<strong>${escapeHtml(project.name)}</strong> (${escapeHtml(project.key)}) as <strong>${escapeHtml(role)}</strong>.</p>
<p style="margin:28px 0"><a href="${escapeHtml(url)}" style="background:#7c6cf0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">Accept invite</a></p>
<p style="font-size:13px;line-height:1.6;color:#71717a">The link works for ${INVITE_DAYS} days and only for an account using ${escapeHtml(email)}.
If you weren't expecting this, you can ignore this email.</p>
</div></body></html>`;

  const delivery = await sendMail({ to: email, subject, text, html });
  // The link is also returned to the inviter, who can share it another way if email isn't set up or fails.
  return { invite, email: delivery, acceptUrl: url };
}

export async function listInvites(project) {
  return ProjectInvite.find({ project: project._id, ...pending() })
    .sort({ createdAt: -1 })
    .populate('invitedBy', 'name email');
}

export async function revokeInvite(project, inviteId) {
  const res = await ProjectInvite.deleteOne({ _id: inviteId, project: project._id, ...pending() });
  if (res.deletedCount === 0) throw new HttpError(404, 'invite_not_found', 'No pending invite with that id');
}

const invalidLink = () =>
  new HttpError(404, 'invite_invalid', 'This invite link is invalid, expired or already used. Ask for a new one.');

async function findPending(token) {
  const invite = await ProjectInvite.findOne({ tokenHash: hashToken(token), ...pending() });
  if (!invite) throw invalidLink();
  const project = await Project.findById(invite.project);
  if (!project) throw invalidLink();
  return { invite, project };
}

// What the invite page shows before signing in: who invited you, to what, as what.
export async function previewInvite(token) {
  const { invite, project } = await findPending(token);
  const inviter = await User.findById(invite.invitedBy, 'name').lean();
  return {
    project: { id: String(project._id), name: project.name, key: project.key },
    role: invite.role,
    email: invite.email,
    invitedBy: inviter?.name ?? null,
    expiresAt: invite.expiresAt,
  };
}

// The link proves the email reached its owner; the account must use that same email,
// so a forwarded link can't be used by someone else.
export async function acceptInvite(token, user) {
  const { invite, project } = await findPending(token);
  if (invite.email !== user.email) {
    throw new HttpError(403, 'invite_email_mismatch',
      `This invite was sent to ${invite.email}. Log in with that email to accept it.`);
  }
  // Claim the invite first, so the same link clicked twice at once adds the person only once.
  const claimed = await ProjectInvite.findOneAndUpdate(
    { _id: invite._id, ...pending() },
    { $set: { acceptedAt: new Date(), acceptedBy: user._id } },
  );
  if (!claimed) throw invalidLink();
  await Project.updateOne(
    { _id: project._id, 'members.user': { $ne: user._id } },
    { $push: { members: { user: user._id, role: invite.role, joinedAt: new Date() } } },
  );
  // The invite link arrived in this inbox, which proves the address: that counts as verified.
  if (!user.emailVerifiedAt) await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
  return Project.findById(project._id);
}

export async function declineInvite(token) {
  const { invite } = await findPending(token);
  await ProjectInvite.updateOne({ _id: invite._id }, { $set: { declinedAt: new Date() } });
}
