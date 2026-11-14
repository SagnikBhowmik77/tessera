// Debug files (E12): the log viewer, HAR files cleaned before storage and analysed, and CI test
// results with flaky-test detection (throwaway MongoDB). Fake secrets are built at runtime so
// secret scanners don't flag this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseLog } from '../src/debug/logparse.js';
import { parseJUnit, JUnitError } from '../src/debug/junit.js';
import { analyzeHar, sanitizeHar, HarError } from '../src/debug/har.js';
import { Attachment, Project, TestRun } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const SESSION = `sess_${'9f8e7d6c5b4a'.repeat(2)}`;
const BEARER = `ey${'J'}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
const PASSWORD = `pw-${'hunter'}2-${'x'.repeat(6)}`;

let n = 0;
async function setup() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  const viewer = await t.signUp('Viewer');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Debug', key: `DB${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  const base = `/api/projects/${body.project.id}`;
  await t.api('POST', `${base}/tickets`, { token: admin.token, body: { title: 'Checkout fails' } });
  return { admin, dev, viewer, project: body.project, base };
}

async function post(url, token, fields, file, name) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file !== undefined) form.append('file', new Blob([file]), name);
  const res = await fetch(t.base + url, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------- parsers ----------

test('log parser: levels from words and JSON lines, stacks stay with their error', () => {
  const log = [
    '2026-11-10 09:00:00,120 INFO  server started on :8080',
    '2026-11-10 09:00:05 WARN  slow query took 2300ms',
    '2026-11-10T09:00:07Z ERROR TypeError: Cannot read properties of undefined (reading \'total\')',
    '    at calculateTotal (cart.js:41:12)',
    '    at checkout (cart.js:88:5)',
    '{"level":50,"time":1794301210000,"msg":"payment failed","err":{"stack":"Error: declined\\n    at pay (pay.js:3:9)"}}',
    '{"level":"debug","timestamp":"2026-11-10T09:00:11Z","message":"retrying"}',
    'plain line with no level',
  ].join('\n');
  const { lines, counts, from, to } = parseLog(log);
  assert.deepEqual(lines.map((l) => l.level), ['info', 'warn', 'error', 'error', 'error', 'error', 'debug', null]);
  assert.deepEqual([lines[3].continuation, lines[2].continuation], [true, false]);
  assert.deepEqual(counts, { error: 2, warn: 1, info: 1, debug: 1, other: 1 }, 'stack lines are not counted as separate errors');
  assert.equal(lines[5].text, 'payment failed\nError: declined\n    at pay (pay.js:3:9)');
  // No zone: shown as written, never guessed. With a zone (or a JSON epoch): an exact moment.
  assert.deepEqual([lines[0].at, lines[0].time], [null, '2026-11-10 09:00:00,120']);
  assert.deepEqual([lines[2].at, lines[5].at], ['2026-11-10T09:00:07.000Z', '2026-11-10T09:00:10.000Z']);
  assert.deepEqual([from, to], ['2026-11-10T09:00:07.000Z', '2026-11-10T09:00:11.000Z']);
});

test('JUnit parser: suites, failures, skips, entities and CDATA; broken XML is refused', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- written by a test runner -->
<testsuites>
  <testsuite name="cart" tests="3">
    <testcase classname="cart.totals" name="adds tax &amp; shipping" time="0.012"/>
    <testcase classname="cart.totals" name="rounds &lt;half&gt; up" time="0.5">
      <failure message="expected 10 got 9"><![CDATA[AssertionError: 10 !== 9
    at test.js:4:3]]></failure>
    </testcase>
    <testcase name="old coupon flow"><skipped/></testcase>
  </testsuite>
  <testsuite name="api"><testcase classname="api" name="times out" time="2"><error message="Timeout &#8211; 2000ms"/></testcase></testsuite>
</testsuites>`;
  const { cases, totals } = parseJUnit(xml);
  assert.deepEqual(cases.map((c) => [c.key, c.status, c.duration]), [
    ['cart.totals::adds tax & shipping', 'passed', 12],
    ['cart.totals::rounds <half> up', 'failed', 500],
    ['cart::old coupon flow', 'skipped', null],
    ['api::times out', 'failed', 2000],
  ]);
  assert.equal(cases[1].message, 'expected 10 got 9\nAssertionError: 10 !== 9\n    at test.js:4:3');
  assert.equal(cases[3].message, 'Timeout – 2000ms');
  assert.deepEqual(totals, { tests: 4, passed: 1, failed: 2, skipped: 1, duration: 2512 });
  assert.throws(() => parseJUnit('<testsuite><testcase name="a"></testsuite>'), JUnitError);
  assert.throws(() => parseJUnit('<testsuite name="empty"></testsuite>'), /No <testcase>/);
  assert.throws(() => parseJUnit('{"not":"xml"}'), JUnitError);
});

const harFile = () => ({
  log: {
    version: '1.2', browser: { name: 'Chrome', version: '131' }, pages: [{ id: 'p1' }],
    entries: [
      {
        startedDateTime: '2026-11-10T09:00:00.000Z', time: 120,
        request: {
          method: 'POST', url: `https://api.shop.example/login?next=/cart&access_token=${BEARER}`,
          headers: [{ name: 'Cookie', value: `sid=${SESSION}` }, { name: 'Authorization', value: `Bearer ${BEARER}` }, { name: 'Accept', value: 'application/json' }],
          cookies: [{ name: 'sid', value: SESSION }],
          queryString: [{ name: 'next', value: '/cart' }, { name: 'access_token', value: BEARER }],
          postData: { mimeType: 'application/json', text: JSON.stringify({ email: 'meera@example.com', password: PASSWORD, remember: true }) },
        },
        response: {
          status: 200, statusText: 'OK', headers: [{ name: 'Set-Cookie', value: `sid=${SESSION}; HttpOnly` }, { name: 'Content-Type', value: 'application/json' }],
          cookies: [{ name: 'sid', value: SESSION }], content: { size: 512, mimeType: 'application/json', text: JSON.stringify({ token: BEARER, user: 'Meera' }) },
        },
      },
      {
        startedDateTime: '2026-11-10T09:00:00.200Z', time: 1800,
        request: { method: 'GET', url: 'https://api.shop.example/cart?id=42', headers: [], cookies: [], queryString: [{ name: 'id', value: '42' }] },
        response: { status: 500, statusText: 'Internal Server Error', headers: [], cookies: [], content: { size: 64, mimeType: 'text/html', text: '<h1>oops</h1>' } },
      },
      {
        startedDateTime: '2026-11-10T09:00:00.300Z', time: 40,
        request: { method: 'GET', url: 'https://cdn.shop.example/app.js', headers: [], cookies: [] },
        response: { status: 200, statusText: 'OK', headers: [], cookies: [], content: { size: 250000, mimeType: 'application/javascript' } },
      },
    ],
  },
});

