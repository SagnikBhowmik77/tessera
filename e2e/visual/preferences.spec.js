import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { call, person, project } from '../tests/api.js';

// The preferences brief: an accent from the curated set, comfortable or compact density, the
// sidebar and the board's layout, all saved with the account. Checked in a real browser: set on
// one "device", seen on another; every accent passes axe's contrast rules in both themes; the look
// is there on the first paint; a refused save goes back and says so.
const OUT = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const ACCENTS = ['violet', 'rose', 'amber', 'green', 'teal', 'blue', 'orange', 'graphite'];

let ctx;
test.beforeAll(async () => {
  const owner = await person('Kavya Menon');
  const p = await project(owner, 'PREF');
  for (const [i, title] of ['Checkout button does nothing on Safari 17', 'Add Apple Pay to the payment step', 'Coupon field rejects lowercase codes', 'Search results page loads slowly', 'Gift card balance shows NaN'].entries()) {
    await call('POST', `/projects/${p.id}/tickets`, { title, type: ['bug', 'feature', 'task'][i % 3], priority: ['high', 'medium', 'low'][i % 3], labels: i % 2 ? ['payments'] : [] }, owner.token);
  }
  await call('POST', `/projects/${p.id}/tickets/2/move`, { status: 'in_progress' }, owner.token);
  ctx = { owner, p };
});

// A device: a browser that has only the sign-in token (the rest comes from the account).
async function device(browser, theme = 'dark', size = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport: size, colorScheme: theme });
  await context.addInitScript((token) => { if (!localStorage.getItem('tessera.token')) localStorage.setItem('tessera.token', token); }, ctx.owner.token);
  return context.newPage();
}
const look = (page) => page.evaluate(() => ({
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase(),
  density: document.documentElement.dataset.density ?? null,
  dark: document.documentElement.classList.contains('dark'),
  sidebar: Math.round(document.querySelector('aside[aria-label="Sidebar"]')?.getBoundingClientRect().width ?? 0),
}));

