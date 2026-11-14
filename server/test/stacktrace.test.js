// The error parser, fingerprints and the duplicate finder (pure functions, no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseError, parseUserAgent, normalizeMessage } from '../src/bugs/stacktrace.js';
import { rankSimilar, tokenize } from '../src/bugs/similar.js';

const CHROME = `TypeError: Cannot read properties of undefined (reading 'total')
    at calculateTotal (https://shop.example.com/assets/checkout.4f9a2c1e.js:120:31)
    at onSubmit (https://shop.example.com/assets/checkout.4f9a2c1e.js:88:12)
    at HTMLButtonElement.dispatch (https://shop.example.com/node_modules/.vite/react-dom.js:2:4031)`;

const NODE = `Error: connect ECONNREFUSED 127.0.0.1:5432
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)
    at async Pool.connect (C:\\Users\\Sagnik Bhowmik\\app\\node_modules\\pg-pool\\index.js:45:11)
    at async getUser (C:\\Users\\Sagnik Bhowmik\\app\\src\\users.js:12:3)`;

const FIREFOX = `TypeError: total is undefined
calculateTotal@https://shop.example.com/assets/checkout.js:120:31
onSubmit@https://shop.example.com/assets/checkout.js:88:12`;

const PYTHON = `Traceback (most recent call last):
  File "/app/server.py", line 88, in handle
    result = checkout(cart)
  File "/app/billing.py", line 21, in checkout
    return helper(total, items)
  File "/usr/lib/python3.12/site-packages/mathlib/ops.py", line 5, in helper
    return a / b
ZeroDivisionError: division by zero`;

const JAVA = `Exception in thread "main" java.lang.IllegalStateException: Cart is empty
\tat com.shop.billing.Checkout.total(Checkout.java:42)
\tat com.shop.web.CartController.submit(CartController.java:17)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)
Caused by: java.lang.NullPointerException: items
\tat com.shop.billing.Cart.items(Cart.java:9)
\t... 3 more`;

const DOTNET = `Unhandled exception. System.NullReferenceException: Object reference not set to an instance of an object.
   at Shop.Billing.Checkout.Total(Cart cart) in C:\\src\\Shop\\Billing\\Checkout.cs:line 42
   at Shop.Web.CartController.Submit() in C:\\src\\Shop\\Web\\CartController.cs:line 17
   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.Execute(IActionResultTypeMapper mapper)`;

test('JavaScript (Chrome / V8): type, message, frames, own code vs libraries', () => {
  const e = parseError(CHROME);
  assert.equal(e.language, 'javascript');
  assert.equal(e.type, 'TypeError');
  assert.equal(e.message, "Cannot read properties of undefined (reading 'total')");
  assert.deepEqual(e.frames[0], {
    fn: 'calculateTotal', file: 'https://shop.example.com/assets/checkout.4f9a2c1e.js', line: 120, column: 31, inApp: true,
  });
  assert.equal(e.frames.length, 3);
  assert.equal(e.frames[2].inApp, false, 'node_modules is library code');
  assert.equal(e.recognized, true);
});

test('Node: Windows paths with spaces, async frames, node internals', () => {
  const e = parseError(NODE);
  assert.equal(e.language, 'javascript');
  assert.deepEqual([e.type, e.message], ['Error', 'connect ECONNREFUSED 127.0.0.1:5432']);
  assert.deepEqual(e.frames.map((f) => [f.fn, f.inApp]), [
    ['TCPConnectWrap.afterConnect [as oncomplete]', false],
    ['Pool.connect', false],
    ['getUser', true],
  ]);
  assert.equal(e.frames[2].file, 'C:\\Users\\Sagnik Bhowmik\\app\\src\\users.js');
});

test('JavaScript (Firefox / Safari "fn@file" format)', () => {
  const e = parseError(FIREFOX);
  assert.equal(e.language, 'javascript');
  assert.deepEqual(e.frames.map((f) => [f.fn, f.line]), [['calculateTotal', 120], ['onSubmit', 88]]);
});

test('Python: frames newest first, error from the last line', () => {
  const e = parseError(PYTHON);
  assert.equal(e.language, 'python');
  assert.deepEqual([e.type, e.message], ['ZeroDivisionError', 'division by zero']);
  assert.deepEqual(e.frames.map((f) => [f.fn, f.line, f.inApp]), [['helper', 5, false], ['checkout', 21, true], ['handle', 88, true]]);
});

test('Java: thread prefix, own frames vs Spring, "Caused by" chain', () => {
  const e = parseError(JAVA);
  assert.equal(e.language, 'java');
  assert.deepEqual([e.type, e.message], ['java.lang.IllegalStateException', 'Cart is empty']);
  assert.deepEqual(e.frames.map((f) => [f.fn, f.file, f.line, f.inApp]), [
    ['com.shop.billing.Checkout.total', 'Checkout.java', 42, true],
    ['com.shop.web.CartController.submit', 'CartController.java', 17, true],
    ['org.springframework.web.servlet.FrameworkServlet.service', 'FrameworkServlet.java', 897, false],
  ]);
  assert.deepEqual(e.causes, [{ type: 'java.lang.NullPointerException', message: 'items' }]);
});

