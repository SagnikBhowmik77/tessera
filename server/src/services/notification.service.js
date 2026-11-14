import { config } from '../config.js';
import { escapeHtml, sendMail } from '../mailer.js';
import { Notification, Tracker, User } from '../models/index.js';
import { isOnline, toUser } from '../realtime.js';
import { isQuiet } from './digest.service.js';
import { pushNotifications } from './push.service.js';

// Emails are sent in the background so a comment never waits for Gmail.
// Tests (and shutdown) can wait for them with flushNotifications().
const pending = new Set();
// Jobs can queue more jobs (the "fixed" email looks up each reporter, then sends), so this waits
// until the queue is really empty, not just for what was queued when it was called.
export async function flushNotifications() {
  while (pending.size) await Promise.allSettled([...pending]);
}

// Other emails (account links) use the same background queue, so tests can wait for them too.
export function runInBackground(job) {
  const p = Promise.resolve(job).catch((err) => console.error(`Background email failed: ${err.message}`));
  pending.add(p);
  p.finally(() => pending.delete(p));
}

// Only these are worth an email; the rest stay in the in-app inbox.
const EMAIL_TYPES = new Set(['mention', 'assigned', 'regression', 'crash_spike', 'reporter_message', 'reporter_answer']);

// "Hi @[Asha](id)!" -> "Hi @Asha!", shortened for previews.
export function excerptOf(body) {
  if (!body) return null;
  const plain = body.replace(/@\[([^\]\n]{1,80})\]\([a-f0-9]{24}\)/g, '@$1').replace(/\s+/g, ' ').trim();
  return plain.length > 200 ? `${plain.slice(0, 197)}…` : plain;
}

export const ticketUrl = (projectId, ticketKey) => `${config.appUrl}/projects/${projectId}/tickets/${ticketKey}`;

