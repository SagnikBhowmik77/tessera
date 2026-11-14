import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { call, person, project } from '../tests/api.js';

// The cinematic layer, checked rather than assumed: the live window starts and stays inside a
// 60 fps budget while the cursor moves and a click ripples; reduced motion and low-power devices
// get the still picture; no video is asked for while no clip files exist; and captures of each
// surface it appears on.
const OUT = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });

let ctx;
test.beforeAll(async () => {
  const owner = await person('Ananya Chatterjee');
  const p = await project(owner, 'GLAS');
  const portal = (await call('PUT', `/projects/${p.id}/portal`, { enabled: true, intro: 'Found a problem? Tell us what happened.' }, owner.token)).portal;
  const invite = await call('POST', `/projects/${p.id}/invites`, { email: 'someone.new@example.com', role: 'developer' }, owner.token);
  const empty = await project(owner, 'VOID');
  ctx = { owner, portal: new URL(portal.url).pathname, invite: new URL(invite.acceptUrl).pathname, empty };
});

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; };

test('live window: starts, answers the cursor, stays inside the frame budget', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const media = [];
  page.on('request', (r) => { if (/\.(mp4|webm)(\?|$)/.test(r.url())) media.push(r.url()); });
  await page.goto('/login');
  const hero = page.locator('[data-mosaic]').first();
  await expect(hero).toHaveAttribute('data-mosaic', 'live', { timeout: 8000 });
  // Sweep the cursor across the window for two seconds, then click to send a ripple.
  const box = await hero.boundingBox();
  for (let i = 0; i <= 120; i += 1) {
    const a = (i / 120) * Math.PI * 4;
    await page.mouse.move(box.x + box.width * (0.5 + 0.35 * Math.cos(a)), box.y + box.height * (0.5 + 0.35 * Math.sin(a)));
    await page.waitForTimeout(16);
  }
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}50-login-live-dark-desktop.png` });
  const s = await page.evaluate(() => window.__tesseraMosaic);
  const report = { mode: s.mode, frames: s.frames, frameMedianMs: +median(s.frame).toFixed(2), frameP95Ms: +p95(s.frame).toFixed(2), drawMedianMs: +median(s.draw).toFixed(2), drawP95Ms: +p95(s.draw).toFixed(2) };
  console.log('mosaic', JSON.stringify(report));
  expect(s.mode).toBe('live');
  // Drawing a frame must leave most of the 16.7 ms budget free.
  expect(report.drawP95Ms).toBeLessThan(6);
  // And frames should actually arrive at about 60 per second.
  expect(report.frameMedianMs).toBeLessThan(20);
  expect(media).toEqual([]);
  await context.close();
});

test('still picture for reduced motion and low-power devices', async ({ browser }) => {
  for (const [label, opts, init] of [
    ['reduced motion', { reducedMotion: 'reduce' }, null],
    ['low power', {}, () => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 })],
    ['data saver', {}, () => Object.defineProperty(navigator, 'connection', { get: () => ({ saveData: true }) })],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    await page.goto('/login');
    await page.waitForTimeout(1200);
    const mode = await page.locator('[data-mosaic]').first().getAttribute('data-mosaic');
    const canvases = await page.locator('canvas').count();
    console.log(label, '->', mode, `(${canvases} canvas)`);
    expect(mode).toBe('static');
    expect(canvases).toBe(0);
    await context.close();
  }
});

test('captures: login, register, invite, report page, empty state, 404', async ({ browser }) => {
  const shots = [
    ['51-register', '/register', {}],
    ['52-invite', ctx.invite, {}],
    ['53-portal', ctx.portal, {}],
    ['54-not-found', '/no/such/page', {}],
    ['55-empty-tilt', `/projects/${ctx.empty.id}`, { signedIn: true, tilt: true }],
  ];
  for (const theme of ['dark', 'light']) {
    for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
      const context = await browser.newContext({ viewport, colorScheme: theme });
      await context.addInitScript((th) => localStorage.setItem('tessera.theme', th), theme);
      for (const [name, path, opt] of shots) {
        const page = await context.newPage();
        if (opt.signedIn) await page.addInitScript((token) => localStorage.setItem('tessera.token', token), ctx.owner.token);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);
        const hero = page.locator('[data-mosaic]').first();
        if (await hero.count() && await hero.isVisible()) {
          const b = await hero.boundingBox();
          await page.mouse.move(b.x + b.width * 0.35, b.y + b.height * 0.5);
          await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.55, { steps: 12 });
          await page.waitForTimeout(400);
        }
        if (opt.tilt && device === 'desktop') {
          const grid = page.locator('.ds-tilt').first();
          const b = await grid.boundingBox();
          await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.2, { steps: 8 });
          await page.waitForTimeout(500);
        }
        await page.screenshot({ path: `${OUT}${name}-${theme}-${device}.png` });
        await page.close();
      }
      await context.close();
    }
  }
});

test('no layout shift on the pages with the window', async ({ browser }) => {
  for (const path of ['/login', '/register', ctx.portal, ctx.invite, '/no/such/page']) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(() => {
        window.__cls = 0;
        new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      });
      const page = await context.newPage();
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2500);
      const cls = await page.evaluate(() => window.__cls);
      console.log('CLS', path.slice(0, 24).padEnd(24), viewport.width, cls.toFixed(4));
      expect(cls).toBeLessThan(0.01);
      await context.close();
    }
  }
});

test('frame cost on a slower device (CPU slowed 6x)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto('/login');
  await expect(page.locator('[data-mosaic]').first()).toHaveAttribute('data-mosaic', 'live', { timeout: 8000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const box = await page.locator('[data-mosaic]').first().boundingBox();
  for (let i = 0; i <= 90; i += 1) {
    const a = (i / 90) * Math.PI * 4;
    await page.mouse.move(box.x + box.width * (0.5 + 0.35 * Math.cos(a)), box.y + box.height * (0.5 + 0.35 * Math.sin(a)));
  }
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => window.__tesseraMosaic);
  const report = { mode: s.mode, drawMedianMs: +median(s.draw).toFixed(2), drawP95Ms: +p95(s.draw).toFixed(2), frameMedianMs: +median(s.frame).toFixed(2) };
  console.log('slow device', JSON.stringify(report));
  expect(report.drawP95Ms).toBeLessThan(8);
  await context.close();
});
