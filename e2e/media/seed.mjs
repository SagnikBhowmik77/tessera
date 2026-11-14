// The demo project the README's recordings and screenshots are made in: the real Tessera API on a
// throwaway in-memory database (it never touches Atlas or any real data), filled through the API
// with a made-up shop team and nine weeks of history so the charts have something to draw.
// Everything is created through the real endpoints; afterwards only the timestamps are moved back
// in time, so the analytics recompute from genuine events.
//
//   node media/seed.mjs [port]        (default 8740; stop with Ctrl+C)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

const SERVER = fileURLToPath(new URL('../../server/', import.meta.url));
const url = (p) => pathToFileURL(SERVER + p).href;
await import(url('test/setup.js'));
const req = createRequire(SERVER + 'package.json');
const { MongoMemoryServer } = await import(pathToFileURL(req.resolve('mongodb-memory-server')).href);
const { createApp } = await import(url('src/app.js'));
const { attachRealtime } = await import(url('src/realtime.js'));
const { connectDb } = await import(url('src/db.js'));
const { Ticket, TicketEvent, Project } = await import(url('src/models/index.js'));
const { Types } = (await import(pathToFileURL(req.resolve('mongoose')).href)).default;

const port = Number(process.argv[2]) || 8740;
const mongo = await MongoMemoryServer.create();
await connectDb(mongo.getUri('tessera-demo'));
const server = http.createServer(createApp());
attachRealtime(server);
await new Promise((r) => server.listen(port, r));

const API = `http://localhost:${port}/api`;
async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// The demo accounts (made up; the passwords only open this throwaway database). record.mjs signs in with them.
const owner = await call('POST', '/auth/register', { name: 'Ananya Chatterjee', email: 'seed.owner@example.com', password: 'seed-pass-1234-xyz' });
const mate = await call('POST', '/auth/register', { name: 'Ravi Iyer', email: 'seed.mate@example.com', password: 'seed-pass-1234-abc' });
const p = (await call('POST', '/projects', { name: 'Orbit Checkout', key: 'ORB' }, owner.token)).project;
const base = `/projects/${p.id}`;
const inv = await call('POST', `${base}/invites`, { email: 'seed.mate@example.com', role: 'developer' }, owner.token);
await call('POST', `/invites/${new URL(inv.acceptUrl).pathname.split('/').pop()}/accept`, {}, mate.token);
const put = await call('PUT', `${base}/statuses`, { statuses: [
  { key: 'todo', name: 'To Do', category: 'todo' },
  { key: 'in_progress', name: 'In Progress', category: 'in_progress' },
  { name: 'In Review', category: 'in_progress' },
  { key: 'done', name: 'Done', category: 'done' },
] }, owner.token);
const REVIEW = (put.statuses ?? put.project?.statuses).find((x) => x.name === 'In Review').key;
await call('PUT', `${base}/sla`, { enabled: true, targets: [
  { priority: 'critical', responseHours: 4, resolveHours: 48 },
  { priority: 'high', responseHours: 8, resolveHours: 120 },
  { priority: 'medium', responseHours: 24, resolveHours: 240 },
] }, owner.token);
// The public bug-report page, so the outside-in recording has somewhere to report to.
const portal = (await call('PUT', `${base}/portal`, { enabled: true }, owner.token)).portal;

