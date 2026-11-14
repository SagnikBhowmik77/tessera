import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { escapeHtml, sendMail } from '../mailer.js';
import { Notification, Project, User } from '../models/index.js';
import { ticketUrl } from './notification.service.js';

// Quiet hours and digests (E13). During quiet hours notification emails are held (the bell still
// shows everything) and sent as one summary when quiet hours end. With a daily or weekly digest,
// people get no single emails at all, just one summary of what they haven't read, at their hour.

export const DIGESTS = ['off', 'daily', 'weekly'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const validTimeZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

function localParts(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), hour: Number(parts.hour), weekday: parts.weekday };
}
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const zoneOf = (user) => user.notify?.timeZone || config.timeZone;

// Quiet hours may cross midnight (22:00 to 07:00).
export function isQuiet(user, now = new Date()) {
  const q = user.notify?.quiet;
  if (!q?.enabled || !HHMM.test(q.from ?? '') || !HHMM.test(q.to ?? '')) return false;
  const { minutes } = localParts(now, zoneOf(user));
  const from = toMinutes(q.from);
  const to = toMinutes(q.to);
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export function notifySettings(user) {
  const n = user.notify ?? {};
  return {
    emailNotifications: user.emailNotifications !== false,
    digest: n.digest ?? 'off', digestHour: n.digestHour ?? 8,
    quiet: { enabled: Boolean(n.quiet?.enabled), from: n.quiet?.from ?? '22:00', to: n.quiet?.to ?? '08:00' },
    timeZone: zoneOf(user), lastDigestAt: n.lastDigestAt ?? null,
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}

export async function updateNotifySettings(user, { emailNotifications, digest, digestHour, quiet, timeZone }) {
  if (timeZone !== undefined && !validTimeZone(timeZone)) throw new HttpError(400, 'bad_timezone', 'Pick a time zone from the list, e.g. Asia/Kolkata');
  if (emailNotifications !== undefined) user.emailNotifications = emailNotifications;
  const current = notifySettings(user);
  user.notify = {
    digest: digest ?? current.digest,
    digestHour: digestHour ?? current.digestHour,
    timeZone: timeZone ?? user.notify?.timeZone ?? null,
    quiet: { ...current.quiet, ...(quiet ?? {}) },
    lastDigestAt: user.notify?.lastDigestAt ?? null,
  };
  await user.save();
  return notifySettings(user);
}

const PHRASE = {
  mention: 'mentioned you', assigned: 'assigned to you', comment: 'new comment', resolved: 'finished', regression: 'came back',
  portal_report: 'new public report', status_changed: 'moved', reminder: 'back from snooze', sla_breached: 'missed a service level',
  crash_new: 'new crash', crash_spike: 'crash spiking', reporter_message: 'the reporter wrote', reporter_answer: 'still broken for the reporter',
};

// One email listing notifications, grouped by project. Returns true when sent.
async function summaryEmail(user, items, total, subject, intro) {
  if (!items.length) return false;
  const projects = new Map((await Project.find({ _id: { $in: [...new Set(items.map((n) => String(n.project)))] } }, { name: 1 }).lean()).map((p) => [String(p._id), p.name]));
  const groups = new Map();
  for (const n of items) {
    const name = projects.get(String(n.project)) ?? 'A deleted project';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(n);
  }
  const head = total > items.length ? `${intro} (the ${items.length} newest of ${total})` : intro;
  const text = [head, ...[...groups].map(([name, list]) => [name, ...list.map((n) => `- ${n.ticketKey} ${n.ticketTitle}: ${PHRASE[n.type] ?? n.type}${n.excerpt ? ` ("${n.excerpt.slice(0, 120)}")` : ''}\n  ${ticketUrl(n.project, n.ticketKey)}`)].join('\n')),
    'Change how you get these in your profile, under Notifications.'].join('\n\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e4e4e7">
<div style="font-size:20px;font-weight:600">Tessera</div><p style="font-size:15px;line-height:1.6">${escapeHtml(head)}</p>
${[...groups].map(([name, list]) => `<h3 style="font-size:14px;margin:20px 0 6px">${escapeHtml(name)}</h3><ul style="padding-left:18px;margin:0">${list.map((n) => `<li style="margin:4px 0;font-size:14px"><a href="${escapeHtml(ticketUrl(n.project, n.ticketKey))}" style="color:#5b4bd6">${escapeHtml(n.ticketKey)} ${escapeHtml(n.ticketTitle)}</a>: ${escapeHtml(PHRASE[n.type] ?? n.type)}</li>`).join('')}</ul>`).join('')}
<p style="font-size:13px;color:#71717a;margin-top:24px">Change how you get these in your profile, under Notifications.</p></div></body></html>`;
  await sendMail({ to: user.email, subject, text, html });
  return true;
}

// Called every few minutes. Returns what it did (for tests and logs).
export async function runDigestSweep(now = new Date()) {
  const done = { digests: 0, released: 0 };
  const eligible = { emailNotifications: { $ne: false }, emailVerifiedAt: { $ne: null } };
  const fields = 'email name notify emailVerifiedAt emailNotifications';

  // 1. Quiet hours over: send what was held, if still unread.
  const heldUsers = await Notification.distinct('user', { emailHeld: true });
  const canEmail = await User.find({ _id: { $in: heldUsers }, ...eligible }, fields);
  for (const user of canEmail) {
    if (isQuiet(user, now) || (user.notify?.digest ?? 'off') !== 'off') continue;
    const filter = { user: user._id, emailHeld: true, readAt: null };
    const held = await Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    const total = await Notification.countDocuments(filter);
    await Notification.updateMany({ user: user._id, emailHeld: true }, { $set: { emailHeld: false } });
    if (await summaryEmail(user, held, total, `While your notifications were paused: ${total} update${total === 1 ? '' : 's'}`, 'Here is what happened during your quiet hours.')) done.released += 1;
  }
  // Only people still in quiet hours keep held mail. Anyone who turned emails off, isn't verified
  // or switched to a digest never gets it (the digest covers what they haven't read).
  const stillQuiet = canEmail.filter((u) => isQuiet(u, now) && (u.notify?.digest ?? 'off') === 'off').map((u) => u._id);
  await Notification.updateMany({ emailHeld: true, user: { $nin: stillQuiet } }, { $set: { emailHeld: false } });

  // 2. Digests at the person's hour (weekly ones on Mondays).
  for (const user of await User.find({ 'notify.digest': { $in: ['daily', 'weekly'] }, ...eligible }, fields)) {
    const { hour, weekday } = localParts(now, zoneOf(user));
    const weekly = user.notify.digest === 'weekly';
    const last = user.notify.lastDigestAt?.getTime() ?? 0;
    if (hour !== (user.notify.digestHour ?? 8) || (weekly && weekday !== 'Mon')) continue;
    if (now.getTime() - last < (weekly ? 6 : 0.8) * 86_400_000) continue;
    const since = new Date(Math.max(last, now.getTime() - (weekly ? 8 : 2) * 86_400_000));
    const filter = { user: user._id, readAt: null, createdAt: { $gt: since } };
    const items = await Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    const total = await Notification.countDocuments(filter);
    await User.updateOne({ _id: user._id }, { $set: { 'notify.lastDigestAt': now } });
    if (await summaryEmail(user, items, total, `Your ${weekly ? 'weekly' : 'daily'} Tessera digest: ${total} update${total === 1 ? '' : 's'}`, "What you haven't read since your last digest.")) done.digests += 1;
  }
  return done;
}

export function startDigestSweep() {
  const tick = () => runDigestSweep().catch((err) => console.error('Digest sweep failed:', err.message));
  tick();
  setInterval(tick, 5 * 60 * 1000).unref();
}
