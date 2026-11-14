// Socket.IO load test (E15): how fast a change reaches everyone watching a board.
//
//   npm run loadtest -- --clients 200 --updates 40
//
// Starts the real API on a throwaway in-memory MongoDB (never Atlas), signs up --clients people,
// puts them in one project, connects each with Socket.IO and joins the board's live room. Then one
// person changes a ticket --updates times through the REST API, and every client times how long
// each change took to reach it: from sending the request to receiving the event.
// The clients run in the same Node process as the server, so the numbers include their own work
// too; they are an honest upper bound for this machine, not a production benchmark.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { io } from 'socket.io-client';
import { startTestServer } from '../test/helpers.js';
import { Project } from '../src/models/index.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const CLIENTS = arg('clients', 100);
const UPDATES = arg('updates', 30);
const GAP_MS = arg('gap', 100);
const BATCH = arg('batch', 50);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;

const t = await startTestServer();
const loop = monitorEventLoopDelay({ resolution: 10 });
const sockets = [];
try {
  console.log(`Signing up ${CLIENTS} people…`);
  const owner = await t.signUp('Owner');
  const { body } = await t.api('POST', '/api/projects', { token: owner.token, body: { name: 'Load', key: 'LOAD' } });
  const projectId = body.project.id;
  const people = [];
  for (let i = 0; i < CLIENTS; i += 1) people.push(await t.signUp(`Watcher ${i + 1}`));
  await Project.updateOne({ _id: projectId }, { $push: { members: { $each: people.map((p) => ({ user: p.user.id, role: 'viewer' })) } } });
  await t.api('POST', `/api/projects/${projectId}/tickets`, { token: owner.token, body: { title: 'Load test ticket' } });

  console.log(`Connecting ${CLIENTS} sockets…`);
  const connectStart = performance.now();
  const sent = new Map(); // title -> time the request was sent
  const latencies = [];
  let received = 0;
  const connect = (p) => new Promise((resolve, reject) => {
    const s = io(t.base, { auth: { token: p.token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(s);
    s.on('connect_error', reject);
    s.on('connect', () => s.emit('project:join', projectId, (ack) => (ack?.ok ? resolve() : reject(new Error(ack?.error ?? 'join failed')))));
    s.on('ticket', (payload) => {
      const at = sent.get(payload?.ticket?.title);
      if (at === undefined) return;
      received += 1;
      latencies.push(performance.now() - at);
    });
  });
  // In batches: hundreds of connections in the same instant overflow the OS listen queue (Windows
  // especially), which says nothing about Socket.IO; real users don't arrive in the same millisecond.
  for (let i = 0; i < people.length; i += BATCH) await Promise.all(people.slice(i, i + BATCH).map(connect));
  const connectMs = performance.now() - connectStart;

  console.log(`Sending ${UPDATES} updates, ${GAP_MS} ms apart…`);
  loop.enable();
  const before = process.memoryUsage();
  const apiTimes = [];
  for (let i = 0; i < UPDATES; i += 1) {
    const title = `Load test update ${i + 1}`;
    const start = performance.now();
    sent.set(title, start);
    const res = await t.api('PATCH', `/api/projects/${projectId}/tickets/1`, { token: owner.token, body: { title } });
    if (res.status !== 200) throw new Error(`update ${i + 1} failed: ${res.status}`);
    apiTimes.push(performance.now() - start);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  await new Promise((r) => setTimeout(r, 1500));
  loop.disable();
  const after = process.memoryUsage();

  const sorted = latencies.sort((a, b) => a - b);
  const apiSorted = apiTimes.sort((a, b) => a - b);
  const expected = CLIENTS * UPDATES;
  const result = {
    clients: CLIENTS, updates: UPDATES,
    connectAll: `${Math.round(connectMs)} ms`,
    delivered: `${received} of ${expected} (${((received / expected) * 100).toFixed(2)}%)`,
    fanOutLatencyMs: { p50: +pct(sorted, 50).toFixed(1), p95: +pct(sorted, 95).toFixed(1), p99: +pct(sorted, 99).toFixed(1), max: +sorted.at(-1).toFixed(1) },
    apiRequestMs: { p50: +pct(apiSorted, 50).toFixed(1), p95: +pct(apiSorted, 95).toFixed(1) },
    eventLoopDelayMs: { p50: +(loop.percentile(50) / 1e6).toFixed(1), p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1) },
    memory: { rssBefore: mb(before.rss), rssAfter: mb(after.rss), heapUsedAfter: mb(after.heapUsed) },
    node: process.version,
  };
  console.log(JSON.stringify(result, null, 2));
  if (received < expected) process.exitCode = 1;
} finally {
  for (const s of sockets) s.close();
  await t.stop();
}
