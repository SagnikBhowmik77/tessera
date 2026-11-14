import dns from 'node:dns';
import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { connectDb, markNotConfigured } from './db.js';
import './models/index.js';
import { attachRealtime } from './realtime.js';
import { startReminderSweep } from './services/follow.service.js';
import { startRecurringScheduler } from './services/template.service.js';
import { backfillAllResponses, startSlaChecker } from './services/sla.service.js';
import { startDigestSweep } from './services/digest.service.js';
import { publish } from './realtime.js';

const RETRY_MS = 15_000;

// Some networks hand Node a DNS server that refuses the SRV lookup mongodb+srv:// needs.
if (config.dnsServers.length) dns.setServers(config.dnsServers);

async function connectWithRetry(uri) {
  try {
    await connectDb(uri);
    console.log('Connected to MongoDB');
    // Snoozed tickets come back on time (checked every minute once the database is up).
    startReminderSweep();
    // Held quiet-hour emails and daily / weekly digests (E13).
    startDigestSweep();
    // Tickets from before service levels get their first-response time from their history, once.
    backfillAllResponses().catch((err) => console.error('First-response backfill failed:', err.message))
      .finally(() => startSlaChecker({ onBreach: (b) => publish(b.project, 'ticket', { action: 'updated', actorId: null, number: b.number }) }));
    // Recurring tickets: catches up on runs that fell due while the server was asleep, then checks every 10 minutes.
    startRecurringScheduler({ onCreated: (c) => publish(c.project, 'ticket', { action: 'created', actorId: null, number: c.number }) });
  } catch (err) {
    console.error(`MongoDB connection failed: ${err.message}. Retrying in ${RETRY_MS / 1000} s`);
    setTimeout(() => connectWithRetry(uri), RETRY_MS);
  }
}

// One HTTP server for the REST API and the Socket.IO live connection.
const server = http.createServer(createApp());
attachRealtime(server);
server.listen(config.port, () => {
  console.log(`Tessera API listening on http://localhost:${config.port}`);
});

if (config.mongodb.uri) {
  connectWithRetry(config.mongodb.uri);
} else {
  markNotConfigured(config.mongodb.problem);
  console.warn(`Database not configured: ${config.mongodb.problem}`);
}
