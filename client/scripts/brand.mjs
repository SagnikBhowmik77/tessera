// Builds every brand asset from one geometry, so they can never drift apart:
//   public/icon.svg                 favicon (the mark on its dark tile)
//   public/favicon.ico              32 px fallback for old browsers (a PNG inside an .ico)
//   public/brand/mark.svg           the mark alone, transparent
//   public/brand/wordmark-*.svg     mark + "Tessera" for light and dark backgrounds (font embedded)
//   public/icons/*.png              PWA icons (192, 512, maskable 512) and the Apple touch icon
//   public/og.png                   1200 x 630 social preview
// Run from client/:  npm run brand   (needs the e2e folder's Playwright and a local Chrome)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = `${root}public/`;
mkdirSync(`${pub}brand`, { recursive: true });
mkdirSync(`${pub}icons`, { recursive: true });

// ---- The mark: four panes of glass on a 32 grid, lit by one gradient (amber, rose, violet).
// Same geometry as Logo in src/ds/core.jsx and the boot loader in index.html.
const BRAND = { amber: '#F7B23B', rose: '#F2557D', violet: '#8B6CF6', ink: '#0E0D14' };
const PANES = [[2, 2, 14, 11], [18, 2, 12, 17], [2, 15, 14, 15], [18, 21, 12, 9]];
const gradient = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${BRAND.amber}"/><stop offset=".48" stop-color="${BRAND.rose}"/><stop offset="1" stop-color="${BRAND.violet}"/></linearGradient>`;
const panes = (fill) => PANES.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}"/>`).join('');
// A soft highlight along the top of each pane, so the glass catches light.
const sheen = PANES.map(([x, y, w, h]) => `<rect x="${x + 1.2}" y="${y + 1}" width="${w - 2.4}" height="${Math.min(3, h / 3)}" rx="1.5" fill="#fff" opacity=".13"/>`).join('');

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Tessera"><defs>${gradient('g')}</defs>${panes('url(#g)')}${sheen}</svg>\n`;

