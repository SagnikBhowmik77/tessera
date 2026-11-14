// The production mail path: Render's free tier blocks SMTP, so the API signs each email and posts it
// to the relay on Vercel (client/api/send-mail.js), which sends it. Here the real relay runs on a
// local HTTP server with nodemailer's JSON transport in place of Gmail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import nodemailer from 'nodemailer';
import { config } from '../src/config.js';
import { relaySignature, sendMail } from '../src/mailer.js';
import { relay, sign } from '../../client/api/send-mail.js';

const SECRET = 'relay-secret-for-tests-only-0123456789';
const ENV = { MAIL_RELAY_SECRET: SECRET, SMTP_HOST: 'smtp.test', SMTP_USER: 'team@tessera.test', SMTP_PASS: 'x' };
const sent = [];
const capture = nodemailer.createTransport({ jsonTransport: true });
const original = capture.sendMail.bind(capture);
capture.sendMail = async (m) => { const info = await original(m); sent.push(JSON.parse(info.message)); return info; };

let server;
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const out = await relay({ method: req.method, headers: req.headers, raw }, { env: ENV, transport: capture });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, r));
  config.mailRelay.url = `http://127.0.0.1:${server.address().port}/api/send-mail`;
  config.mailRelay.secret = SECRET;
});
after(() => {
  config.mailRelay.url = '';
  config.mailRelay.secret = '';
  server.close();
});

test('the API and the relay sign the same way', () => {
  assert.equal(relaySignature(SECRET, 1700000000000, '{"a":1}'), sign(SECRET, 1700000000000, '{"a":1}'));
});

test('an email goes through the relay and is sent from the relay\'s own address', async () => {
  const result = await sendMail({ to: 'asha@example.com', subject: 'You were mentioned on ORB-12', text: 'Hello', html: '<p>Hello</p>' });
  assert.deepEqual(result, { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'You were mentioned on ORB-12');
  assert.deepEqual(sent[0].to.map((t) => t.address), ['asha@example.com']);
  assert.equal(sent[0].from.address, 'team@tessera.test');
});

test('a wrong secret is refused, and sendMail reports it without throwing', async () => {
  config.mailRelay.secret = 'not-the-relay-secret-0000000000000000';
  try {
    const result = await sendMail({ to: 'asha@example.com', subject: 'Hi', text: 'Hi' });
    assert.deepEqual(result, { sent: false, reason: 'send_failed' });
  } finally {
    config.mailRelay.secret = SECRET;
  }
  assert.equal(sent.length, 1, 'nothing more was sent');
});

test('old requests, odd recipients and a relay without its settings are refused', async () => {
  const body = JSON.stringify({ to: 'asha@example.com', subject: 'Hi', text: 'Hi' });
  const old = Date.now() - 6 * 60_000;
  const stale = await relay({ method: 'POST', headers: { 'x-tessera-timestamp': String(old), 'x-tessera-signature': sign(SECRET, old, body) }, raw: body }, { env: ENV, transport: capture });
  assert.equal(stale.status, 401);
  const now = Date.now();
  const many = JSON.stringify({ to: ['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io', 'e@x.io', 'f@x.io'], subject: 'Hi', text: 'Hi' });
  const tooMany = await relay({ method: 'POST', headers: { 'x-tessera-timestamp': String(now), 'x-tessera-signature': sign(SECRET, now, many) }, raw: many }, { env: ENV, transport: capture });
  assert.equal(tooMany.status, 400);
  const bare = await relay({ method: 'POST', headers: {}, raw: body }, { env: {}, transport: capture });
  assert.equal(bare.status, 503);
  const health = await relay({ method: 'GET', headers: {}, raw: '' }, { env: ENV });
  assert.deepEqual(health.body, { ok: true, configured: true });
});
