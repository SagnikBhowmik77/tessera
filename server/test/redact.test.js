// Secret redaction in pasted errors (unit rules + through the API into the database).
// Fake secrets are assembled at runtime so secret scanners don't flag this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/bugs/redact.js';
import { startTestServer } from './helpers.js';
import { Ticket } from '../src/models/index.js';

const GH = `gh${'p'}_${'A1b2C3d4E5'.repeat(4)}`;
const AWS = `AK${'IA'}${'ABCDEFGHIJ234567'}`;
const JWT = `ey${'J'}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
const STRIPE = `sk_${'live'}_${'4eC39HqLyjWDarjtT1zdp7dc'}`;

const kinds = (removed) => Object.fromEntries(removed.map((r) => [r.kind, r.count]));

test('known token formats are replaced and counted by kind', () => {
  const { text, removed } = redactSecrets(`Error: GitHub said 401 for ${GH}\naws ${AWS}\nstripe ${STRIPE}`);
  for (const s of [GH, AWS, STRIPE]) assert.ok(!text.includes(s), `leaked ${s.slice(0, 6)}`);
  assert.deepEqual(kinds(removed), { 'GitHub token': 1, 'AWS access key': 1, 'Stripe key': 1 });
  assert.match(text, /\[redacted: GitHub token\]/);
});

test('auth headers, JWTs, URL secrets, key=value secrets and private keys', () => {
  const input = [
    `Authorization: Bearer ${'abcdefABCDEF0123456789'}`,
    `cookie jwt=${JWT}`,
    'GET https://api.example.com/v1/orders?id=7&access_token=zzz111yyy222&page=2',
    'DB_PASSWORD=hunter2hunter2',
    '{"apiKey": "k-0987654321", "name": "shop"}',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const { text } = redactSecrets(input);
  for (const leaked of ['abcdefABCDEF0123456789', JWT, 'zzz111yyy222', 'hunter2hunter2', 'k-0987654321', 'MIIEow']) {
    assert.ok(!text.includes(leaked), `leaked ${leaked.slice(0, 8)}`);
  }
  // What isn't secret stays readable.
  assert.match(text, /id=7&access_token=\[redacted: secret\]&page=2/);
  assert.match(text, /"name": "shop"/);
  assert.match(text, /DB_PASSWORD=\[redacted: secret\]/);
});

test('connection strings keep the user and host, lose the password; emails are removed', () => {
  const { text, removed } = redactSecrets('MongoServerError: auth failed for mongodb+srv://shopuser:S3cr3tPass@cluster0.ab1cd.mongodb.net/shop (asha.rao@company.co.in)');
  assert.match(text, /mongodb\+srv:\/\/shopuser:\[redacted: password\]@cluster0\.ab1cd\.mongodb\.net\/shop/);
  assert.ok(!text.includes('S3cr3tPass'));
  assert.ok(!text.includes('asha.rao@company.co.in'));
  assert.deepEqual(kinds(removed), { 'password in URL': 1, email: 1 });
});

test('ordinary stack traces are left exactly as they are', () => {
  const trace = `TypeError: Cannot read properties of undefined (reading 'token')
    at getToken (/app/src/auth/token.js:12:5)
    at Object.<anonymous> (/app/node_modules/@babel/core/lib/index.js:4:1)
    at https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.production.min.js:1:200
Traceback (most recent call last):
  File "/srv/app/session.py", line 40, in refresh_token
KeyError: 'password'`;
  const { text, removed } = redactSecrets(trace);
  assert.equal(text, trace);
  assert.deepEqual(removed, []);
});

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.stop(); });

test('a pasted trace with secrets is saved without them, and the preview says what was removed', async () => {
  const admin = await t.signUp('Admin');
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Redact', key: 'RED' } });
  const url = `/api/projects/${body.project.id}/tickets`;
  const trace = `Error: Request failed with status 401 (token ${GH})
    at fetchOrders (/app/src/api.js:22:11)
    at main (/app/src/index.js:5:3)
Contact: ops.lead@shop.example.org`;

  const preview = await t.api('POST', `${url}/parse-error`, { token: admin.token, body: { text: trace } });
  assert.equal(preview.status, 200);
  assert.deepEqual(kinds(preview.body.redacted), { 'GitHub token': 1, email: 1 });
  assert.ok(!JSON.stringify(preview.body).includes(GH));

  const created = await t.api('POST', url, { token: admin.token, body: { errorText: trace } });
  assert.equal(created.status, 201);
  const saved = await Ticket.findById(created.body.ticket.id).lean();
  const stored = JSON.stringify(saved);
  assert.ok(!stored.includes(GH), 'token reached the database');
  assert.ok(!stored.includes('ops.lead@shop.example.org'), 'email reached the database');
  assert.match(saved.description, /\[redacted: GitHub token\]/);
  assert.equal(saved.error.frames[0].file, '/app/src/api.js');
});
