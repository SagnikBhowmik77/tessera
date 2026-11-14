import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Project, Ticket, WebhookDelivery } from '../models/index.js';
import { openSecret, sealSecret } from '../security/twoFactor.js';
import { onTicketEvents } from './hooks.js';
import { ticketUrl } from './notification.service.js';

// Slack / Discord alerts and outgoing webhooks (E13). They hear every ticket change through the
// hook registry and deliver in the background: a slow or broken endpoint never slows the app.

export const EVENTS = ['ticket.created', 'ticket.moved', 'ticket.done', 'ticket.assigned', 'ticket.commented', 'ticket.updated'];
const SLACK_URL = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/;
const DISCORD_URL = /^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;
const MAX_FAILURES = 20;

let fetchImpl = (...args) => fetch(...args);
let delays = [0, 2000, 8000];
export function __setOutboundFetch(fn, retryDelays) { fetchImpl = fn ?? ((...args) => fetch(...args)); delays = retryDelays ?? [0, 2000, 8000]; }

const seal = (s) => sealSecret(s, config.jwt.secret);
const open = (s) => openSecret(s, config.jwt.secret);
const id = (x) => String(x?._id ?? x);

// ---------- safety: never call into private networks from production ----------

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./i];
const isPrivate = (ip) => PRIVATE.some((r) => r.test(ip));

export async function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'bad_url', 'Enter a full address, like https://example.com/hooks/tessera'); }
  const production = config.env === 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) throw new HttpError(400, 'https_required', 'The address must start with https://');
  if (url.username || url.password) throw new HttpError(400, 'bad_url', 'Put credentials in the secret, not the address');
  if (production) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addresses.length) throw new HttpError(400, 'unknown_host', `${url.hostname} could not be found`);
    if (addresses.some(isPrivate)) throw new HttpError(400, 'private_address', 'Webhooks cannot point at private or local network addresses');
  }
  return url.toString();
}

// ---------- what a change looks like to the outside ----------

function eventsFor(project, internal) {
  const out = [];
  for (const e of internal) {
    if (e.type === 'created') out.push(['ticket.created', e]);
    else if (e.type === 'status_changed') {
      out.push(['ticket.moved', e]);
      if (project.statuses.find((s) => s.key === e.to)?.category === 'done') out.push(['ticket.done', e]);
    } else if (e.type === 'assigned') out.push(['ticket.assigned', e]);
    else if (e.type === 'commented') out.push(['ticket.commented', e]);
    else if (e.type === 'updated') out.push(['ticket.updated', e]);
  }
  return out;
}

const statusName = (project, key) => project.statuses.find((s) => s.key === key)?.name ?? key;

async function ticketSummary(project, ticketId) {
  const t = await Ticket.findById(ticketId).populate('assignee', 'name').lean();
  if (!t) return null;
  const key = `${project.key}-${t.number}`;
  return {
    key, number: t.number, title: t.title, type: t.type, priority: t.priority, status: t.status, statusName: statusName(project, t.status),
    assignee: t.assignee?.name ?? null, labels: t.labels ?? [], url: ticketUrl(id(project._id), key),
  };
}

function describe(project, event, e, t) {
  switch (event) {
    case 'ticket.created': return `New ${t.type}, ${t.priority} priority`;
    case 'ticket.moved': return `Moved: ${statusName(project, e.from)} → ${statusName(project, e.to)}`;
    case 'ticket.done': return 'Finished';
    case 'ticket.assigned': return t.assignee ? `Assigned to ${t.assignee}` : 'Unassigned';
    case 'ticket.commented': return `New comment: "${String(e.comment?.body ?? '').replace(/@\[([^\]\n]{1,80})\]\([a-f0-9]{24}\)/g, '@$1').slice(0, 280)}"`;
    case 'ticket.updated': return `Changed ${e.field}`;
    default: return event;
  }
}

const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PRIORITY_COLOR = { critical: 0xdc2626, high: 0xea580c, medium: 0x7c6cf0, low: 0x71717a };