function emailFor(n, actorName) {
  const url = ticketUrl(n.project, n.ticketKey);
  const what = {
    mention: `${actorName} mentioned you on ${n.ticketKey}`,
    assigned: `${actorName} assigned ${n.ticketKey} to you`,
    regression: `${n.ticketKey} came back (the same error was reported again by ${actorName})`,
    crash_spike: `${n.ticketKey} is spiking (${n.excerpt})`,
    reporter_message: `The reporter of ${n.ticketKey} wrote`,
    reporter_answer: `${n.ticketKey} is still broken for its reporter`,
  }[n.type];
  const quote = n.excerpt ? `\n\n"${n.excerpt}"` : '';
  return {
    subject: `${what}: ${n.ticketTitle}`,
    text: `${what}: ${n.ticketTitle}${quote}\n\nOpen it: ${url}\n\nYou get these emails while you're away from Tessera. Turn them off in your profile.`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18181b">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e4e4e7">
<div style="font-size:20px;font-weight:600">Tessera</div>
<p style="font-size:15px;line-height:1.6;margin:24px 0 8px">${escapeHtml(what)}:<br><strong>${escapeHtml(n.ticketTitle)}</strong></p>
${n.excerpt ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #7c6cf0;background:#f7f6ff;color:#3f3f46">${escapeHtml(n.excerpt)}</blockquote>` : ''}
<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#7c6cf0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">Open ${escapeHtml(n.ticketKey)}</a></p>
<p style="font-size:13px;color:#71717a">You get these emails while you're away from Tessera. Turn them off in your profile.</p>
</div></body></html>`,
  };
}

async function emailAway(docs, actorNames) {
  const candidates = docs.filter((d) => EMAIL_TYPES.has(d.type) && !isOnline(d.user));
  if (!candidates.length) return;
  // Only addresses the person has proven are theirs (verified email) get notification emails.
  const users = await User.find({
    _id: { $in: candidates.map((d) => d.user) }, emailNotifications: { $ne: false }, emailVerifiedAt: { $ne: null },
  }, 'email notify').lean();
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const now = new Date();
  const held = [];
  for (const d of candidates) {
    const u = userOf.get(String(d.user));
    if (!u) continue;
    // A digest replaces single emails; quiet hours hold them for one summary afterwards (E13).
    if ((u.notify?.digest ?? 'off') !== 'off') continue;
    if (isQuiet(u, now)) { held.push(d._id); continue; }
    await sendMail({ to: u.email, ...emailFor(d, actorNames.get(String(d.actor)) ?? (d.type === 'assigned' ? 'An automation rule' : 'Someone')) });
  }
  if (held.length) await Notification.updateMany({ _id: { $in: held } }, { $set: { emailHeld: true } });
}

// Creates notifications, pushes them to open tabs, and emails people who are away.
// Never throws: a notification problem must not undo the change that caused it.
// items: [{ user, project, ticket, type, actor, ticketKey, ticketTitle, excerpt?, comment? }]
export async function notify(items) {
  try {
    const seen = new Set();
    const fresh = items.filter((n) => {
      const key = `${n.user}:${n.type}`;
      if (!n.user || String(n.user) === String(n.actor) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return;
    const docs = await Notification.insertMany(fresh);
    // Portal reports and GitHub have no person behind them (actor null).
    const actorIds = [...new Set(fresh.map((n) => n.actor).filter(Boolean).map(String))];
    const actors = actorIds.length ? await User.find({ _id: { $in: actorIds } }, 'name email') : [];
    const actorNames = new Map(actors.map((a) => [String(a._id), a.name]));
    const actorJson = new Map(actors.map((a) => [String(a._id), a.toJSON()]));
    for (const d of docs) {
      toUser(d.user, 'notification', { ...d.toJSON(), actor: actorJson.get(String(d.actor)) ?? null });
      toUser(d.user, 'notification:count', { unread: await unreadCount(d.user) });
    }
    const job = emailAway(docs, actorNames).catch((err) => console.error(`Notification email failed: ${err.message}`));
    pending.add(job);
    job.finally(() => pending.delete(job));
    // Push to the installed app / closed tabs (E14).
    const push = pushNotifications(docs, actorNames).catch((err) => console.error(`Push failed: ${err.message}`));
    pending.add(push);
    push.finally(() => pending.delete(push));
  } catch (err) {
    console.error(`Notifications failed: ${err.message}`);
  }
}

// Emails to someone outside the team who reported through the public portal.
// They have no account, so these go straight out (in the background) instead of to an inbox.
function emailOutsider(to, subject, lines) {
  const job = sendMail({
    to,
    subject,
    text: lines.join('\n\n'),
    html: `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18181b">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e4e4e7">
${lines.map((l) => (/^https?:\/\/\S+$/.test(l)
    ? `<p style="margin:0 0 14px"><a href="${escapeHtml(l)}" style="color:#5b4bd6;font-weight:600;word-break:break-all">${escapeHtml(l)}</a></p>`
    : `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${escapeHtml(l)}</p>`)).join('')}
</div></body></html>`,
  }).catch((err) => console.error(`Reporter email failed: ${err.message}`));
  pending.add(job);
  job.finally(() => pending.delete(job));
}

export const trackUrl = (token) => `${config.appUrl}/track/${token}`;
const hello = (name) => `Hi${name ? ` ${name}` : ''},`;

export function emailReporterReceipt(project, ticket, tracker) {
  const key = `${project.key}-${ticket.number}`;
  emailOutsider(tracker.email, `We received your report ${key}: ${tracker.title}`, [
    `${hello(tracker.name)} thanks for reporting this to the ${project.name} team.`,
    `Your report is ${key}: "${tracker.title}". We'll email you again when it's fixed.`,
    'Follow its progress, or send the team more details, on your private page:',
    trackUrl(tracker.token),
  ]);
}

// Everyone who reported it. Each person's email has their own link and the "did it work?" links.
// People from before tracking links (contact / otherReporters without a tracker) get the plain one.
export function emailReporterFixed(project, ticket) {
  const key = `${project.key}-${ticket.number}`;
  const job = (async () => {
    const trackers = await Tracker.find({ ticket: ticket._id, email: { $ne: null } }).lean();
    const done = new Set();
    for (const t of trackers) {
      if (done.has(t.email.toLowerCase())) continue;
      done.add(t.email.toLowerCase());
      emailOutsider(t.email, `Fixed: ${t.title} (${key})`, [
        `${hello(t.name)} good news from the ${project.name} team.`,
        `The issue you reported, ${key} "${t.title}", has been marked as fixed.`,
        'Is it fixed for you? Open one of these links and confirm.',
        'It is fixed:',
        `${trackUrl(t.token)}?answer=fixed`,
        'It is still broken (the team will reopen it):',
        `${trackUrl(t.token)}?answer=broken`,
      ]);
    }
    for (const person of [ticket.contact, ...(ticket.otherReporters ?? [])].filter((p) => p?.email && !done.has(p.email.toLowerCase()))) {
      emailOutsider(person.email, `Fixed: ${ticket.title} (${key})`, [
        `${hello(person.name)} good news from the ${project.name} team.`,
        `The issue you reported, ${key} "${ticket.title}", has been marked as fixed.`,
        'If you still see it, report it again through the same page and we will look at it.',
      ]);
    }
  })().catch((err) => console.error(`Reporter fixed emails failed: ${err.message}`));
  pending.add(job);
  job.finally(() => pending.delete(job));
}

// A teammate's reply to an outside reporter. Mentions are turned into plain names: the reporter
// has no account to follow them to.
export function emailReporterReply(project, ticket, authorName, body, to) {
  const key = `${project.key}-${ticket.number}`;
  const text = body.replace(/@\[([^\]\n]{1,80})\]\([a-f0-9]{24}\)/g, '@$1').trim();
  emailOutsider(to.email, `Re: ${to.title ?? ticket.title} (${key})`, [
    `${hello(to.name)} ${authorName} from the ${project.name} team replied about your report ${key}:`,
    text,
    ...(to.token ? ['Answer them, or follow the report, on your private page:', trackUrl(to.token)] : []),
  ]);
}

export function emailReporterMerged(project, target, tracker) {
  const key = `${project.key}-${target.number}`;
  emailOutsider(tracker.email, `Your report "${tracker.title}" is now followed as ${key}`, [
    `${hello(tracker.name)} the ${project.name} team found that your report describes the same problem as ${key}, so the two are now handled together.`,
    'Nothing is lost: you will still hear when it is fixed, and your private page keeps working:',
    trackUrl(tracker.token),
  ]);
}

export const unreadCount = (userId) => Notification.countDocuments({ user: userId, readAt: null });

export async function listNotifications(user, { unread, limit, before }) {
  const filter = { user: user._id };
  if (unread) filter.readAt = null;
  if (before) filter.createdAt = { $lt: before };
  const rows = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).populate('actor', 'name email');
  return { notifications: rows.map((r) => r.toJSON()), unread: await unreadCount(user._id) };
}

export async function markRead(user, { ids }) {
  const filter = { user: user._id, readAt: null };
  if (ids?.length) filter._id = { $in: ids };
  await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  const unread = await unreadCount(user._id);
  toUser(user._id, 'notification:count', { unread });
  return { unread };
}
