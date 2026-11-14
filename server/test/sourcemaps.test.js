// Source maps (E6B): upload (Settings and CI token), unminifying crashes, grouping across builds,
// re-mapping older tickets (throwaway MongoDB; emails captured, never sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SourceMapGenerator } from 'source-map-js';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { Project, SourceMap, Ticket } from '../src/models/index.js';

let t;
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail() { return {}; } });
});
after(async () => { __setTransport(null); await t.stop(); });

// A small "app": the original source and what a minifier would make of it, with a real map.
const ORIGINAL = [
  'export function calculateTotal(cart) {',
  '  return cart.items.reduce((sum, item) => sum + item.price, 0);',
  '}',
  'export function onSubmit(event) {',
  '  const cart = event.cart;',
  '  return calculateTotal(cart);',
  '}',
  'export function checkout(event) {',
  '  return onSubmit(event);',
  '}',
].join('\n');
const MINIFIED = 'function a(n){return n.items.reduce((t,e)=>t+e.price,0)}function b(n){const t=n.cart;return a(t)}function c(e){return b(e)}';
const at = (s) => MINIFIED.indexOf(s);

function mapFor(file) {
  const g = new SourceMapGenerator({ file });
  const src = 'webpack://shop/./src/cart.js';
  const add = (genCol, line, col, name) => g.addMapping({ generated: { line: 1, column: genCol }, original: { line, column: col }, source: src, name });
  add(0, 1, 0);
  add(at('reduce'), 2, 20, 'reduce');
  add(at('function b'), 4, 0);
  add(at('a(t)'), 6, 9, 'calculateTotal');
  add(at('function c'), 8, 0);
  add(at('b(e)'), 9, 9, 'onSubmit');
  g.setSourceContent(src, ORIGINAL);
  return g.toString();
}
const STACK = (file) => `TypeError: Cannot read properties of undefined (reading 'reduce')
    at a (https://shop.example.com/assets/${file}:1:${at('reduce') + 1})
    at b (https://shop.example.com/assets/${file}:1:${at('a(t)') + 1})
    at c (https://shop.example.com/assets/${file}:1:${at('b(e)') + 1})`;

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `SM${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  const base = `/api/projects/${body.project.id}`;
  const { key } = (await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'Web' } })).body;
  return { admin, dev, project: body.project, base, key };
}

function upload(path, auth, release, files) {
  const fd = new FormData();
  if (release !== undefined) fd.append('release', release);
  for (const [name, text] of files) fd.append('files', new Blob([text], { type: 'application/json' }), name);
  return fetch(`${t.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: fd })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
const crash = (key, stack, release) => fetch(`${t.base}/api/ingest`, {
  method: 'POST', headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ key, type: 'TypeError', message: "Cannot read properties of undefined (reading 'reduce')", stack, release }),
});

test('uploading maps from Settings: managers only, checked before anything is stored', async () => {
  const { admin, dev, base } = await team();
  const good = ['app.4f9a2c1e.js.map', mapFor('app.4f9a2c1e.js')];
  assert.equal((await upload(`${base}/sourcemaps`, dev.token, '1.0.0', [good])).status, 403);
  assert.equal((await upload(`${base}/sourcemaps`, admin.token, '', [good])).body.error.code, 'release_required');
  const bad = await upload(`${base}/sourcemaps`, admin.token, '1.0.0', [good, ['notes.map', 'not json']]);
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'not_a_map']);
  assert.equal(await SourceMap.countDocuments({}), 0, 'a bad file stops the whole upload');
  const noScript = JSON.parse(mapFor('x')); delete noScript.file;
  assert.equal((await upload(`${base}/sourcemaps`, admin.token, '1.0.0', [['bundle.map', JSON.stringify(noScript)]])).body.error.code, 'unknown_script');

  const ok = await upload(`${base}/sourcemaps`, admin.token, '1.0.0', [good]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.maps.map((m) => [m.file, m.replaced]), [['app.4f9a2c1e.js', false]]);
  const again = await upload(`${base}/sourcemaps`, admin.token, '1.0.0', [good]);
  assert.equal(again.body.maps[0].replaced, true, 'uploading the same script again replaces it');
  const list = (await t.api('GET', `${base}/sourcemaps`, { token: dev.token })).body;
  assert.deepEqual([list.count, list.releases[0].release, list.releases[0].maps[0].file], [1, '1.0.0', 'app.4f9a2c1e.js']);
  const audit = (await t.api('GET', `${base}/audit`, { token: admin.token })).body.entries;
  assert.equal(audit[0].action, 'sourcemaps.uploaded');
});