function chatBody(kind, project, text, t) {
  if (kind === 'slack') {
    const line = t ? `*<${t.url}|${slackEscape(`${t.key} ${t.title}`)}>*\n${slackEscape(text)}` : slackEscape(text);
    return { text: t ? `${t.key} ${t.title}: ${text}` : text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: line } }, { type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(project.name) }] }] };
  }
  return {
    // No pings: a ticket title must never be able to @everyone a server.
    allowed_mentions: { parse: [] },
    embeds: [t
      ? { title: `${t.key} ${t.title}`.slice(0, 256), url: t.url, description: text.slice(0, 4000), color: PRIORITY_COLOR[t.priority] ?? 0x7c6cf0, footer: { text: project.name.slice(0, 100) } }
      : { description: text.slice(0, 4000), footer: { text: project.name.slice(0, 100) } }],
  };
}

// ---------- delivery ----------

async function send(url, body, headers) {
  const raw = JSON.stringify(body);
  let last = { ok: false, status: null, error: null };
  const started = Date.now();
  let attempts = 0;
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    attempts += 1;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Tessera-Webhooks', ...headers(raw) }, body: raw, signal: AbortSignal.timeout(5000), redirect: 'manual' });
      last = { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
      // Retry only what might work next time: rate limits and server errors.
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
    } catch (err) {
      last = { ok: false, status: null, error: err.name === 'TimeoutError' ? 'No answer within 5 seconds' : err.message.slice(0, 200) };
    }
  }
  return { ...last, attempts, duration: Date.now() - started };
}

async function record(project, kind, target, event, result) {
  await WebhookDelivery.create({ project: project._id, target: { kind, id: target._id, name: target.name }, event, ...result });
  const field = kind === 'webhook' ? 'webhooks' : 'alerts';
  const failures = result.ok ? 0 : (target.failures ?? 0) + 1;
  // After many failures in a row the target is paused, so a dead endpoint isn't hammered forever.
  await Project.updateOne({ _id: project._id, [`${field}._id`]: target._id }, {
    $set: { [`${field}.$.lastDelivery`]: { at: new Date(), ok: result.ok, status: result.status, error: result.error }, [`${field}.$.failures`]: failures, ...(failures >= MAX_FAILURES && { [`${field}.$.active`]: false }) },
  });
  const old = await WebhookDelivery.find({ 'target.id': target._id }, { _id: 1 }).sort({ at: -1 }).skip(50).lean();
  if (old.length) await WebhookDelivery.deleteMany({ _id: { $in: old.map((d) => d._id) } });
  return result;
}

async function deliverChat(project, alert, event, text, t) {
  const result = await send(open(alert.url), chatBody(alert.kind, project, text, t), () => ({}));
  return record(project, alert.kind, alert, event, result);
}

async function deliverWebhook(project, hook, event, payload) {
  if (config.env === 'production') await checkUrl(hook.url);
  const deliveryId = randomUUID();
  const secret = open(hook.secret);
  const result = await send(hook.url, { id: deliveryId, ...payload }, (raw) => ({
    'x-tessera-event': event, 'x-tessera-delivery': deliveryId,
    'x-tessera-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
  }));
  return record(project, 'webhook', hook, event, result);
}

onTicketEvents(async (project, ticket, internal) => {
  const alerts = (project.alerts ?? []).filter((a) => a.active);
  const hooks = (project.webhooks ?? []).filter((h) => h.active);
  if (!alerts.length && !hooks.length) return;
  const outward = eventsFor(project, internal);
  if (!outward.length) return;
  const t = await ticketSummary(project, ticket._id);
  if (!t) return;
  for (const [event, e] of outward) {
    const text = describe(project, event, e, t);
    for (const a of alerts) {
      if (!a.events.includes(event)) continue;
      if (a.priorities?.length && !a.priorities.includes(t.priority)) continue;
      await deliverChat(project, a, event, text, t);
    }
    for (const h of hooks) {
      if (!h.events.includes(event)) continue;
      const change = { ...e };
      delete change.comment;
      await deliverWebhook(project, h, event, {
        event, at: new Date().toISOString(), project: { id: id(project._id), key: project.key, name: project.name }, ticket: t,
        change: event === 'ticket.commented' ? { comment: { body: e.comment?.body ?? '', visibility: e.comment?.visibility ?? 'internal' } } : change,
      });
    }
  }
});

