// Screenshots the redesign direction mockups in design/directions/ (run from e2e/:
// node visual/shoot-directions.mjs). Uses the installed Chrome.
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const dir = new URL('../../design/directions/', import.meta.url);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const f of ['a-stained-glass', 'b-terrazzo', 'c-signal']) {
  await page.goto(new URL(`${f}.html`, dir).href);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: fileURLToPath(new URL(`${f}.png`, dir)), fullPage: true });
}
await browser.close();
console.log('shot');
