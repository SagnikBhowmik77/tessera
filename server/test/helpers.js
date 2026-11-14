// Shared test harness: a real throwaway MongoDB (never Atlas) plus the app on a random port.
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { attachRealtime, closeRealtime } from '../src/realtime.js';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { User } from '../src/models/index.js';

export async function startTestServer() {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri('tessera-test');
  await connectDb(uri);
  const server = http.createServer(createApp());
  attachRealtime(server);
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // api('POST', '/api/auth/login', { body, token }) -> { status, body, headers }
  const api = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  const stop = async () => {
    await closeRealtime();
    server.close();
    await disconnectDb();
    await mongo.stop();
  };

  // A fresh registered user: { token, user, email, password }.
  let count = 0;
  const signUp = async (name = 'Test User') => {
    count += 1;
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${count}@example.com`;
    const password = 'test-password-1';
    const res = await api('POST', '/api/auth/register', { body: { name, email, password } });
    if (res.status !== 201) throw new Error(`signUp failed: ${JSON.stringify(res.body)}`);
    // Test people have confirmed their email (so notification emails reach them). Tests about
    // verification itself register through the API without this helper.
    await User.updateOne({ _id: res.body.user.id }, { $set: { emailVerifiedAt: new Date() } });
    return { ...res.body, email, password };
  };

  return { base, uri, api, signUp, stop };
}
