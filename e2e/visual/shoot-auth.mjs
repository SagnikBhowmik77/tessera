// Screenshots login states the plain screen capture can't reach, from the built client with no API
// running: the "server isn't answering" alert, keyboard focus, and the shown password.
// Run from e2e/ after `npm run build` in client/: node visual/shoot-auth.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const client = fileURLToPath(new URL('../../client/', import.meta.url));
const out = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(out, { recursive: true });
const PORT = 5214;
const base = `http://localhost:${PORT}`;
// The proxy points at a port nothing listens on, so every API call fails like a server that is down.
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: client, stdio: 'ignore', env: { ...process.env, TESSERA_API_PROXY: 'http://localhost:9' },
});
try {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({ channel: 'chrome' });
  const problems = [];
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: theme });
    await context.addInitScript((t) => localStorage.setItem('tessera.theme', t), theme);
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${theme}: ${e.message}`));
    await page.goto(`${base}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await page.getByLabel('Email').fill('riya@example.com');
    await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.getByRole('alert').waitFor();
    const alert = await page.getByRole('alert').innerText();
    if (!alert.includes("isn't answering")) problems.push(`${theme}: alert says "${alert}"`);
    await page.getByLabel('Email').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await page.locator('main').screenshot({ path: `${out}01-login-${theme}-states.png` });
    await context.close();
  }
  await browser.close();
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'ok: honest server-down message, no page errors');
} finally {
  server.kill();
}
