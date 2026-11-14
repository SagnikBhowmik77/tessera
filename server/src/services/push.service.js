import webpush from 'web-push';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { PushSubscription, User } from '../models/index.js';
import { isOnline } from '../realtime.js';
import { isQuiet } from './digest.service.js';

// Push notifications (E14) to the installed app or a browser tab that is closed. Sent with the
// project's own VAPID keys (generated locally), only to real browser push services, never while
// the person has Tessera open (the bell shows it live) or during their quiet hours.

let sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
export function __setPushSender(fn) { sender = fn ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options)); }

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export const pushConfigured = () => Boolean(config.push.publicKey && config.push.privateKey);
export const pushKey = () => (pushConfigured() ? config.push.publicKey : null);

const browserOf = (ua = '') => {
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${name} on ${os}` : name;
};

export async function listSubscriptions(user) {
  const rows = await PushSubscription.find({ user: user._id }).sort({ createdAt: -1 }).lean();
  return rows.map((s) => ({ id: String(s._id), browser: browserOf(s.userAgent ?? ''), createdAt: s.createdAt, lastSuccessAt: s.lastSuccessAt, endpointHost: new URL(s.endpoint).host }));
}

export async function subscribe(user, { endpoint, keys }, userAgent) {
  if (!pushConfigured()) throw new HttpError(503, 'push_not_configured', 'Push notifications are not set up on this server');
  let url;
  try { url = new URL(endpoint); } catch { throw new HttpError(400, 'bad_subscription', 'This is not a push subscription'); }
  // Only real push services: the server must never be made to call an arbitrary address.
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((r) => r.test(url.hostname))) throw new HttpError(400, 'bad_subscription', 'This push service is not supported');
  // A browser belongs to whoever subscribed it last.
  await PushSubscription.updateOne({ endpoint }, { $set: { user: user._id, keys, userAgent: (userAgent ?? '').slice(0, 300), failures: 0 } }, { upsert: true });
  const mine = await PushSubscription.find({ user: user._id }, { _id: 1 }).sort({ updatedAt: -1 }).lean();
  if (mine.length > 10) await PushSubscription.deleteMany({ _id: { $in: mine.slice(10).map((s) => s._id) } });
  return listSubscriptions(user);
}

export async function unsubscribe(user, { endpoint, id }) {
  await PushSubscription.deleteOne({ user: user._id, ...(id ? { _id: id } : { endpoint }) });
  return listSubscriptions(user);
}

// Sends to every browser the person subscribed. Gone subscriptions (404 / 410) are forgotten.
export async function sendToUser(userId, message) {
  if (!pushConfigured()) return { sent: 0 };
  const subs = await PushSubscription.find({ user: userId }).lean();
  let sent = 0;
  const options = { TTL: 6 * 3600, vapidDetails: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: config.push.privateKey } };
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(message), options);
      sent += 1;
      await PushSubscription.updateOne({ _id: s._id }, { $set: { lastSuccessAt: new Date(), failures: 0 } });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410 || s.failures >= 9) await PushSubscription.deleteOne({ _id: s._id });
      else await PushSubscription.updateOne({ _id: s._id }, { $inc: { failures: 1 } });
    }
  }
  return { sent };
}

const PHRASE = {
  mention: (a) => `${a} mentioned you`, assigned: (a) => `${a} assigned this to you`, comment: (a) => `${a} commented`,
  resolved: () => 'Finished', regression: () => 'Came back', portal_report: () => 'New public report', status_changed: (a) => `${a} moved it`,
  reminder: () => 'Back from snooze', sla_breached: () => 'Missed a service level', crash_new: () => 'New crash', crash_spike: () => 'Crash spiking',
  reporter_message: () => 'The reporter wrote', reporter_answer: () => 'Still broken for the reporter',
};

// From notify(): one push per notification, to people who are away and not in quiet hours.
export async function pushNotifications(docs, actorNames) {
  if (!pushConfigured() || !docs.length) return;
  const away = docs.filter((d) => !isOnline(d.user));
  if (!away.length) return;
  const users = new Map((await User.find({ _id: { $in: away.map((d) => d.user) } }, { notify: 1 }).lean()).map((u) => [String(u._id), u]));
  const now = new Date();
  for (const d of away) {
    const u = users.get(String(d.user));
    if (!u || isQuiet(u, now)) continue;
    if (!(await PushSubscription.exists({ user: d.user }))) continue;
    const who = actorNames.get(String(d.actor)) ?? 'Someone';
    await sendToUser(d.user, {
      title: `${d.ticketKey}: ${(PHRASE[d.type] ?? (() => 'Update'))(who)}`,
      body: d.excerpt ? `${d.ticketTitle}\n${d.excerpt}` : d.ticketTitle,
      url: `/projects/${d.project}/tickets/${d.ticketKey}`,
      tag: `${d.ticketKey}:${d.type}`,
    });
  }
}
