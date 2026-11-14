import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../playwright.config.js';

// Screenshots of every main screen (design audit and redesign checks). Same servers as the browser
// tests: the API on a throwaway in-memory database and the built client. Run from e2e/:
//   npx playwright test --config visual/playwright.visual.config.js
// The servers' folders are relative to the config file, and this one sits a folder deeper.
const webServer = base.webServer.map((s) => ({ ...s, cwd: fileURLToPath(new URL(`../${s.cwd}`, import.meta.url)) }));

export default defineConfig({
  ...base,
  webServer,
  testDir: '.',
  testMatch: /(screens|stress|cinematic|moments|live|brand|a11y|preferences)\.spec\.js/,
  timeout: 300_000,
  retries: 0,
  reporter: 'list',
  use: { ...base.use, trace: 'off', screenshot: 'off' },
});
