// The report button for a team's own websites (E6C): settings, origin check, what is sent and stored
// (throwaway MongoDB; emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { Attachment, Ticket } from '../src/models/index.js';

let t;
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail() { return {}; } });
});
after(async () => { __setTransport(null); await t.stop(); });

// A real 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let n = 0;
async function setup({ widget = true } = {}) {
  const admin = await t.signUp('Admin');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `WG${n}` } });
  const base = `/api/projects/${body.project.id}`;
  const portal = (await t.api('PUT', `${base}/portal`, { token: admin.token, body: { enabled: true, ...(widget && { widget: { enabled: true, origins: ['https://Shop.example.com/'] } }) } })).body.portal;
  return { admin, base, project: body.project, portal, token: portal.url.split('/report/')[1] };
}
const send = (token, body, origin = 'https://shop.example.com') => fetch(`${t.base}/api/widget/${token}`, {
  method: 'POST', headers: { 'content-type': 'text/plain', 'user-agent': CHROME, ...(origin && { origin }) }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('settings: the button needs the portal on and a list of websites', async () => {
  const { admin, base, portal } = await setup({ widget: false });
  assert.deepEqual([portal.widget.enabled, portal.widget.origins, portal.widget.scriptUrl], [false, [], 'http://localhost:8740/sdk/widget.js']);
  const none = await t.api('PUT', `${base}/portal`, { token: admin.token, body: { widget: { enabled: true } } });
  assert.deepEqual([none.status, none.body.error.code], [400, 'origins_required']);
  assert.equal((await t.api('PUT', `${base}/portal`, { token: admin.token, body: { widget: { enabled: true, origins: ['shop.example.com'] } } })).status, 400);
  const on = await t.api('PUT', `${base}/portal`, { token: admin.token, body: { widget: { enabled: true, origins: ['https://shop.example.com/'] } } });
  assert.deepEqual([on.body.portal.widget.enabled, on.body.portal.widget.origins], [true, ['https://shop.example.com']]);
  const script = await fetch(`${t.base}/sdk/widget.js`);
  assert.deepEqual([script.status, script.headers.get('cross-origin-resource-policy')], [200, 'cross-origin']);
  assert.match(await script.text(), /data-portal/);
});

test('a report from the button: page, browser, screenshot and (with consent) console errors', async () => {
  const { token, project } = await setup();
  const pre = await fetch(`${t.base}/api/widget/${token}`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const res = await send(token, {
    title: 'Pay button does nothing', description: 'Clicked it twice.', email: 'ana@example.org',
    page: { url: 'https://shop.example.com/checkout?session=secret#pay', title: 'Checkout', viewport: '1280x720' },
    consoleErrors: [{ message: "TypeError: Cannot read properties of undefined (reading 'total')", stack: "TypeError: Cannot read properties of undefined (reading 'total')\n    at pay (https://shop.example.com/assets/app.4f9a2c1e.js:1:200)" }],
    screenshot: PNG,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual([res.body.reference, res.body.screenshot, res.body.willEmail], [`${project.key}-1`, true, true]);
  const ticket = await Ticket.findOne({ project: project.id }).lean();
  assert.deepEqual([ticket.triage, ticket.source, ticket.labels, ticket.contact.email], [true, 'portal', ['widget'], 'ana@example.org']);
  assert.equal(ticket.title, 'Pay button does nothing');
  assert.match(ticket.description, /\*\*Page:\*\* https:\/\/shop\.example\.com\/checkout \(Checkout\)/);
  assert.equal(ticket.description.includes('secret'), false, 'the query string is never stored');
  assert.match(ticket.description, /\*\*Browser:\*\* Chrome 130 on Windows/);
  assert.match(ticket.description, /\*\*Window:\*\* 1280x720/);
  assert.equal(ticket.error.frames[0].fn, 'pay', 'the shared console error is parsed like a crash');
  const files = await Attachment.find({ ticket: ticket._id }).lean();
  assert.deepEqual(files.map((f) => [f.name, f.contentType]), [['screenshot.png', 'image/png']]);

  // Without consent nothing from the console is sent, so nothing about it is stored.
  await send(token, { title: 'Second report', page: { url: 'https://shop.example.com/' } });
  const second = await Ticket.findOne({ project: project.id, number: 2 }).lean();
  assert.equal(second.error, null);
  assert.equal(second.description.includes('Console'), false);
});

test('refused: other websites, button off, bad pictures, the bot trap', async () => {
  const { admin, base, token } = await setup();
  assert.equal((await send(token, { title: 'Hello there' }, 'https://evil.example')).status, 403);
  assert.equal((await send(token, { title: 'Hello there' }, null)).status, 403);
  assert.equal((await send(token, { title: 'Hello there', screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' })).body.error.code, 'bad_screenshot');
  assert.equal((await send(token, { title: 'Hello there', screenshot: 'data:image/png;base64,aGVsbG8=' })).status, 415, 'not really a PNG');
  assert.equal((await send(token, { title: 'Hi' })).status, 400);
  assert.equal((await send(token, { title: 'Hello there', website: 'http://spam' })).body.error.code, 'rejected');
  await t.api('PUT', `${base}/portal`, { token: admin.token, body: { widget: { enabled: false } } });
  assert.equal((await send(token, { title: 'Hello there' })).status, 404);
  assert.equal((await send('x'.repeat(30), { title: 'Hello there' })).status, 404);
});
