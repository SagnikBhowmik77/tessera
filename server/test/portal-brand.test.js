// Portal branding: the name, accent and logo a team gives its public report page (throwaway
// MongoDB). The logo is checked by its bytes, kept out of the project document, and served with
// headers that keep it an image and nothing else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { PortalLogo, Project } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const manager = await t.signUp('Manager');
  const dev = await t.signUp('Dev');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Orbit Checkout', key: `BRD${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: manager.user.id, role: 'manager' }, { user: dev.user.id, role: 'developer' }] } } });
  const base = `/api/projects/${body.project.id}`;
  const on = await t.api('PUT', `${base}/portal`, { token: manager.token, body: { enabled: true } });
  return { admin, manager, dev, project: body.project, base, token: on.body.portal.url.split('/report/')[1] };
}

// The smallest real images: a 1x1 PNG, the start of a JPEG, a RIFF/WEBP header.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a42d0000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);

async function upload(url, who, bytes, name, claimedType = 'image/png') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: claimedType }), name);
  const res = await fetch(t.base + url, { method: 'PUT', headers: { authorization: `Bearer ${who.token}` }, body: form });
  return { status: res.status, body: await res.json() };
}

test('managers set the page name and accent; reporters see them; others cannot change them', async () => {
  const { base, manager, dev, token } = await team();
  assert.equal((await t.api('PUT', `${base}/portal`, { token: dev.token, body: { brand: { accent: 'rose' } } })).status, 403);
  assert.equal((await t.api('PUT', `${base}/portal`, { token: manager.token, body: { brand: { accent: 'neon' } } })).status, 400);
  assert.equal((await t.api('PUT', `${base}/portal`, { token: manager.token, body: { brand: { name: 'x'.repeat(61) } } })).status, 400);

  const set = await t.api('PUT', `${base}/portal`, { token: manager.token, body: { brand: { name: 'Orbit Help', accent: 'teal' } } });
  assert.deepEqual(set.body.portal.brand, { name: 'Orbit Help', accent: 'teal', logo: null });
  assert.deepEqual((await t.api('GET', `/api/portal/${token}`)).body.brand, { name: 'Orbit Help', accent: 'teal', logo: null });

  // An empty name means "use the project's", and the accent can be cleared.
  await t.api('PUT', `${base}/portal`, { token: manager.token, body: { brand: { name: '', accent: null } } });
  assert.deepEqual((await t.api('GET', `/api/portal/${token}`)).body.brand, { name: 'Orbit Checkout', accent: null, logo: null });
});

test('the logo: real PNG, JPEG or WebP only, at most 256 KB, kept outside the project', async () => {
  const { base, manager, dev, project } = await team();
  const url = `${base}/portal/logo`;
  assert.equal((await upload(url, dev, PNG, 'logo.png')).status, 403);

  // A script or an SVG dressed up as a PNG is refused, whatever its name and claimed type.
  const fake = await upload(url, manager, Buffer.from('<svg onload="alert(1)"/>'), 'logo.png', 'image/png');
  assert.deepEqual([fake.status, fake.body.error.code], [400, 'bad_image']);
  const tooBig = await upload(url, manager, Buffer.concat([PNG, Buffer.alloc(256 * 1024)]), 'big.png');
  assert.deepEqual([tooBig.status, tooBig.body.error.code], [413, 'too_large']);
  assert.match(tooBig.body.error.message, /256 KB/);

  for (const [bytes, type] of [[JPEG, 'image/jpeg'], [WEBP, 'image/webp'], [PNG, 'image/png']]) {
    const ok = await upload(url, manager, bytes, 'logo.bin', 'application/octet-stream');
    assert.equal(ok.status, 200);
    assert.match(ok.body.portal.brand.logo, /^[0-9a-f]{16}$/);
    assert.equal((await PortalLogo.findOne({ project: project.id })).type, type);
  }
  assert.equal(await PortalLogo.countDocuments({ project: project.id }), 1, 'a new logo replaces the old one');
  const doc = await Project.findById(project.id).lean();
  assert.ok(!doc.portal.brand.data && typeof doc.portal.brand.logo === 'string', 'only the version is on the project');

  // The team can see it while setting up (with their login).
  const mine = await fetch(t.base + url, { headers: { authorization: `Bearer ${manager.token}` } });
  assert.deepEqual([mine.status, mine.headers.get('content-type')], [200, 'image/png']);
});

test('the public logo is served as an image and nothing else, and only while the page is on', async () => {
  const { base, manager, token } = await team();
  await upload(`${base}/portal/logo`, manager, PNG, 'logo.png');
  const info = (await t.api('GET', `/api/portal/${token}`)).body;
  assert.match(info.brand.logo, new RegExp(`^/api/portal/${token}/logo\\?v=[0-9a-f]{16}$`));

  const res = await fetch(t.base + info.brand.logo);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(res.headers.get('cache-control'), /immutable/, 'the versioned address is cached for good');
  assert.match((await fetch(`${t.base}/api/portal/${token}/logo`)).headers.get('cache-control'), /max-age=300/, 'the bare address is not');
  assert.equal((await fetch(t.base + info.brand.logo, { headers: { 'if-none-match': res.headers.get('etag') } })).status, 304);

  // Removed: the page has no logo and the address is gone.
  const removed = await t.api('DELETE', `${base}/portal/logo`, { token: manager.token });
  assert.equal(removed.body.portal.brand.logo, null);
  assert.equal((await fetch(`${t.base}/api/portal/${token}/logo`)).status, 404);

  // Turned off: nothing is served, even with a logo.
  await upload(`${base}/portal/logo`, manager, PNG, 'logo.png');
  await t.api('PUT', `${base}/portal`, { token: manager.token, body: { enabled: false } });
  assert.equal((await fetch(`${t.base}/api/portal/${token}/logo`)).status, 404);
});

test('deleting the project deletes its logo', async () => {
  const { base, admin, manager, project } = await team();
  await upload(`${base}/portal/logo`, manager, PNG, 'logo.png');
  assert.equal(await PortalLogo.countDocuments({ project: project.id }), 1);
  const del = await t.api('DELETE', base, { token: admin.token, body: { confirmKey: project.key } });
  assert.ok(del.status < 300, `delete answered ${del.status}`);
  assert.equal(await PortalLogo.countDocuments({ project: project.id }), 0);
});
