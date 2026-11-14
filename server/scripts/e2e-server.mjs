// The API for the browser tests (E15): the real app and Socket.IO on a throwaway in-memory MongoDB
// (never Atlas), on PORT (default 8741). Started by e2e/playwright.config.js; stops with it.
//   node --import ./test/setup.js scripts/e2e-server.mjs
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { attachRealtime } from '../src/realtime.js';
import { connectDb } from '../src/db.js';

// The port can also be given as an argument (npm run e2e:api -- 8740 serves where the dev client looks).
const port = Number(process.argv[2] ?? process.env.PORT) || 8741;
const mongo = await MongoMemoryServer.create();
await connectDb(mongo.getUri('tessera-e2e'));
const server = http.createServer(createApp());
attachRealtime(server);
server.listen(port, () => console.log(`E2E API on http://localhost:${port} (in-memory database)`));
const stop = async () => { server.close(); await mongo.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