// The tile: the mark on ink. `inset` is the share of each side left around the mark (maskable
// icons need the mark inside the middle 80%, so they use a bigger inset and a full bleed).
function tileSvg({ size = 64, inset = 0.16, radius = 0.22, bleed = false } = {}) {
  const s = 32 / (1 - 2 * inset); const o = -inset * s; const rx = bleed ? 0 : s * radius;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${o.toFixed(3)} ${o.toFixed(3)} ${s.toFixed(3)} ${s.toFixed(3)}" width="${size}" height="${size}"><defs>${gradient('g')}<radialGradient id="glow" cx=".3" cy=".25" r=".9"><stop offset="0" stop-color="${BRAND.violet}" stop-opacity=".22"/><stop offset="1" stop-color="${BRAND.violet}" stop-opacity="0"/></radialGradient></defs><rect x="${o.toFixed(3)}" y="${o.toFixed(3)}" width="${s.toFixed(3)}" height="${s.toFixed(3)}" rx="${rx.toFixed(3)}" fill="${BRAND.ink}"/><rect x="${o.toFixed(3)}" y="${o.toFixed(3)}" width="${s.toFixed(3)}" height="${s.toFixed(3)}" rx="${rx.toFixed(3)}" fill="url(#glow)"/>${panes('url(#g)')}${sheen}</svg>\n`;
}

// The wordmark: the mark beside "Tessera" in Instrument Serif italic. The font is embedded (one
// small Latin subset), so the SVG looks the same as an <img>, in a README, or offline.
const serif = readFileSync(`${root}node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2`).toString('base64');
const wordmarkSvg = (ink) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 172 40" role="img" aria-label="Tessera"><defs><style>@font-face{font-family:'Tessera Serif';font-style:italic;src:url(data:font/woff2;base64,${serif}) format('woff2')}</style>${gradient('g')}</defs><g transform="translate(2 4)">${panes('url(#g)')}${sheen}</g><text x="44" y="30.5" font-family="'Tessera Serif', 'Instrument Serif', Georgia, serif" font-style="italic" font-size="31" letter-spacing="-.4" fill="${ink}">Tessera</text></svg>\n`;

writeFileSync(`${pub}brand/mark.svg`, markSvg);
writeFileSync(`${pub}icon.svg`, tileSvg({ size: 64, inset: 0.15 }));
writeFileSync(`${pub}brand/wordmark-light.svg`, wordmarkSvg('#17161D'));
writeFileSync(`${pub}brand/wordmark-dark.svg`, wordmarkSvg('#EDEDF2'));

// ---- The social preview: ink canvas, a stained-glass window on the right (panes split from one
// seed, coloured by where they sit along the brand gradient), the wordmark and one honest line.
function windowPanes(seed, w, h) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  const split = (x, y, pw, ph, depth) => {
    if (depth > 4 || (pw * ph < 5200 && depth > 2) || rnd() < 0.08 * depth) { out.push({ x, y, w: pw, h: ph, r: rnd() }); return; }
    const c = (pw > ph ? pw : ph) * (0.32 + rnd() * 0.36);
    if (pw > ph) { split(x, y, c, ph, depth + 1); split(x + c, y, pw - c, ph, depth + 1); } else { split(x, y, pw, c, depth + 1); split(x, y + c, pw, ph - c, depth + 1); }
  };
  split(0, 0, w, h, 0);
  return out;
}
const mix = (a, b, t) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('')}`;
const glass = (t) => (t < 0.48 ? mix(BRAND.amber, BRAND.rose, t / 0.48) : mix(BRAND.rose, BRAND.violet, (t - 0.48) / 0.52));
const WIN = { x: 650, y: 70, w: 480, h: 490 };
const win = windowPanes(11, WIN.w, WIN.h).map((p) => {
  const t = Math.min(1, ((p.x + p.w / 2) / WIN.w) * 0.55 + ((p.y + p.h / 2) / WIN.h) * 0.45);
  const clear = p.r < 0.12;
  return `<rect x="${(WIN.x + p.x + 3).toFixed(1)}" y="${(WIN.y + p.y + 3).toFixed(1)}" width="${(p.w - 6).toFixed(1)}" height="${(p.h - 6).toFixed(1)}" rx="7" fill="${clear ? 'none' : glass(t)}" fill-opacity="${(0.3 + p.r * 0.7).toFixed(2)}"${clear ? ' stroke="rgba(255,255,255,.16)" stroke-dasharray="6 5" stroke-width="1.5"' : ''}/>`;
}).join('');
// Fonts go in as data URLs: a page set from a string can't read files from disk.
const fontUrl = (f) => `data:font/woff2;base64,${readFileSync(`${root}node_modules/${f}`).toString('base64')}`;
const ogHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Serif;font-style:italic;src:url(${fontUrl('@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2')})}
@font-face{font-family:Geist;font-weight:100 900;src:url(${fontUrl('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')})}
html,body{margin:0;width:1200px;height:630px;background:${BRAND.ink};overflow:hidden}
.c{position:absolute;inset:0;background:radial-gradient(700px 500px at 82% 40%,rgba(139,108,246,.22),transparent 70%),radial-gradient(600px 400px at 70% 90%,rgba(242,85,125,.14),transparent 70%)}
.t{position:absolute;left:84px;top:150px;width:540px;font-family:Geist;color:#EDEDF2}
.w{display:flex;align-items:center;gap:22px;font-family:Serif;font-style:italic;font-size:104px;letter-spacing:-2px;line-height:1}
.h{margin-top:40px;font-size:35px;text-wrap:balance;font-weight:600;letter-spacing:-.6px;line-height:1.15}
.s{margin-top:18px;font-size:23px;color:#A3A3B2;line-height:1.4}
.u{position:absolute;left:84px;bottom:58px;font-family:Geist;font-size:20px;color:#8A8A9A;letter-spacing:.2px}
</style></head><body><div class="c"></div>
<svg width="1200" height="630" style="position:absolute;inset:0">${win}</svg>
<div class="t"><div class="w"><svg width="92" height="92" viewBox="0 0 32 32"><defs>${gradient('g')}</defs>${panes('url(#g)')}${sheen}</svg>Tessera</div>
<div class="h">Issue tracking for teams who ship.</div>
<div class="s">Boards, bug intelligence, flow analytics and live collaboration, in one window.</div></div>
<div class="u">Free and open source</div></body></html>`;

// ---- Render the PNGs in Chrome (the same Playwright the browser tests use).
const req = createRequire(`${root}../e2e/package.json`);
const pw = await import(pathToFileURL(req.resolve('@playwright/test')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  return page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await png(tileSvg({ inset: 0.15 }), 192, `${pub}icons/icon-192.png`);
await png(tileSvg({ inset: 0.15 }), 512, `${pub}icons/icon-512.png`);
await png(tileSvg({ inset: 0.24, bleed: true }), 512, `${pub}icons/maskable-512.png`);
await png(tileSvg({ inset: 0.17, bleed: true }), 180, `${pub}icons/apple-touch-icon.png`);
const ico32 = await png(tileSvg({ inset: 0.1 }), 32, `${pub}icons/favicon-32.png`);
// An .ico that simply wraps the 32 px PNG (read by every browser that still asks for one).
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head.writeUInt8(32, 6); head.writeUInt8(32, 7); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(ico32.length, 14); head.writeUInt32LE(22, 18);
writeFileSync(`${pub}favicon.ico`, Buffer.concat([head, ico32]));

await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(ogHtml);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: `${pub}og.png` });
await browser.close();
// Chrome's PNGs are not compressed hard. With FFMPEG pointing at ffmpeg, each is re-encoded to a
// 256-colour palette with light dithering: the same picture at a third to a half of the size.
if (process.env.FFMPEG) {
  for (const f of ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'og.png']) {
    const file = `${pub}${f}`;
    const tmp = `${file}.tmp.png`;
    execFileSync(process.env.FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', 'split[a][b];[a]palettegen=max_colors=256:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a', '-compression_level', '100', tmp]);
    renameSync(tmp, file);
  }
}
console.log('brand assets written to public/');