// ---------- settings (managers) ----------

const urlHint = (url) => `${new URL(url).host}/…${url.slice(-4)}`;
const alertJson = (a) => ({ id: id(a), kind: a.kind, name: a.name, hint: a.hint, events: a.events, priorities: a.priorities ?? [], active: a.active, failures: a.failures ?? 0, lastDelivery: a.lastDelivery ?? null, createdAt: a.createdAt });
const hookJson = (h) => ({ id: id(h), name: h.name, url: h.url, events: h.events, active: h.active, failures: h.failures ?? 0, lastDelivery: h.lastDelivery ?? null, createdAt: h.createdAt });

export async function listIntegrations(project) {
  const recent = await WebhookDelivery.find({ project: project._id }).sort({ at: -1 }).limit(30).lean();
  return {
    events: EVENTS,
    alerts: (project.alerts ?? []).map(alertJson),
    webhooks: (project.webhooks ?? []).map(hookJson),
    deliveries: recent.map((d) => ({ id: id(d), target: { kind: d.target.kind, id: id(d.target.id), name: d.target.name }, event: d.event, ok: d.ok, status: d.status, error: d.error, duration: d.duration, attempts: d.attempts, at: d.at })),
  };
}

export async function addAlert(project, { kind, name, url, events, priorities }) {
  if (kind === 'slack' && !SLACK_URL.test(url)) throw new HttpError(400, 'bad_url', 'Paste a Slack incoming-webhook URL (https://hooks.slack.com/services/...)');
  if (kind === 'discord' && !DISCORD_URL.test(url)) throw new HttpError(400, 'bad_url', 'Paste a Discord webhook URL (https://discord.com/api/webhooks/...)');
  if (project.alerts.length >= 10) throw new HttpError(409, 'too_many', 'At most 10 chat alerts per project');
  project.alerts.push({ kind, name, url: seal(url), hint: urlHint(url), events, priorities, active: true, createdAt: new Date() });
  await project.save();
  return alertJson(project.alerts.at(-1));
}

export async function addWebhook(project, { name, url, events }) {
  const clean = await checkUrl(url);
  if (project.webhooks.length >= 10) throw new HttpError(409, 'too_many', 'At most 10 webhooks per project');
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  project.webhooks.push({ name, url: clean, secret: seal(secret), events, active: true, createdAt: new Date() });
  await project.save();
  // The signing secret is shown this once.
  return { ...hookJson(project.webhooks.at(-1)), secret };
}

function target(project, kind, targetId) {
  const t = (kind === 'webhook' ? project.webhooks : project.alerts).id(targetId);
  if (!t) throw new HttpError(404, 'not_found', kind === 'webhook' ? 'That webhook is not in this project' : 'That alert is not in this project');
  return t;
}

export async function updateTarget(project, kind, targetId, { events, priorities, active, name }) {
  const t = target(project, kind, targetId);
  if (events) t.events = events;
  if (priorities && kind !== 'webhook') t.priorities = priorities;
  if (name) t.name = name;
  if (active !== undefined) { t.active = active; if (active) t.failures = 0; }
  await project.save();
  return kind === 'webhook' ? hookJson(t) : alertJson(t);
}

export async function removeTarget(project, kind, targetId) {
  const t = target(project, kind, targetId);
  t.deleteOne();
  await project.save();
  await WebhookDelivery.deleteMany({ 'target.id': targetId });
}

// "Send a test": goes out now, and the answer says what the other side replied.
export async function sendTest(project, kind, targetId, user) {
  const t = target(project, kind, targetId);
  if (kind === 'webhook') {
    return deliverWebhook(project, t, 'ping', { event: 'ping', at: new Date().toISOString(), project: { id: id(project._id), key: project.key, name: project.name } });
  }
  return deliverChat(project, t, 'test', `Test message from Tessera, sent by ${user.name}. Alerts for ${project.name} will look like this.`, null);
}
