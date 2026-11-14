// The public portal's optional Cloudflare Turnstile check and its rate limit.
// Turnstile's verify endpoint is replaced by a local stand-in, so nothing leaves this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let stub;
const seen = [];
before(async () => {
  // Accepts the token "human", refuses anything else (like Cloudflare's siteverify).
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      seen.push(Object.fromEntries(form));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: form.get('response') === 'human' && form.get('secret') === 'test-turnstile-secret' }));
    });
  }).listen(0);
  await new Promise((r) => stub.once('listening', r));
  process.env.TURNSTILE_SITE_KEY = '0x-test-site-key';
  process.env.TURNSTILE_SECRET = 'test-turnstile-secret';
  process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${stub.address().port}/siteverify`;
  process.env.PORTAL_RATE_LIMIT = '3';
});
after(() => stub.close());

test('with Turnstile on, reports need a passing check; the rate limit stops floods', async () => {
  const { startTestServer } = await import('./helpers.js');
  const t = await startTestServer();
  try {
    const admin = await t.signUp('Admin');
    const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Guarded', key: 'GRD' } });
    const settings = await t.api('PUT', `/api/projects/${body.project.id}/portal`, { token: admin.token, body: { enabled: true } });
    assert.equal(settings.body.portal.turnstile, true);
    const token = settings.body.portal.url.split('/report/')[1];
    assert.equal((await t.api('GET', `/api/portal/${token}`)).body.turnstileSiteKey, '0x-test-site-key');

    const send = (extra) => t.api('POST', `/api/portal/${token}/reports`, { body: { title: 'Checkout broken', ...extra } });
    assert.equal((await send({})).body.error.code, 'captcha_required');
    assert.equal((await send({ turnstileToken: 'robot' })).body.error.code, 'captcha_failed');
    const ok = await send({ turnstileToken: 'human' });
    assert.equal(ok.status, 201);
    assert.equal(seen.at(-1).secret, 'test-turnstile-secret', 'the secret is sent to the verifier, never to the browser');

    const limited = await send({ turnstileToken: 'human' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
  } finally {
    await t.stop();
  }
});