test('HAR cleaning: cookies, auth headers, token parameters, passwords and bodies never survive', () => {
  const { buffer, removed } = sanitizeHar(Buffer.from(JSON.stringify(harFile())));
  const text = buffer.toString('utf8');
  for (const secret of [SESSION, BEARER, PASSWORD]) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 6)}`);
  const har = JSON.parse(text);
  const [login] = har.log.entries;
  assert.deepEqual(login.request.cookies, []);
  assert.equal(login.request.headers.find((h) => h.name === 'Accept').value, 'application/json', 'harmless headers stay');
  assert.equal(new URL(login.request.url).searchParams.get('next'), '/cart');
  // Passwords go by field name; email addresses go too (the same redaction as pasted errors).
  assert.deepEqual(JSON.parse(login.request.postData.text), { email: '[redacted: email]', password: '[removed]', remember: true });
  assert.equal(login.response.content.text, undefined, 'response bodies are dropped');
  assert.equal(login.response.content.size, 512, 'their size is kept');
  assert.equal(removed.cookies, 2);
  assert.equal(removed.headers, 3);
  assert.equal(removed.bodies, 2);

  const a = analyzeHar(har);
  assert.deepEqual([a.requests, a.pages, a.browser, a.wallTime, a.totalBytes], [3, 1, 'Chrome 131', 2000, 250576]);
  assert.deepEqual(a.failed.map((f) => [f.method, f.url, f.status]), [['GET', 'https://api.shop.example/cart', 500]], 'no query strings in the report');
  assert.equal(a.slowest[0].url, 'https://api.shop.example/cart');
  assert.equal(a.largest[0].url, 'https://cdn.shop.example/app.js');
  assert.deepEqual(a.hosts.map((h) => [h.host, h.requests, h.failed]), [['api.shop.example', 2, 1], ['cdn.shop.example', 1, 0]]);
  assert.throws(() => sanitizeHar(Buffer.from('{"log":{}}')), HarError);
  assert.throws(() => sanitizeHar(Buffer.from('not json')), HarError);
});

// ---------- through the API ----------

test('log viewer: filter by level, search, jump to errors, warn about secrets in the log', async () => {
  const c = await setup();
  const log = `2026-11-10T09:00:00Z INFO boot\n2026-11-10T09:00:01Z ERROR db down\n    at connect (db.js:1:1)\n2026-11-10T09:00:02Z INFO token=${BEARER}\n2026-11-10T09:00:03Z ERROR db down again\n`;
  const up = await post(`${c.base}/tickets/1/attachments`, c.dev.token, {}, log, 'server.log');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const url = `${c.base}/tickets/1/attachments/${up.body.attachment.id}/log`;
  const all = (await t.api('GET', url, { token: c.viewer.token })).body;
  assert.deepEqual([all.total, all.counts.error, all.counts.info, all.errors], [5, 2, 2, [2, 5]]);
  assert.ok(all.secrets.length >= 1, 'the token in the log is flagged');
  const errors = (await t.api('GET', `${url}?level=error`, { token: c.viewer.token })).body;
  assert.deepEqual(errors.lines.map((l) => l.n), [2, 3, 5]);
  const search = (await t.api('GET', `${url}?q=AGAIN`, { token: c.viewer.token })).body;
  assert.deepEqual(search.lines.map((l) => l.n), [5]);
  assert.equal((await t.api('GET', `${url}?level=loud`, { token: c.viewer.token })).status, 400);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
  const img = await post(`${c.base}/tickets/1/attachments`, c.dev.token, {}, png, 'shot.png');
  assert.equal((await t.api('GET', `${c.base}/tickets/1/attachments/${img.body.attachment.id}/log`, { token: c.dev.token })).body.error.code, 'not_a_log');
});

test('HAR upload: only the cleaned file is stored, with what was removed, and it is analysed', async () => {
  const c = await setup();
  const up = await post(`${c.base}/tickets/1/attachments`, c.dev.token, {}, JSON.stringify(harFile()), 'checkout.har');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.deepEqual([up.body.attachment.cleaned.cookies, up.body.attachment.cleaned.headers], [2, 3]);
  const stored = await fetch(`${t.base}${c.base}/tickets/1/attachments/${up.body.attachment.id}`, { headers: { authorization: `Bearer ${c.dev.token}` } }).then((r) => r.text());
  for (const secret of [SESSION, BEARER, PASSWORD]) assert.ok(!stored.includes(secret), 'the stored file has no secrets');
  assert.equal((await Attachment.findById(up.body.attachment.id).lean()).size, Buffer.byteLength(stored));
  const analysis = (await t.api('GET', `${c.base}/tickets/1/attachments/${up.body.attachment.id}/har`, { token: c.viewer.token })).body;
  assert.deepEqual([analysis.requests, analysis.failed.length, analysis.cleaned.cookies], [3, 1, 2]);
  const bad = await post(`${c.base}/tickets/1/attachments`, c.dev.token, {}, '{"log":{"version":"1.2"}}', 'broken.har');
  assert.deepEqual([bad.status, bad.body.error.code], [422, 'bad_har']);
});

const run = (results, commit) => `<testsuite name="shop">${Object.entries(results).map(([name, r]) => (
  r === 'pass' ? `<testcase classname="shop" name="${name}" time="0.1"/>` : `<testcase classname="shop" name="${name}" time="0.4"><failure message="${name} failed (${commit})"/></testcase>`
)).join('')}</testsuite>`;

test('test results: team uploads and CI uploads, flaky and failing tests, a ticket for one', async () => {
  const c = await setup();
  const url = `${c.base}/tests`;
  assert.equal((await post(url, c.viewer.token, {}, run({ a: 'pass' }, 'x'), 'r.xml')).status, 403);
  // "checkout" fails then passes on the same commit (a retry), then flips again: flaky.
  // "refund" fails in the last two runs: failing. "login" always passes.
  const runs = [
    [{ checkout: 'fail', refund: 'pass', login: 'pass' }, 'aaaaaaa1'],
    [{ checkout: 'pass', refund: 'pass', login: 'pass' }, 'aaaaaaa1'],
    [{ checkout: 'fail', refund: 'fail', login: 'pass' }, 'bbbbbbb2'],
    [{ checkout: 'pass', refund: 'fail', login: 'pass' }, 'ccccccc3'],
  ];
  for (const [results, commit] of runs.slice(0, 3)) {
    const r = await post(url, c.dev.token, { branch: 'main', commit, name: 'unit' }, run(results, commit), 'junit.xml');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 5));
  }
  // The last run comes from CI with the project's upload token; a crash key can't do it.
  const crashKey = (await t.api('POST', `${c.base}/ingest-keys`, { token: c.admin.token, body: { name: 'Web' } })).body.key;
  const ciKey = (await t.api('POST', `${c.base}/ingest-keys`, { token: c.admin.token, body: { name: 'CI', kind: 'upload' } })).body.key;
  assert.equal((await post('/api/test-results', crashKey, {}, run(runs[3][0], 'x'), 'junit.xml')).status, 401);
  assert.equal((await post('/api/test-results', null, {}, run(runs[3][0], 'x'), 'junit.xml')).status, 401);
  const ci = await post('/api/test-results', ciKey, { branch: 'main', commit: runs[3][1] }, run(...runs[3]), 'junit.xml');
  assert.deepEqual([ci.status, ci.body.run?.source, ci.body.run?.totals.failed], [201, 'ci', 1], JSON.stringify(ci.body));
  assert.equal((await post('/api/test-results', ciKey, { commit: 'not a hash' }, run({ a: 'pass' }, 'x'), 'junit.xml')).status, 400);
  assert.equal((await post('/api/test-results', ciKey, {}, '<testsuite><testcase name="x"></testsuite>', 'junit.xml')).body.error.code, 'bad_junit');

  const report = (await t.api('GET', url, { token: c.viewer.token })).body;
  assert.equal(report.window, 4);
  assert.deepEqual(report.flaky.map((f) => [f.name, f.failures, f.runs, f.flips, f.sameCommit, f.failRate]), [['checkout', 2, 4, 3, true, 50]]);
  assert.deepEqual(report.broken.map((f) => [f.name, f.failingFor]), [['refund', 2]]);
  assert.equal(report.flaky[0].lastFailure.message, 'checkout failed (bbbbbbb2)');
  assert.equal(report.runs[0].source, 'ci', 'newest first');

  const made = await t.api('POST', `${url}/ticket`, { token: c.dev.token, body: { key: 'shop::checkout' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const ticket = (await t.api('GET', `${c.base}/tickets/${made.body.key}`, { token: c.dev.token })).body.ticket;
  assert.deepEqual([ticket.title, ticket.labels, ticket.type], ['Flaky test: checkout', ['flaky-test'], 'bug']);
  assert.match(ticket.description, /both passed and failed on the same commit/);
  assert.equal((await t.api('POST', `${url}/ticket`, { token: c.dev.token, body: { key: 'shop::checkout' } })).body.error.code, 'already_ticket');
  assert.equal((await t.api('GET', url, { token: c.dev.token })).body.flaky[0].ticket, made.body.key);
  assert.equal((await t.api('POST', `${url}/ticket`, { token: c.dev.token, body: { key: 'shop::login' } })).status, 404, 'a healthy test gets no ticket');

  await t.api('DELETE', `/api/projects/${c.project.id}`, { token: c.admin.token, body: { confirmKey: c.project.key } });
  assert.equal(await TestRun.countDocuments({ project: c.project.id }), 0, 'deleting the project deletes its runs');
});
