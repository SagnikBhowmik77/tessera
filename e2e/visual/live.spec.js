import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { call, person, project } from '../tests/api.js';

// The interaction polish, checked in two real browser sessions on one project (an owner and a
// teammate, two separate logins, the real Socket.IO server): live drags, live-change highlights,
// presence, typing; optimistic saves and their rollback; key previews; inline editing; the "?" list.
const OUT = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const SIZE = { width: 1280, height: 800 };

let ctx;
test.beforeAll(async () => {
  const owner = await person('Ananya Chatterjee');
  const p = await project(owner, 'LIVE');
  const base = `/projects/${p.id}`;
  const mate = await person('Ravi Iyer');
  const inv = await call('POST', `${base}/invites`, { email: mate.email, role: 'developer' }, owner.token);
  await call('POST', `/invites/${new URL(inv.acceptUrl).pathname.split('/').pop()}/accept`, {}, mate.token);
  for (const title of ['Checkout button does nothing on Safari 17', 'Add Apple Pay to the payment step', 'Coupon field rejects lowercase codes', 'Search results page loads slowly']) {
    await call('POST', `${base}/tickets`, { title, type: 'bug', priority: 'high' }, owner.token);
  }
  await call('POST', `${base}/tickets/2/move`, { status: 'in_progress' }, owner.token);
  ctx = { owner, mate, p, base };
});

async function session(browser, who, theme = 'dark') {
  const context = await browser.newContext({ viewport: SIZE, colorScheme: theme });
  await context.addInitScript(([th, token]) => { localStorage.setItem('tessera.theme', th); localStorage.setItem('tessera.token', token); }, [theme, who.token]);
  const page = await context.newPage();
  return { context, page };
}
const card = (page, key) => page.locator(`[data-ticket-card="${key}"]`);

test('live: a teammate\'s drag, their change, presence and typing reach the other session', async ({ browser }) => {
  const a = await session(browser, ctx.owner);
  const b = await session(browser, ctx.mate, 'light');
  await Promise.all([a.page.goto(`/projects/${ctx.p.id}`), b.page.goto(`/projects/${ctx.p.id}`)]);
  await Promise.all([a.page.waitForLoadState('networkidle'), b.page.waitForLoadState('networkidle')]);
  await a.page.waitForTimeout(600);

  // 1. Ravi picks up LIVE-3 with the keyboard: Ananya sees it held, with his name.
  await b.page.getByRole('button', { name: /\bLIVE-3\b/ }).focus();
  await b.page.keyboard.press('Space');
  await expect(card(a.page, 'LIVE-3')).toHaveAttribute('data-held-by', 'Ravi Iyer', { timeout: 4000 });
  await expect(card(a.page, 'LIVE-3')).toContainText('Ravi is moving this');
  await a.page.screenshot({ path: `${OUT}60-live-held-dark.png`, clip: { x: 256, y: 270, width: 1024, height: 330 } });
  console.log('held: Ananya sees LIVE-3 held by Ravi');

  // 2. He drops it in another column: it is let go, and the changed card glows briefly for her.
  await b.page.keyboard.press('ArrowRight');
  await b.page.waitForTimeout(200);
  await b.page.keyboard.press('Space');
  await expect(card(a.page, 'LIVE-3')).not.toHaveAttribute('data-held-by', /.+/, { timeout: 4000 });
  await expect(card(a.page, 'LIVE-3')).toHaveClass(/ds-live-flash/, { timeout: 5000 });
  await a.page.waitForTimeout(150);
  await a.page.screenshot({ path: `${OUT}61-live-changed-dark.png`, clip: { x: 256, y: 270, width: 1024, height: 330 } });
  const where = await card(a.page, 'LIVE-3').evaluate((el) => el.closest('section')?.getAttribute('aria-label'));
  console.log('changed: LIVE-3 glowed for Ananya, now in', where);
  // Ravi's own screen does not flash his own move.
  await expect(card(b.page, 'LIVE-3')).not.toHaveClass(/ds-live-flash/);

  // 3. Both open LIVE-1: presence with the breathing ring, then Ravi types and sends a comment.
  await Promise.all([a.page.goto(`/projects/${ctx.p.id}/tickets/LIVE-1`), b.page.goto(`/projects/${ctx.p.id}/tickets/LIVE-1`)]);
  const drawerA = a.page.getByRole('dialog', { name: /LIVE-1/ });
  await expect(drawerA).toContainText('Ravi is here', { timeout: 5000 });
  console.log('presence markup:', await drawerA.evaluate((d) => [...d.querySelectorAll('span')].find((el) => el.textContent === '(here now)')?.parentElement.outerHTML.slice(0, 260)));
  await expect(drawerA.locator('.ds-presence')).toHaveCount(1);
  const box = b.page.getByPlaceholder(/comment/i).first();
  await box.click();
  await box.pressSequentially('Seen on iOS too', { delay: 40 });
  await expect(drawerA.locator('.ds-typing')).toBeVisible({ timeout: 4000 });
  await expect(drawerA).toContainText(/Ravi Iyer (is|are) typing/);
  await drawerA.locator('.ds-typing').scrollIntoViewIfNeeded();
  await a.page.screenshot({ path: `${OUT}62-live-presence-typing-dark.png`, clip: { x: 384, y: 0, width: 896, height: 800 } });
  await box.press('Control+Enter');
  await expect(drawerA).toContainText('Seen on iOS too', { timeout: 5000 });
  console.log('presence: ring shown; typing: tiles shown; comment arrived live');
  await a.context.close();
  await b.context.close();
});

