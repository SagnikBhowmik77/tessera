import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { call, person, project } from '../tests/api.js';

// The brand brief: a team's portal in its own name, colour and logo, the three-step report, the
// privacy note, the confirmation, the settings that set it up, and how fast the page is on a slow
// mobile connection. Everything is made through the real API on the test server.
const OUT = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const API = 'http://localhost:8741/api';

let ctx;
test.beforeAll(async ({ browser }) => {
  const owner = await person('Meera Pillai');
  const p = await project(owner, 'ORBT');
  const portal = (await call('PUT', `/projects/${p.id}/portal`, { enabled: true, intro: 'Something not working in Orbit? Tell us and we will look at it today.', brand: { name: 'Orbit', accent: 'teal' } }, owner.token)).portal;
  // A stand-in team logo: a teal ring with an "O", drawn and photographed in the browser.
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.setContent('<body style="margin:0"><svg width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#0B7285"/><circle cx="64" cy="64" r="34" fill="none" stroke="#fff" stroke-width="14"/><circle cx="92" cy="36" r="9" fill="#9FE6F2"/></svg></body>');
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 128, height: 128 } });
  await page.close();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'orbit.png');
  const up = await fetch(`${API}/projects/${p.id}/portal/logo`, { method: 'PUT', headers: { authorization: `Bearer ${owner.token}` }, body: form });
  expect(up.status).toBe(200);
  const plain = await project(owner, 'PLAN');
  const plainPortal = (await call('PUT', `/projects/${plain.id}/portal`, { enabled: true }, owner.token)).portal;
  ctx = { owner, p, path: new URL(portal.url).pathname, plainPath: new URL(plainPortal.url).pathname };
});

async function open(browser, theme, viewport = { width: 1280, height: 860 }) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((th) => { localStorage.setItem('tessera.theme', th); localStorage.setItem('tessera.publicLang', 'en'); }, theme);
  return context.newPage();
}

for (const theme of ['dark', 'light']) {
  test(`portal in the team's brand, every step and the thank-you (${theme})`, async ({ browser }) => {
    const page = await open(browser, theme);
    await page.goto(ctx.path);
    await expect(page.getByRole('heading', { name: 'Report a problem in Orbit' })).toBeVisible();
    await expect(page.locator('header img')).toBeVisible();
    // The accent is really applied: the primary button and links take the team's teal.
    const accent = await page.locator('.ds-accented').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
    expect(accent.toLowerCase()).toBe(theme === 'dark' ? '#4fc9de' : '#0b7285');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}80-portal-step1-${theme}.png` });

    await page.getByLabel('What happened?').fill('Card payment fails with a blank error');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Details').fill('I pick a saved card, tap Pay, and get an empty red box. Started this morning.');
    await page.waitForTimeout(450); // past the step's fade-in and the bar filling
    await page.screenshot({ path: `${OUT}81-portal-step2-${theme}.png` });
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Email (optional)').fill('asha@example.com');
    await expect(page.getByText('What the team sees')).toBeVisible();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}82-portal-step3-${theme}.png` });

    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('heading', { name: /Thanks, the Orbit team has your report/ })).toBeFocused();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}83-portal-sent-${theme}.png` });
    await page.context().close();
  });
}

test('portal without branding keeps the Tessera look, and works at 360px', async ({ browser }) => {
  const page = await open(browser, 'dark', { width: 360, height: 780 });
  await page.goto(ctx.plainPath);
  await expect(page.getByRole('heading', { name: /Report a problem in Shop PLAN/ })).toBeVisible();
  expect(await page.locator('.ds-accented').getAttribute('style')).toBeNull();
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await page.screenshot({ path: `${OUT}84-portal-plain-360-dark.png`, fullPage: true });
  await page.context().close();

  const branded = await open(browser, 'light', { width: 360, height: 780 });
  await branded.goto(ctx.path);
  await expect(branded.locator('header img')).toBeVisible();
  await branded.waitForTimeout(400);
  await branded.screenshot({ path: `${OUT}85-portal-brand-360-light.png`, fullPage: true });
  await branded.context().close();
});

test('the brand settings: name, logo and accent with a live preview', async ({ browser }) => {
  const page = await open(browser, 'dark');
  await page.addInitScript((token) => localStorage.setItem('tessera.token', token), ctx.owner.token);
  // Settings shows one group at a time; the address opens the one holding the portal.
  await page.goto(`/projects/${ctx.p.id}/settings#public-bug-report-page`);
  const preview = page.getByRole('group', { name: 'Preview of the page header' });
  await preview.scrollIntoViewIfNeeded();
  await expect(preview.locator('img')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
  // Choosing another colour saves at once and the preview follows.
  await page.getByRole('radio', { name: 'Rose' }).click();
  await expect(page.getByRole('radio', { name: 'Rose' })).toHaveAttribute('aria-checked', 'true');
  const saved = await call('GET', `/projects/${ctx.p.id}/portal`, null, ctx.owner.token);
  expect(saved.portal.brand.accent).toBe('rose');
  await page.waitForTimeout(300);
  await preview.locator('..').screenshot({ path: `${OUT}86-portal-brand-settings-dark.png` });
  await call('PUT', `/projects/${ctx.p.id}/portal`, { brand: { accent: 'teal' } }, ctx.owner.token);
  await page.context().close();
});

test('the portal on a slow mobile connection: small, quick, and nothing moves', async ({ browser }) => {
  const page = await open(browser, 'light', { width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // Chrome's "Slow 4G" profile: 150 ms round trips, 1.6 Mbps down, 750 kbps up; CPU 4x slower.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let bytes = 0;
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
  await page.addInitScript(() => {
    window.__shift = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: 'layout-shift', buffered: true });
    window.__lcp = 0;
    new PerformanceObserver((l) => { const all = l.getEntries(); window.__lcp = all[all.length - 1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const start = Date.now();
  await page.goto(ctx.path);
  await expect(page.getByLabel('What happened?')).toBeVisible({ timeout: 20000 });
  const ready = Date.now() - start;
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  const { shift, lcp } = await page.evaluate(() => ({ shift: window.__shift, lcp: window.__lcp }));
  console.log(`slow 4G + 4x CPU: form usable after ${ready} ms, LCP ${Math.round(lcp)} ms, layout shift ${shift.toFixed(4)}, ${Math.round(bytes / 1024)} KB transferred`);
  expect(shift).toBeLessThan(0.02);
  await page.context().close();
});
