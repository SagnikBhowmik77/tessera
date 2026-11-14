// Screenshots the hidden /styleguide page (dark + light, desktop + phone, plus open states) from
// the built client. Run from e2e/ after `npm run build` in client/: node visual/shoot-styleguide.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const client = fileURLToPath(new URL('../../client/', import.meta.url));
const out = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(out, { recursive: true });
const PORT = 5213;
const base = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { cwd: client, stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ channel: 'chrome' });
  const problems = [];
  for (const theme of ['dark', 'light']) {
    for (const [device, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
      await context.addInitScript((t) => localStorage.setItem('tessera.theme', t), theme);
      const page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`${theme} ${device}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${theme} ${device}: ${m.text()}`); });
      await page.goto(`${base}/styleguide`);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(900);
      const name = `styleguide-${theme}-${device}`;
      await page.screenshot({ path: `${out}${name}.png`, fullPage: true });
      // Nothing should scroll sideways.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${theme} ${device}: page is ${overflow}px wider than the screen`);
      if (device === 'desktop') {
        // Open states: the select menu, the dialog, and keyboard focus on the tabs.
        await page.getByRole('combobox').first().click();
        await page.waitForTimeout(300);
        await page.locator('#components h3', { hasText: 'Fields' }).locator('..').screenshot({ path: `${out}${name}-select.png` });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Open a dialog' }).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}${name}-dialog.png` });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await page.getByRole('tab', { name: 'Board' }).focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(400);
        await page.locator('#components h3', { hasText: 'Tabs' }).locator('..').screenshot({ path: `${out}${name}-tabs-focus.png` });
      }
      await context.close();
    }
  }
  await browser.close();
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors, no sideways overflow');
} finally {
  server.kill();
}
