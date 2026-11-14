import { defineConfig } from '@playwright/test';

// Browser tests (E15). Starts the API on an in-memory database (port 8741) and the built client
// with `vite preview` (port 5212, forwarding /api and Socket.IO to that API), then drives Chrome.
// Locally the installed Chrome is used; in CI, Playwright's own Chromium.
const API_PORT = 8741;
const WEB_PORT = 5212;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node --import ./test/setup.js scripts/e2e-server.mjs',
      cwd: '../server',
      port: API_PORT,
      env: { PORT: String(API_PORT), APP_URL: `http://localhost:${WEB_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${WEB_PORT} --strictPort`,
      cwd: '../client',
      port: WEB_PORT,
      env: { TESSERA_API_PROXY: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
