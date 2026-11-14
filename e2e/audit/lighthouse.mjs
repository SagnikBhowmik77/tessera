// Lighthouse on the front page and the four pages the strict review names (login, public report
// page, board, analytics), in light and dark, with Lighthouse's standard mobile settings (simulated slow 4G and a
// 4x slower CPU). Signs a fresh account up and sets up a real project through the API first.
//   1. API:     npm --prefix ../server run e2e:api -- 8740      (throwaway in-memory database)
//   2. Client:  npm --prefix ../client run build && node audit/serve.mjs 5213
//   3. Audit:   node audit/lighthouse.mjs <label> [http://localhost:5213]
// Reports go to audit/reports/<label>/ (HTML per page and theme, and summary.json).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

const label = process.argv[2] || 'run';
const RUNS = Number(process.env.RUNS) || 3;
const BASE = (process.argv[3] || 'http://localhost:5213').replace(/\/+$/, '');
const OUT = fileURLToPath(new URL(`./reports/${label}/`, import.meta.url));
mkdirSync(OUT, { recursive: true });

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// A small, realistic project: a dozen tickets across the columns, a comment, the portal on.
const stamp = Date.now();
const { token, user } = await call('POST', '/auth/register', { name: 'Audit Person', email: `audit.${stamp}@example.com`, password: `audit-pass-${stamp}` });
const { project } = await call('POST', '/projects', { name: 'Orbit Checkout', key: `A${String(stamp).slice(-4)}` }, token);
const base = `/projects/${project.id}`;
const titles = ['Checkout button does nothing on Safari 17', 'Add Apple Pay to the payment step', 'Coupon field rejects lowercase codes', 'Search results page loads slowly', 'Saved cards list shows expired cards', 'Address autocomplete for PIN codes', 'Order summary misaligned at 360px', 'Retry failed UPI payments once', 'Gift card balance shows NaN', 'Track checkout drop-off by step', 'Remember last used payment method', 'Promo banner covers the pay button'];
for (const [i, title] of titles.entries()) {
  await call('POST', `${base}/tickets`, { title, type: ['bug', 'feature', 'task'][i % 3], priority: ['critical', 'high', 'medium', 'low'][i % 4] }, token);
  if (i % 3 === 1) await call('POST', `${base}/tickets/${i + 1}/move`, { status: 'in_progress' }, token);
  if (i % 4 === 2) await call('POST', `${base}/tickets/${i + 1}/move`, { status: 'done' }, token);
}
await call('POST', `${base}/tickets/1/comments`, { body: 'Seen on iOS too.' }, token);
const portal = (await call('PUT', `${base}/portal`, { enabled: true, intro: 'Something not working? Tell us.' }, token)).portal;

const PAGES = [
  { name: 'landing', path: '/', signedIn: false },
  { name: 'login', path: '/login', signedIn: false },
  { name: 'portal', path: new URL(portal.url).pathname, signedIn: false },
  { name: 'board', path: base, signedIn: true },
  { name: 'analytics', path: `${base}/analytics`, signedIn: true },
];

const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-first-run'] });
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
const summary = [];
try {
  for (const theme of ['light', 'dark']) {
    for (const p of PAGES) {
      // Lighthouse varies from run to run, so each page is measured RUNS times (default 3) and the
      // run with the median Performance score is the one reported (as Lighthouse recommends).
      const runs = [];
      for (let n = 0; n < RUNS; n += 1) {
      const page = await browser.newPage();
      // Every run starts cold, like a first visit: no HTTP cache, no service worker or its caches.
      // (Lighthouse's own storage reset is off so the sign-in token below survives.)
      const cdp = await page.createCDPSession();
      await cdp.send('Network.clearBrowserCache');
      await cdp.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'service_workers,cache_storage' });
      // A signed-in browser holds the token and the last-seen user (what signing in leaves behind).
      await page.evaluateOnNewDocument((t, th, u) => {
        localStorage.clear();
        localStorage.setItem('tessera.theme', th);
        localStorage.setItem('tessera.publicLang', 'en');
        if (t) { localStorage.setItem('tessera.token', t); localStorage.setItem('tessera.user', u); }
      }, p.signedIn ? token : null, theme, JSON.stringify(user));
      const run = await lighthouse(`${BASE}${p.path}`, {
        output: ['html', 'json'], logLevel: 'error', disableStorageReset: true,
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      }, undefined, page);
      const lhr = run.lhr;
      const html = run.report[0];
      const audit = (id) => lhr.audits[id];
      const inCategory = (cat) => lhr.categories[cat].auditRefs.filter((r) => r.weight > 0).map((r) => lhr.audits[r.id]).filter((a) => a.score !== null && a.score < 1);
      const row = {
        page: p.name, theme,
        performance: Math.round(lhr.categories.performance.score * 100),
        accessibility: Math.round(lhr.categories.accessibility.score * 100),
        bestPractices: Math.round(lhr.categories['best-practices'].score * 100),
        seo: Math.round(lhr.categories.seo.score * 100),
        fcp: Math.round(audit('first-contentful-paint').numericValue),
        lcp: Math.round(audit('largest-contentful-paint').numericValue),
        tbt: Math.round(audit('total-blocking-time').numericValue),
        cls: Number(audit('cumulative-layout-shift').numericValue.toFixed(3)),
        si: Math.round(audit('speed-index').numericValue),
        kb: Math.round(audit('total-byte-weight').numericValue / 1024),
        a11yFailures: inCategory('accessibility').map((a) => `${a.id} (${a.details?.items?.length ?? 0})`),
        perfFailures: Object.values(lhr.audits).filter((a) => ['opportunity', 'table'].includes(a.details?.type) && a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative').map((a) => `${a.id}: ${a.displayValue ?? ''}`),
        bpFailures: inCategory('best-practices').map((a) => a.id),
        seoFailures: inCategory('seo').map((a) => a.id),
      };
      runs.push({ row, html });
      await page.close();
      }
      runs.sort((x, y) => x.row.performance - y.row.performance);
      const { row, html } = runs[Math.floor(runs.length / 2)];
      row.performanceRuns = runs.map((r) => r.row.performance);
      writeFileSync(`${OUT}${p.name}-${theme}.html`, html);
      summary.push(row);
      console.log(`${p.name.padEnd(9)} ${theme.padEnd(5)} perf ${String(row.performance).padStart(3)}  a11y ${String(row.accessibility).padStart(3)}  bp ${String(row.bestPractices).padStart(3)}  seo ${String(row.seo).padStart(3)}  | FCP ${row.fcp} LCP ${row.lcp} TBT ${row.tbt} CLS ${row.cls} ${row.kb} KB  (runs ${row.performanceRuns.join("/")})`);
    }
  }
} finally {
  writeFileSync(`${OUT}summary.json`, JSON.stringify(summary, null, 2));
  await browser.disconnect();
  await chrome.kill();
}