const TITLES = [
  ['Checkout button does nothing on Safari 17', 'bug', 'critical'], ['Add Apple Pay to the payment step', 'feature', 'high'],
  ['Coupon field rejects lowercase codes', 'bug', 'medium'], ['Search results page loads slowly', 'bug', 'high'],
  ['Saved cards list shows expired cards', 'bug', 'medium'], ['Address autocomplete for India PIN codes', 'feature', 'medium'],
  ['Split shipping and billing forms', 'task', 'low'], ['Order summary misaligned at 360px', 'bug', 'low'],
  ['Retry failed UPI payments once', 'feature', 'high'], ['Move tax rules to config', 'task', 'medium'],
  ['Gift card balance shows NaN', 'bug', 'critical'], ['Track checkout drop-off by step', 'task', 'medium'],
  ['Remember last used payment method', 'feature', 'medium'], ['Cart badge count lags behind', 'bug', 'low'],
  ['Upgrade the payments SDK to v5', 'task', 'high'], ['Show delivery date before payment', 'feature', 'high'],
  ['Wallet top-up double charges on refresh', 'bug', 'critical'], ['Write runbook for payment outages', 'task', 'low'],
  ['COD limit message is unclear', 'bug', 'medium'], ['Add invoice download to orders', 'feature', 'medium'],
  ['Flaky test: payment webhook ordering', 'task', 'medium'], ['Promo banner covers the pay button', 'bug', 'high'],
  ['EMI options for cards over ₹10,000', 'feature', 'medium'], ['Clean up unused checkout flags', 'task', 'low'],
  ['Price rounding differs from invoice', 'bug', 'high'], ['Express checkout for returning buyers', 'feature', 'high'],
  ['Log payment gateway latency', 'task', 'medium'], ['Pincode check fails for new areas', 'bug', 'medium'],
  ['Add Hindi strings to checkout', 'task', 'medium'], ['Guest checkout email typo hint', 'feature', 'low'],
  ['Refund status page is blank', 'bug', 'high'], ['Archive old order exports', 'task', 'low'],
  ['3-D Secure popup blocked on Firefox', 'bug', 'critical'], ['Order notes field', 'feature', 'low'],
  ['Reduce checkout bundle size', 'task', 'medium'], ['Duplicate order on double tap', 'bug', 'high'],
];
// Deterministic "random", so every run draws the same history.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const PATHS = [['in_progress', REVIEW, 'done'], ['in_progress', 'done'], ['in_progress', REVIEW, 'done'], ['in_progress', REVIEW], ['in_progress'], []];
const people = [owner.user.id, mate.user.id, null];
for (const [i, [title, type, priority]] of TITLES.entries()) {
  const { ticket } = await call('POST', `${base}/tickets`, { title, type, priority, ...(people[i % 3] && { assigneeId: people[i % 3] }) }, owner.token);
  const path = i > 30 ? [] : PATHS[Math.floor(rnd() * PATHS.length)];
  for (const status of path) await call('POST', `${base}/tickets/${ticket.number}/move`, { status }, i % 2 ? mate.token : owner.token);
  if (i % 5 === 0) await call('POST', `${base}/tickets/${ticket.number}/comments`, { body: 'Looking at this now.' }, mate.token);
}

// A WIP limit, set after the moves (it would refuse them, as it should).
await call('PUT', `${base}/statuses`, { statuses: (await call('GET', base, null, owner.token)).project.statuses.map(({ key, name, category }) => ({ key, name, category, ...(key === 'in_progress' && { wipLimit: 3 }) })) }, owner.token);

// Move every ticket's history back: created 3 to 62 days ago, each later event a while after.
const DAY = 86_400_000; const now = Date.now();
const all = await Ticket.find({ project: new Types.ObjectId(p.id) }).lean();
for (const t of all) {
  const i = t.number - 1;
  const created = now - (62 - i * 1.65) * DAY - rnd() * 6 * 3_600_000;
  const events = await TicketEvent.find({ ticket: t._id }).sort({ at: 1, _id: 1 }).lean();
  let at = created; let resolvedAt = null;
  for (const [k, e] of events.entries()) {
    if (k > 0) at = Math.min(now - 3_600_000, at + (e.type === 'status_changed' ? (0.3 + rnd() * 3.2) * DAY : 5 * 60_000));
    await TicketEvent.collection.updateOne({ _id: e._id }, { $set: { at: new Date(at) } });
    if (e.type === 'status_changed' && e.to === 'done') resolvedAt = at;
  }
  await Ticket.collection.updateOne({ _id: t._id }, { $set: { createdAt: new Date(created), updatedAt: new Date(at), ...(resolvedAt && { resolvedAt: new Date(resolvedAt) }) } });
}
await Project.collection.updateOne({ _id: new Types.ObjectId(p.id) }, { $set: { createdAt: new Date(now - 64 * DAY) } });

console.log(`SEEDED http://localhost:${port} project=${p.id} tickets=${all.length} portal=${new URL(portal.url).pathname}`);
const stop = async () => { server.close(); await mongo.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