test('set on one device, there on the next: accent, density, theme, sidebar, board layout', async ({ browser }) => {
  const a = await device(browser);
  await a.goto('/account');
  const section = a.locator('section', { hasText: 'Appearance and layout' }).first();
  await section.scrollIntoViewIfNeeded();
  await a.getByRole('radio', { name: 'Teal' }).click();
  await expect(a.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await a.getByRole('radio', { name: 'Compact' }).click();
  await a.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect.poll(() => look(a)).toMatchObject({ accent: '#0b7285', density: 'compact', dark: false });
  await a.waitForTimeout(400);
  await section.screenshot({ path: `${OUT}90-preferences-light.png` });
  await a.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect.poll(() => look(a)).toMatchObject({ accent: '#4fc9de', dark: true });

  // "[" collapses the sidebar; the board's own layout controls save to the account too.
  await a.goto(`/projects/${ctx.p.id}`);
  await a.locator('[data-ticket-card]').first().waitFor();
  await a.locator('body').click({ position: { x: 1200, y: 780 } });
  await a.keyboard.press('[');
  await expect.poll(async () => (await look(a)).sidebar).toBe(64);
  await a.getByRole('combobox', { name: 'Swimlanes' }).click();
  await a.getByRole('option', { name: 'Lanes by priority' }).click();
  await expect.poll(async () => (await call('GET', '/auth/me', null, ctx.owner.token)).user.preferences).toMatchObject({
    accent: 'teal', density: 'compact', theme: 'dark', sidebarCollapsed: true, board: { lanes: 'priority' },
  });
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${OUT}91-board-compact-collapsed-teal-dark.png` });
  await a.context().close();

  // Another device: nothing stored but the token. Everything arrives with the account.
  const b = await device(browser, 'light');
  await b.goto(`/projects/${ctx.p.id}`);
  await b.locator('[data-ticket-card]').first().waitFor();
  await expect.poll(() => look(b)).toMatchObject({ accent: '#4fc9de', density: 'compact', dark: true, sidebar: 64 });
  await expect(b.getByRole('combobox', { name: 'Swimlanes' })).toContainText('Lanes by priority');
  console.log('second device:', JSON.stringify(await look(b)));
  await b.context().close();
});

test('the look is there on the first paint (no flash), and leaves on public pages', async ({ browser }) => {
  await call('PATCH', '/auth/me/preferences', { accent: 'rose', density: 'compact', theme: 'dark' }, ctx.owner.token);
  const page = await device(browser);
  await page.goto(`/projects/${ctx.p.id}`);
  await page.locator('[data-ticket-card]').first().waitFor();
  // On the next load the pre-paint script applies the saved copy before any app code runs:
  // read the page as soon as the HTML is parsed (module scripts have not run yet).
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      const h = document.documentElement;
      window.__firstLook ??= { accented: h.classList.contains('ds-accented'), accent: h.style.getPropertyValue('--accent-dark').trim().toLowerCase(), density: h.dataset.density ?? null };
    }, { once: true });
  });
  await page.reload();
  await page.locator('[data-ticket-card]').first().waitFor();
  const first = await page.evaluate(() => window.__firstLook);
  console.log('before the app ran:', JSON.stringify(first));
  expect(first).toEqual({ accented: true, accent: '#ff7a9c', density: 'compact' });
  // A public page (the team's report page) does not wear the person's accent.
  const portal = (await call('PUT', `/projects/${ctx.p.id}/portal`, { enabled: true }, ctx.owner.token)).portal;
  await page.goto(new URL(portal.url).pathname);
  await page.getByLabel('What happened?').waitFor();
  expect(await page.evaluate(() => document.documentElement.classList.contains('ds-accented'))).toBe(false);
  await page.context().close();
});

test('every accent passes axe (WCAG 2.2 AA, contrast included) in both themes, compact', async ({ browser }) => {
  const page = await device(browser);
  const failures = [];
  for (const theme of ['light', 'dark']) {
    for (const accent of ACCENTS) {
      await call('PATCH', '/auth/me/preferences', { accent, theme, density: 'compact', sidebarCollapsed: false }, ctx.owner.token);
      await page.goto(`/projects/${ctx.p.id}`);
      await page.locator('[data-ticket-card]').first().waitFor();
      await page.waitForTimeout(250);
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      if (violations.length) failures.push(`${theme} ${accent}: ${violations.map((v) => `${v.id}×${v.nodes.length} ${v.nodes[0].target.join(' ')}`).join(', ')}`);
    }
  }
  console.log(failures.length ? failures.join('\n') : 'all 8 accents × 2 themes: no violations');
  expect(failures).toEqual([]);
  await page.context().close();
});

test('a refused save goes back and says so', async ({ browser }) => {
  await call('PATCH', '/auth/me/preferences', { accent: null, theme: 'dark', density: 'comfortable', sidebarCollapsed: false, board: { lanes: '' } }, ctx.owner.token);
  const page = await device(browser);
  await page.goto('/account');
  await page.getByRole('radio', { name: 'Blue' }).waitFor();
  await page.route('**/api/auth/me/preferences', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'x' } }) }));
  await page.getByRole('radio', { name: 'Blue' }).click();
  await expect(page.getByText(/Couldn't save that preference: Something went wrong on our side/)).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Tessera (the brand gradient)' })).toHaveAttribute('aria-checked', 'true');
  expect((await look(page)).accent).toBe('');
  await page.context().close();
});

test('comfortable and compact side by side (light)', async ({ browser }) => {
  for (const density of ['comfortable', 'compact']) {
    await call('PATCH', '/auth/me/preferences', { accent: 'violet', theme: 'light', density, sidebarCollapsed: false, board: { lanes: '' } }, ctx.owner.token);
    const page = await device(browser, 'light');
    await page.goto(`/projects/${ctx.p.id}`);
    await page.locator('[data-ticket-card]').first().waitFor();
    await page.waitForTimeout(500);
    const h = await page.locator('[data-ticket-card]').first().evaluate((el) => Math.round(el.getBoundingClientRect().height));
    console.log(`${density}: first card ${h}px tall`);
    await page.screenshot({ path: `${OUT}92-board-${density}-light.png`, clip: { x: 256, y: 160, width: 1024, height: 520 } });
    await page.context().close();
  }
});