test('crashes from minified code come back as the original files, lines and functions', async () => {
  const { admin, base, project, key } = await team();
  await upload(`${base}/sourcemaps`, admin.token, '1.0.0', [['app.4f9a2c1e.js.map', mapFor('app.4f9a2c1e.js')]]);
  await t.api('PUT', `${base}/source`, { token: admin.token, body: { repo: 'acme/shop', branch: 'main' } });
  assert.equal((await crash(key, STACK('app.4f9a2c1e.js'), '1.0.0')).status, 202);

  const ticket = (await t.api('GET', `${base}/tickets/1`, { token: admin.token })).body.ticket;
  const frames = ticket.error.frames;
  assert.deepEqual(frames.map((f) => [f.fn, f.file, f.line, f.column]), [
    ['calculateTotal', 'src/cart.js', 2, 21],
    ['onSubmit', 'src/cart.js', 6, 10],
    ['c', 'src/cart.js', 9, 10],
  ]);
  assert.deepEqual(frames[0].minified, { fn: 'a', file: 'https://shop.example.com/assets/app.4f9a2c1e.js', line: 1, column: at('reduce') + 1 });
  assert.deepEqual(frames[0].context, {
    pre: ['export function calculateTotal(cart) {'],
    line: '  return cart.items.reduce((sum, item) => sum + item.price, 0);',
    post: ['}', 'export function onSubmit(event) {'],
  });
  assert.deepEqual(ticket.error.unminified, { mapped: 3, of: 3, releases: ['1.0.0'] });
  assert.equal(frames[0].source, 'https://github.com/acme/shop/blob/main/src/cart.js#L2', 'original paths get source links');
  assert.match(ticket.description, /\*\*Original source:\*\* `calculateTotal \(src\/cart\.js:2:21\)` \(from the source maps of release 1\.0\.0\)/);

  // The next build (new hash, new release, its own maps) is the same crash: grouped, not a duplicate.
  await upload(`${base}/sourcemaps`, admin.token, '1.0.1', [['app.9b8c7d6e.js.map', mapFor('app.9b8c7d6e.js')]]);
  await crash(key, STACK('app.9b8c7d6e.js'), '1.0.1');
  assert.equal(await Ticket.countDocuments({ project: project.id }), 1);
  assert.equal((await Ticket.findOne({ project: project.id })).error.occurrences, 2);

  // Pasting the minified trace in the app finds it too (the hashed name is enough without a release).
  const preview = (await t.api('POST', `${base}/tickets/parse-error`, { token: admin.token, body: { text: STACK('app.4f9a2c1e.js') } })).body;
  assert.equal(preview.error.frames[0].fn, 'calculateTotal');
  assert.equal(preview.seenBefore.key, `${project.key}-1`);
});

test('an older crash is mapped again after its maps are uploaded; no silent merging', async () => {
  const { admin, dev, base, project, key } = await team();
  // Release 2.0.0 crashes before anyone uploaded its maps: stays minified.
  await crash(key, STACK('app.aaaaaaaa.js'), '2.0.0');
  const before = (await t.api('GET', `${base}/tickets/1`, { token: admin.token })).body.ticket;
  assert.equal(before.error.frames[0].fn, 'a');
  assert.equal(before.error.unminified, null);
  assert.deepEqual((await t.api('POST', `${base}/tickets/1/error/unminify`, { token: dev.token })).body, { mapped: 0, sameAs: null });

  await upload(`${base}/sourcemaps`, admin.token, '2.0.0', [['app.aaaaaaaa.js.map', mapFor('app.aaaaaaaa.js')]]);
  const res = await t.api('POST', `${base}/tickets/1/error/unminify`, { token: dev.token });
  assert.deepEqual(res.body, { mapped: 3, sameAs: null });
  const afterMap = (await t.api('GET', `${base}/tickets/1`, { token: admin.token })).body.ticket;
  assert.equal(afterMap.error.frames[0].fn, 'calculateTotal');
  const history = (await t.api('GET', `${base}/tickets/1/history`, { token: admin.token })).body.events.map((e) => e.type);
  assert.ok(history.includes('error_unminified'));
  // New reports of it now group onto it by the original frames.
  await crash(key, STACK('app.aaaaaaaa.js'), '2.0.0');
  assert.equal(await Ticket.countDocuments({ project: project.id }), 1);

  // A second, separate ticket of the same crash from an unmapped build keeps its own fingerprint.
  await crash(key, STACK('app.bbbbbbbb.js'), '2.1.0');
  await upload(`${base}/sourcemaps`, admin.token, '2.1.0', [['app.bbbbbbbb.js.map', mapFor('app.bbbbbbbb.js')]]);
  const clash = await t.api('POST', `${base}/tickets/2/error/unminify`, { token: dev.token });
  assert.deepEqual(clash.body, { mapped: 3, sameAs: `${project.key}-1` });
  const two = await Ticket.findOne({ project: project.id, number: 2 }).lean();
  const one = await Ticket.findOne({ project: project.id, number: 1 }).lean();
  assert.notEqual(two.error.fingerprint, one.error.fingerprint);
});

test('CI uploads with an upload token; tokens and ingest keys never stand in for each other', async () => {
  const { admin, base, key } = await team();
  const made = await t.api('POST', `${base}/ingest-keys`, { token: admin.token, body: { name: 'CI', kind: 'upload', origins: ['https://shop.example.com'] } });
  assert.match(made.body.key, /^tsu_/);
  assert.deepEqual([made.body.ingestKey.kind, made.body.ingestKey.origins], ['upload', []]);
  const tsu = made.body.key;

  const map = ['app.cccccccc.js.map', mapFor('app.cccccccc.js')];
  assert.equal((await upload('/api/sourcemaps', key, '3.0.0', [map])).status, 401, 'a public ingest key cannot upload maps');
  assert.equal((await upload('/api/sourcemaps', 'tsu_nope', '3.0.0', [map])).status, 401);
  const ok = await upload('/api/sourcemaps', tsu, '3.0.0', [map]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const sent = await fetch(`${t.base}/api/ingest`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ key: tsu, message: 'x' }) });
  assert.equal(sent.status, 401, 'an upload token cannot send crashes');
  const keys = (await t.api('GET', `${base}/ingest-keys`, { token: admin.token })).body.keys;
  assert.equal(keys.find((k) => k.kind === 'upload').received, 1);

  const del = await t.api('DELETE', `${base}/sourcemaps?release=3.0.0`, { token: admin.token });
  assert.deepEqual(del.body, { release: '3.0.0', deleted: 1 });
  assert.equal((await t.api('DELETE', `${base}/sourcemaps?release=3.0.0`, { token: admin.token })).status, 404);
});
