// What a page downloads on a cold visit, largest first (compressed sizes), through the audit server.
//   node audit/weigh.mjs <path> [token]
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = req('@playwright/test');
const [path, token] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext();
if (token) await ctx.addInitScript((t) => localStorage.setItem('tessera.token', t), token);
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
const urls = new Map(); const rows = [];
cdp.on('Network.responseReceived', (e) => urls.set(e.requestId, e.response.url));
cdp.on('Network.loadingFinished', (e) => rows.push([e.encodedDataLength, (urls.get(e.requestId) || '').replace(/^https?:\/\/[^/]+/, '')]));
// The path may come without its leading slash (Git Bash rewrites "/x" into a Windows path).
await page.goto(`http://localhost:5213/${path.replace(/^\/+/, '')}`);
await page.waitForTimeout(4000);
rows.sort((a, b) => b[0] - a[0]);
console.log(rows.slice(0, 25).map(([b, u]) => `${String(Math.round(b / 1024)).padStart(4)} KB  ${u}`).join('\n'));
console.log(`total ${Math.round(rows.reduce((s, r) => s + r[0], 0) / 1024)} KB in ${rows.length} requests`);
await browser.close();
