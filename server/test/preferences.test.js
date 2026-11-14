// Personal preferences saved with the account (throwaway MongoDB): theme, accent, density, the
// sidebar and the board's layout. Partial changes merge; anything outside the allowed set is refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

const DEFAULTS = { theme: 'system', accent: null, density: 'comfortable', sidebarCollapsed: false, board: { lanes: '', mine: false, sprintOnly: false } };

test('a new account starts with the defaults, and /auth/me returns them', async () => {
  const me = await t.signUp('Pref One');
  assert.deepEqual(me.user.preferences, DEFAULTS);
  const again = await t.api('GET', '/api/auth/me', { token: me.token });
  assert.deepEqual(again.body.user.preferences, DEFAULTS);
});

test('changes merge: only what is sent changes, including inside the board layout', async () => {
  const me = await t.signUp('Pref Two');
  const a = await t.api('PATCH', '/api/auth/me/preferences', { token: me.token, body: { accent: 'teal', density: 'compact' } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.user.preferences, { ...DEFAULTS, accent: 'teal', density: 'compact' });
  const b = await t.api('PATCH', '/api/auth/me/preferences', { token: me.token, body: { board: { lanes: 'epic' }, sidebarCollapsed: true, theme: 'dark' } });
  assert.deepEqual(b.body.user.preferences, { ...DEFAULTS, accent: 'teal', density: 'compact', theme: 'dark', sidebarCollapsed: true, board: { lanes: 'epic', mine: false, sprintOnly: false } });
  const c = await t.api('PATCH', '/api/auth/me/preferences', { token: me.token, body: { board: { mine: true }, accent: null } });
  assert.deepEqual(c.body.user.preferences.board, { lanes: 'epic', mine: true, sprintOnly: false });
  assert.equal(c.body.user.preferences.accent, null);
  // Kept with the account: a fresh request sees them.
  const fresh = await t.api('GET', '/api/auth/me', { token: me.token });
  assert.deepEqual(fresh.body.user.preferences, c.body.user.preferences);
});

test('only the allowed values, only known settings, and only for yourself', async () => {
  const me = await t.signUp('Pref Three');
  for (const body of [{ accent: 'neon' }, { density: 'cozy' }, { theme: 'sepia' }, { board: { lanes: 'type' } }, { board: { colour: 'red' } }, { fontSize: 20 }, {}]) {
    const r = await t.api('PATCH', '/api/auth/me/preferences', { token: me.token, body });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(body)}`);
  }
  assert.equal((await t.api('PATCH', '/api/auth/me/preferences', { body: { density: 'compact' } })).status, 401);
  const after = await t.api('GET', '/api/auth/me', { token: me.token });
  assert.deepEqual(after.body.user.preferences, DEFAULTS, 'nothing refused was saved');
});
