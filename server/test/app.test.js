import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/health answers 503 with the reason when no database is configured', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.service, 'tessera-api');
  assert.ok(!Number.isNaN(Date.parse(body.time)));
  assert.deepEqual(body.database, { configured: false, connected: false, problem: 'MONGODB_URI is not set' });
});

test('GET / describes the service instead of a 404', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).service, 'tessera-api');
});

test('unknown routes answer the standard 404 error shape', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'not_found');
});

test('malformed JSON answers 400 bad_json', async () => {
  const res = await fetch(`${base}/api/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_json');
});

test('security headers are set and x-powered-by is hidden', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('CORS allows the local client origin only', async () => {
  const ok = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5210' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5210');
  const other = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});
