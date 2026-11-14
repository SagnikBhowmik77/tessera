// The OpenAPI document (E15): built from the running routes, so it lists every endpoint with the
// schemas the server actually validates, and the docs page serves it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let spec;
before(async () => {
  t = await startTestServer();
  spec = (await t.api('GET', '/api/openapi.json')).body;
});
after(() => t.stop());

const ops = () => Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));

test('a valid-looking OpenAPI 3.1 document covering the whole API', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'Tessera API');
  assert.ok(ops().length > 250, `only ${ops().length} operations`);
  const ids = ops().map((o) => o.op.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  for (const { path, op } of ops()) {
    const declared = new Set((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
    for (const [, name] of path.matchAll(/\{(\w+)\}/g)) assert.ok(declared.has(name), `${path} declares {${name}}`);
    assert.ok(op.responses.default, `${path} has an error response`);
  }
  assert.ok(!JSON.stringify(spec).includes('"$schema"'));
});

test('request schemas and roles come from the code', () => {
  const login = spec.paths['/api/auth/login'].post;
  assert.deepEqual(login.requestBody.content['application/json'].schema.required, ['email', 'password']);
  assert.deepEqual(login.security, [], 'public');
  const create = spec.paths['/api/projects/{projectId}/tickets'].post;
  assert.ok(create.requestBody.content['application/json'].schema.properties.title);
  assert.deepEqual(create.security, [{ bearerAuth: [] }]);
  const storage = spec.paths['/api/projects/{projectId}/storage'].get;
  assert.match(storage.description, /manager role/);
  assert.ok(storage.parameters.some((p) => p.in === 'query' && p.name === 'days'));
  const upload = spec.paths['/api/projects/{projectId}/tickets/{ref}/attachments'].post;
  assert.ok(upload.requestBody.content['multipart/form-data']);
  assert.ok(spec.paths['/api/track/{token}'].get, 'public pages are documented too');
  assert.deepEqual(spec.paths['/api/track/{token}'].get.security, []);
});

test('the docs page loads Swagger UI with a strict content security policy', async () => {
  const res = await fetch(`${t.base}/api/docs`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /swagger-ui-dist@5\.17\.14/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts');
  const init = await fetch(`${t.base}/api/docs/init.js`);
  assert.match(init.headers.get('content-type'), /javascript/);
});