test('Java: Jakarta EE packages (the renamed javax) are library code too', () => {
  const e = parseError(`java.lang.IllegalStateException: Payment already captured
\tat com.shop.payments.CaptureService.capture(CaptureService.java:87)
\tat jakarta.servlet.http.HttpServlet.service(HttpServlet.java:658)
\tat javax.servlet.http.HttpServlet.service(HttpServlet.java:750)`);
  assert.deepEqual(e.frames.map((f) => f.inApp), [true, false, false]);
});

test('.NET: "in file:line N" frames and framework frames', () => {
  const e = parseError(DOTNET);
  assert.equal(e.language, 'dotnet');
  assert.deepEqual([e.type, e.message], ['System.NullReferenceException', 'Object reference not set to an instance of an object.']);
  assert.deepEqual(e.frames.map((f) => [f.fn, f.line, f.inApp]), [
    ['Shop.Billing.Checkout.Total', 42, true],
    ['Shop.Web.CartController.Submit', 17, true],
    ['Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.Execute', null, false],
  ]);
  assert.equal(e.frames[0].file, 'C:\\src\\Shop\\Billing\\Checkout.cs');
});

test('fingerprints: same bug after a redeploy matches; a different place does not', () => {
  const redeployed = CHROME.replaceAll('4f9a2c1e', '9b8c7d6e').replace(':120:31', ':131:7').replace(':88:12', ':90:4');
  assert.equal(parseError(redeployed).fingerprint, parseError(CHROME).fingerprint, 'build hash and line numbers are ignored');
  const elsewhere = CHROME.replace('calculateTotal', 'applyCoupon');
  assert.notEqual(parseError(elsewhere).fingerprint, parseError(CHROME).fingerprint);
  // Library frames don't decide: same own code, different React internals, same fingerprint.
  const otherLib = CHROME.replace('HTMLButtonElement.dispatch', 'invokeGuardedCallback');
  assert.equal(parseError(otherLib).fingerprint, parseError(CHROME).fingerprint);
  assert.match(parseError(CHROME).fingerprint, /^[0-9a-f]{40}$/);
});

test('plain messages: unrecognised but still grouped by their wording', () => {
  const a = parseError('Something went wrong: order 1234 failed for "asha@example.com"');
  const b = parseError('Something went wrong: order 98 failed for "ravi@example.com"');
  assert.equal(a.language, 'unknown');
  assert.equal(a.recognized, false);
  assert.equal(a.message, 'Something went wrong: order 1234 failed for "asha@example.com"');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(normalizeMessage("user 42 id 64b7f0c2a1e3d4f5a6b7c8d9 at 0x7ffe 'x'"), 'user # id <id> at <hex> "…"');
  const lone = parseError('ValueError: invalid literal for int() with base 10');
  assert.deepEqual([lone.type, lone.recognized], ['ValueError', true]);
  assert.equal(parseError('').recognized, false);
});

test('user agents become "Chrome 130 on Windows"', () => {
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36'), { browser: 'Chrome 130', os: 'Windows' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68'), { browser: 'Edge 130', os: 'Windows' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), { browser: 'Safari 18', os: 'iOS 18.1' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0'), { browser: 'Firefox 132', os: 'macOS' });
  assert.deepEqual(parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'), { browser: 'Chrome 130', os: 'Android 14' });
  assert.equal(parseUserAgent(''), null);
});

test('duplicate finder: matches by meaning-bearing words and says why', () => {
  assert.deepEqual(tokenize('The checkout CRASHES when crashing!'), ['checkout', 'crash', 'crash']);
  const tickets = [
    { number: 1, title: 'Checkout crashes on Safari', labels: ['checkout'], description: 'Tapping pay does nothing on iOS Safari.' },
    { number: 2, title: 'Add dark mode to settings', labels: ['ui'], description: '' },
    { number: 3, title: 'Login page slow', labels: [], description: 'Takes 6 seconds on 3G.' },
    { number: 4, title: 'Payment fails with coupon at checkout', labels: ['checkout'], description: '' },
  ];
  const hits = rankSimilar(tickets, { title: 'Safari: checkout crash when paying' });
  assert.equal(hits[0].ticket.number, 1);
  assert.ok(hits[0].score >= 0.5, `score ${hits[0].score}`);
  assert.ok(hits[0].because.includes('safari') && hits[0].because.includes('crash'));
  assert.ok(!hits.some((h) => h.ticket.number === 2 || h.ticket.number === 3));
  assert.deepEqual(rankSimilar(tickets, { title: 'Export invoices to PDF' }), []);
  assert.deepEqual(rankSimilar(tickets, { title: 'the and of' }), [], 'stop words alone match nothing');
});
