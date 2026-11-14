import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Project } from '../models/index.js';
import { createTicket } from './ticket.service.js';
import { notify } from './notification.service.js';

// Crash capture (E6A): apps send their own errors to a project with an ingest key, through the
// tessera.js SDK or a plain POST. An ingest key can only send crashes into one project: it can't
// read anything, so it is fine inside a web page (like any error-tracker key). Keys are stored
// hashed, shown once, can be limited to the web origins allowed to use them, and can be revoked.

export const KEY_PREFIX = 'tsk_';
// Source map upload tokens (E6B) are kept the same way, but are secrets for CI, not for web pages.
export const KIND_PREFIX = { ingest: 'tsk_', upload: 'tsu_', deploy: 'tsd_' };
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export const sdkUrl = () => `${config.apiUrl}/sdk/tessera.js`;
export const ingestUrl = () => `${config.apiUrl}/api/ingest`;

const keyJson = (k) => ({
  id: String(k._id), name: k.name, prefix: k.prefix, origins: k.origins ?? [],
  createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null, revokedAt: k.revokedAt ?? null, received: k.received ?? 0, kind: k.kind ?? 'ingest',
});

export function listKeys(project) {
  return { keys: (project.ingestKeys ?? []).map(keyJson).reverse(), sdkUrl: sdkUrl(), endpoint: ingestUrl() };
}

// Web origins like https://shop.example.com (scheme + host + optional port, nothing else).
export const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

export async function createKey(project, actor, { name, origins = [], kind = 'ingest' }) {
  if ((project.ingestKeys ?? []).filter((k) => !k.revokedAt).length >= 10) {
    throw new HttpError(400, 'too_many_keys', 'A project can have at most 10 active ingest keys. Revoke one first.');
  }
  const key = `${KIND_PREFIX[kind]}${randomBytes(24).toString('base64url')}`;
  project.ingestKeys.push({
    name: name.trim(), prefix: key.slice(0, 12), keyHash: hashKey(key),
    origins: [...new Set(origins.map((o) => o.trim().replace(/\/+$/, '').toLowerCase()))],
    createdBy: actor, createdAt: new Date(), kind,
  });
  // Upload tokens are for CI, which has no website.
  if (kind !== 'ingest') project.ingestKeys.at(-1).origins = [];
  await project.save();
  // The only time the whole key is ever shown.
  return { key, ingestKey: keyJson(project.ingestKeys.at(-1)), sdkUrl: sdkUrl(), endpoint: ingestUrl() };
}

export async function revokeKey(project, keyId) {
  const k = project.ingestKeys?.id(keyId);
  if (!k) throw new HttpError(404, 'key_not_found', 'That ingest key is not in this project');
  if (!k.revokedAt) {
    k.revokedAt = new Date();
    await project.save();
  }
  return keyJson(k);
}

// What an app may send. Everything is optional except a message or a stack.
export const crashSchema = z.object({
  key: z.string().max(100),
  type: z.string().trim().max(200).optional(),
  message: z.string().max(2000).optional(),
  stack: z.string().max(20_000).optional(),
  url: z.string().max(2000).optional(),
  release: z.string().trim().max(100).optional(),
  environment: z.string().trim().max(50).optional(),
  // The app's own id for the person, only used (hashed) to count distinct people.
  user: z.string().max(200).optional(),
}).refine((b) => b.message?.trim() || b.stack?.trim(), { message: 'Send a message or a stack' });

// Only the page's address without its query string or fragment, which often hold tokens.
function pageOf(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? `${u.origin}${u.pathname}`.slice(0, 500) : null;
  } catch { return null; }
}

// The error as text the trace parser reads: a V8 stack already starts with "Type: message";
// Firefox and Safari stacks are frames only, so the error line is put first.
export function errorTextOf({ type, message, stack }) {
  const head = [type, message].filter((x) => x?.trim()).join(': ');
  const s = stack?.trim() ?? '';
  if (!s) return head;
  return head && !s.includes(message?.trim() || head) ? `${head}\n${s}` : s;
}

export async function findByKey(key, kind = 'ingest') {
  const what = { upload: 'upload token', deploy: 'deploy token' }[kind] ?? 'ingest key';
  if (typeof key !== 'string' || !key.startsWith(KIND_PREFIX[kind])) throw new HttpError(401, 'bad_key', `Unknown or revoked ${what}`);
  const keyHash = hashKey(key);
  const project = await Project.findOne({ 'ingestKeys.keyHash': keyHash });
  const k = project?.ingestKeys.find((x) => x.keyHash === keyHash);
  if (!project || !k || k.revokedAt || (k.kind ?? 'ingest') !== kind) throw new HttpError(401, 'bad_key', `Unknown or revoked ${what}`);
  return { project, k };
}

export async function ingest(body, { origin, userAgent }) {
  const parsed = crashSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'bad_crash', parsed.error.issues[0]?.message ?? 'Not a crash report');
  const crash = parsed.data;
  const { project, k } = await findByKey(crash.key);
  // A key limited to some websites only accepts reports sent from those pages.
  if (k.origins?.length && !k.origins.includes(String(origin ?? '').toLowerCase())) {
    throw new HttpError(403, 'origin_not_allowed', 'This ingest key is not allowed on this website');
  }
  if (project.archivedAt) return { received: false, ignored: 'project_archived' };

  const at = new Date();
  const user = crash.user?.trim();
  const occurrence = {
    release: crash.release || null,
    appEnvironment: crash.environment || null,
    page: crash.url ? pageOf(crash.url) : null,
    who: user ? `sdk:${createHash('sha256').update(`${project._id}:${user}`).digest('hex').slice(0, 32)}` : null,
  };
  const { ticket, grouped } = await createTicket(project, null, { errorText: errorTextOf(crash), userAgent }, { source: 'sdk', triage: true, quiet: true, occurrence });

  // Counted on the key, and its last use (at most once a minute, to spare writes).
  const update = { $inc: { 'ingestKeys.$.received': 1 } };
  if (!k.lastUsedAt || +at - +k.lastUsedAt > 60_000) update.$set = { 'ingestKeys.$.lastUsedAt': at };
  await Project.updateOne({ _id: project._id, 'ingestKeys._id': k._id }, update);

  // A crash never seen before lands in the triage inbox; the managers hear about it.
  if (!grouped) {
    const leads = project.members.filter((m) => m.role === 'admin' || m.role === 'manager').map((m) => m.user);
    await notify(leads.map((u) => ({
      user: u, project: project._id, ticket: ticket.id, actor: null, type: 'crash_new',
      ticketKey: ticket.key, ticketTitle: ticket.title, excerpt: occurrence.release ? `release ${occurrence.release}` : null,
    })));
  }
  return { received: true, projectId: String(project._id), ticket, grouped };
}