test('optimistic: edits, comments and moves show at once and roll back when refused', async ({ browser }) => {
  const a = await session(browser, ctx.owner);
  const { page } = a;
  // Title: the server refuses; the old title comes back with a message that says what failed.
  await page.goto(`/projects/${ctx.p.id}/tickets/LIVE-4`);
  const title = page.getByRole('dialog', { name: /LIVE-4/ }).getByRole('textbox', { name: 'Title', exact: true });
  await page.route('**/api/projects/*/tickets/4', (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'The server could not save it.' } }) }) : route.continue()));
  await title.fill('Search is slow on mobile data');
  await title.press('Enter');
  await expect(page.getByText(/Couldn't save the title/)).toBeVisible({ timeout: 4000 });
  await expect(title).toHaveValue('Search results page loads slowly');
  console.log('edit refused: title rolled back with a message');
  await page.unroute('**/api/projects/*/tickets/4');

  // Comment: it shows at once ("Sending…"), then on refusal it is taken out and the text returns.
  await page.route('**/api/projects/*/tickets/4/comments', (route) => (route.request().method() === 'POST' ? new Promise((r) => setTimeout(r, 600)).then(() => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Comments are down.' } }) })) : route.continue()));
  const box = page.getByPlaceholder(/comment/i).first();
  await box.fill('Repro steps attached');
  await box.press('Control+Enter');
  await expect(page.getByText('Sending…')).toBeVisible({ timeout: 2000 });
  await expect(page.getByText(/Your comment wasn't posted/)).toBeVisible({ timeout: 4000 });
  await expect(box).toHaveValue('Repro steps attached');
  await expect(page.getByText('Sending…')).toHaveCount(0);
  console.log('comment refused: shown at once, then removed, text back in the box');
  await page.unroute('**/api/projects/*/tickets/4/comments');

  // Move: the card goes straight back to its column when the server refuses.
  await page.goto(`/projects/${ctx.p.id}`);
  await page.waitForLoadState('networkidle');
  await page.route('**/api/projects/*/tickets/1/move', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Moves are down.' } }) }));
  const from = await card(page, 'LIVE-1').evaluate((el) => el.closest('section')?.getAttribute('aria-label'));
  await page.getByRole('button', { name: /\bLIVE-1\b/ }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
  await expect(page.getByText(/Couldn't move LIVE-1/)).toBeVisible({ timeout: 4000 });
  const back = await card(page, 'LIVE-1').evaluate((el) => el.closest('section')?.getAttribute('aria-label'));
  expect(back).toBe(from);
  console.log(`move refused: LIVE-1 back in ${back}`);
  await a.context.close();
});

test('key preview, inline edit, and the shortcut list', async ({ browser }) => {
  const a = await session(browser, ctx.owner, 'light');
  const { page } = a;
  // Hover a key that links to a ticket (Flow's "what to work on next"): a preview card appears.
  await page.goto(`/projects/${ctx.p.id}/flow`);
  await page.waitForLoadState('networkidle');
  const key = page.locator('a[data-ticket-key]').first();
  const which = await key.getAttribute('data-ticket-key');
  await key.hover();
  const preview = page.locator('[data-key-preview]');
  await expect(preview).toBeVisible({ timeout: 3000 });
  await expect(preview).toHaveAttribute('data-key-preview', which);
  await expect(preview.locator('p').first()).not.toBeEmpty();
  await page.waitForTimeout(400); // past the fade-in
  await page.screenshot({ path: `${OUT}63-key-preview-light.png`, clip: { x: 256, y: 160, width: 760, height: 360 } });
  console.log('preview shown for', which);

  // Inline edit: Escape puts it back; Enter saves and the tick says so.
  await page.goto(`/projects/${ctx.p.id}/tickets/LIVE-2`);
  const title = page.getByRole('dialog', { name: /LIVE-2/ }).getByRole('textbox', { name: 'Title', exact: true });
  const before = await title.inputValue();
  await title.fill('Something else entirely');
  await title.press('Escape');
  await expect(title).toHaveValue(before);
  await expect(page.getByRole('dialog', { name: /LIVE-2/ })).toBeVisible(); // Escape did not close the drawer
  await title.fill('Add Apple Pay and Google Pay to the payment step');
  await title.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 4000 });
  await page.screenshot({ path: `${OUT}64-inline-saved-light.png`, clip: { x: 384, y: 40, width: 896, height: 200 } });
  const saved = await call('GET', `${ctx.base}/tickets/2`, null, ctx.owner.token);
  expect(saved.ticket.title).toBe('Add Apple Pay and Google Pay to the payment step');
  console.log('inline edit: Escape reverted, Enter saved with a tick');

  // "?" opens the list of shortcuts (focus outside any field).
  await page.keyboard.press('Escape');
  await page.goto(`/projects/${ctx.p.id}`);
  await page.waitForLoadState('networkidle');
  await page.locator('body').click({ position: { x: 1200, y: 760 } });
  await page.keyboard.press('Shift+Slash');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `${OUT}65-shortcuts-light.png` });
  console.log('shortcuts:', await dialog.locator('dt').count(), 'listed');
  await a.context.close();
});
