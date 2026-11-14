// Puts a "before" and "after" screenshot of the stress pass side by side, with a caption, so a
// fix can be judged at a glance. Run from e2e/: node visual/compare.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const dir = fileURLToPath(new URL('./stress/', import.meta.url));
const out = `${dir}compare/`;
mkdirSync(out, { recursive: true });
const PAIRS = [
  ['1-header-phone', 'board-dark-360', 'Phone: a long project name pushed the whole project header 261px past the screen on every project page'],
  ['2-projects-phone', 'projects-light-360', 'Phone: project cards ran off the right edge; the grid column could not shrink below the longest name'],
  ['3-flow-long-title', 'flow-dark-1280', 'Flow: an unbroken title ran out of its card, the Work select was cut to "All ope", keys were plain underlined text'],
  ['4-invite-phone', 'invite-light-360', 'Invite on phone: the main button\'s label wrapped onto two lines and overflowed the button'],
  ['5-timeline-empty', 'timeline-light-1920', 'Timeline: the empty message sat on the week stripes with the red today line running through it'],
];
const img = (set, name) => `data:image/png;base64,${readFileSync(`${dir}${set}/${name}.png`).toString('base64')}`;
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [file, name, caption] of PAIRS) {
  const w = Number(name.split('-').pop());
  const scale = w > 1300 ? 0.5 : w > 800 ? 0.6 : 1;
  await page.setViewportSize({ width: Math.round(w * scale * 2 + 72), height: 400 });
  await page.setContent(`<body style="margin:0;padding:24px;background:#16151c;color:#e9e7f2;font:15px system-ui">
    <p style="margin:0 0 14px;max-width:${Math.round(w * scale * 2 + 24)}px">${caption}</p>
    <div style="display:flex;gap:24px;align-items:flex-start">
      ${['before', 'after'].map((s) => `<figure style="margin:0"><figcaption style="margin-bottom:6px;font-weight:600;color:${s === 'before' ? '#ff8f8f' : '#7fe0b4'}">${s}</figcaption><img src="${img(s, name)}" style="width:${Math.round(w * scale)}px;display:block;border:1px solid #333"></figure>`).join('')}
    </div></body>`);
  await page.screenshot({ path: `${out}${file}.png`, fullPage: true });
}
await browser.close();
console.log(`wrote ${PAIRS.length} comparisons to ${out}`);
