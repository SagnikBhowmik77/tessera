// Records the README's clips and screenshots: real interactions with the built app, in the demo
// project from media/seed.mjs, all set in one frame (a window with a title bar and a soft shadow on
// a quiet brand background), so every image in the README looks like part of one set.
//
//   1. node media/seed.mjs                       the demo API on :8740 (throwaway database)
//   2. cd ../client && npm run build && npm run preview     the built app on :5211 (it forwards
//      the live connection's websocket too, which the audit server does not)
//   3. FFMPEG=path/to/ffmpeg node media/record.mjs [only]                     writes docs/media/
//
// Each clip is an MP4 (for anywhere that plays video) and a GIF (the README shows those inline).
// ffmpeg is free; set FFMPEG if it is not on the PATH. `only` records just the clips or stills
// whose names contain it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const APP = process.env.APP_URL ?? 'http://localhost:5211';
const API = process.env.API_URL ?? 'http://localhost:8740/api';
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const OUT = fileURLToPath(new URL('../../docs/media/', import.meta.url));
const ONLY = process.argv[2] ?? '';
const TMP = mkdtempSync(join(tmpdir(), 'tessera-media-'));
mkdirSync(OUT, { recursive: true });
const { TRACES } = await import(pathToFileURL(fileURLToPath(new URL('../../client/src/landing/samples.js', import.meta.url))).href);

// ---------- the frame ----------
const W = 1600; const H = 1000; // the whole picture
const VW = 1280; const VH = 800; // the browser window's content (what is recorded)
const BAR = 40; // the window's title bar
const X = (W - VW) / 2; const Y = (H - VH - BAR) / 2 + BAR; // where the content sits

const frameHtml = (label) => `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; }
  body {
    background: #0c0b12;
    background-image:
      radial-gradient(60% 70% at 8% 0%, rgb(247 178 59 / 0.16), transparent 60%),
      radial-gradient(55% 60% at 100% 100%, rgb(139 108 246 / 0.22), transparent 60%),
      radial-gradient(40% 45% at 75% 0%, rgb(242 85 125 / 0.10), transparent 60%);
    font: 500 13px/1 system-ui, 'Segoe UI', sans-serif;
  }
  .win {
    position: absolute; left: ${X - 1}px; top: ${Y - BAR - 1}px; width: ${VW}px; height: ${VH + BAR}px;
    border: 1px solid rgb(255 255 255 / 0.09); border-radius: 14px; background: #121119; overflow: hidden;
    box-shadow: 0 50px 100px -30px rgb(0 0 0 / 0.75), 0 24px 48px -24px rgb(0 0 0 / 0.6);
  }
  .bar { height: ${BAR}px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #17161f; border-bottom: 1px solid rgb(255 255 255 / 0.06); }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #34323f; }
  .url { margin: 0 auto; transform: translateX(-30px); padding: 6px 14px; border-radius: 8px; background: #0f0e15; color: #a19fae; letter-spacing: 0.01em; }
</style></head><body><div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">${label}</span></div></div></body></html>`;

// The content's shape: square under the title bar, rounded at the bottom like the window.
const maskHtml = `<!doctype html><html><body style="margin:0;background:#000;width:${VW}px;height:${VH}px">
  <div style="width:${VW}px;height:${VH}px;background:#fff;border-radius:0 0 13px 13px"></div></body></html>`;

let browser;
async function still(html, w, h, file) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(html);
  await page.screenshot({ path: file });
  await page.close();
}
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

// Records a page with Chrome's own screencast (frames arrive when something changes, each with its
// time), then joins them into a video with ffmpeg, every frame held until the next one came.
async function startTape(page) {
  const cdp = await page.context().newCDPSession(page);
  const dir = mkdtempSync(join(TMP, 'tape-'));
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`).replaceAll('\\', '/');
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VW, maxHeight: VH });
  return {
    async stop() {
      await cdp.send('Page.stopScreencast');
      const end = Date.now() / 1000;
      console.log(`  ${frames.length} frames over ${(end - frames[0].t).toFixed(1)} s`);
      const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? end) - f.t).toFixed(3)}`);
      list.push(`file '${frames.at(-1).file}'`);
      const txt = join(dir, 'frames.txt');
      writeFileSync(txt, list.join('\n'));
      const out = join(dir, 'tape.mp4');
      ff(['-f', 'concat', '-safe', '0', '-i', txt, '-vf', `scale=${VW}:${VH},fps=30`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', out]);
      return { file: out, seconds: end - frames[0].t };
    },
  };
}

// Sets a recording (mp4, `seconds` long) or a screenshot (png) into the frame. The frame and the
// mask are still images looped for the length of the recording.
async function compose(input, name, label, { seconds = 0 } = {}) {
  const bg = join(TMP, `${name}-frame.png`);
  const mask = join(TMP, 'mask.png');
  await still(frameHtml(label), W, H, bg);
  await still(maskHtml, VW, VH, mask);
  const isVideo = !input.endsWith('.png');
  const graph = `[1:v]scale=${VW}:${VH},format=rgba[v];[2:v]format=gray[m];[v][m]alphamerge[vm];[0:v][vm]overlay=${X}:${Y}${isVideo ? ':shortest=1' : ''}`;
  if (!isVideo) {
    ff(['-i', bg, '-i', input, '-i', mask, '-filter_complex', graph, '-frames:v', '1', join(OUT, `${name}.png`)]);
    return;
  }
  const mp4 = join(OUT, `${name}.mp4`);
  ff([
    '-loop', '1', '-i', bg, '-i', input, '-loop', '1', '-i', mask,
    '-filter_complex', `${graph},format=yuv420p`, '-t', seconds.toFixed(2), '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', '-an', mp4,
  ]);
  // The README's inline version: smaller and at 12 frames a second, with a palette made for it.
  ff(['-i', mp4, '-filter_complex', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', join(OUT, `${name}.gif`)]);
}

// ---------- the app ----------
async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}
const signIn = (email, password) => call('POST', '/auth/login', { email, password });
const owner = await signIn('seed.owner@example.com', 'seed-pass-1234-xyz');
const mate = await signIn('seed.mate@example.com', 'seed-pass-1234-abc');
const project = (await call('GET', '/projects', null, owner.token)).projects[0];
const board = `/projects/${project.id}`;

// Playwright's recordings have no mouse pointer; this draws one that follows the real pointer.
const POINTER = () => {
  addEventListener('DOMContentLoaded', () => {
    const p = document.createElement('div');
    p.setAttribute('aria-hidden', 'true');
    p.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:18px;height:18px;transform:translate(-100px,-100px)';
    p.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18"><path d="M2 1.5v13l3.6-3.3 2.3 5.3 2.3-1-2.3-5.2H13z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    document.body.append(p);
    addEventListener('pointermove', (e) => { p.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 1}px)`; }, { passive: true });
    addEventListener('pointerdown', () => { p.style.scale = '0.85'; });
    addEventListener('pointerup', () => { p.style.scale = '1'; });
  });
};

async function session({ who = null, theme = 'dark', via = browser } = {}) {
  const context = await via.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, colorScheme: theme });
  await context.addInitScript(([th, t, uid]) => {
    localStorage.setItem('tessera.theme', th);
    if (t) localStorage.setItem('tessera.token', t);
    // The demo accounts are unconfirmed; their "confirm your email" note is closed, as a person would.
    if (uid) localStorage.setItem(`tessera.verifyNote.${uid}`, String(Date.now() + 86_400_000));
  }, [theme, who?.token ?? null, who?.user?.id ?? null]);
  await context.addInitScript(POINTER);
  const page = await context.newPage();
  return { context, page };
}
const pause = (page, ms) => page.waitForTimeout(ms);
// Glides the pointer to an element and clicks it, as a person would.
async function press(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await pause(page, 180);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
// Stops recording and closes the window; returns the video file.
async function finish(rec, tape) {
  const tapeOut = await tape.stop();
  await rec.context.close();
  return tapeOut;
}
const wanted = (name) => !ONLY || name.includes(ONLY);

// ---------- the clips ----------
const CLIPS = {
  // 1. Paste a stack trace: secrets are removed and the trace is read before the bug is made.
  'paste-a-stack-trace': async () => {
    const rec = await session({ who: owner });
    await rec.page.goto(APP + board);
    const add = rec.page.getByRole('button', { name: /^New ticket(?! in)/ });
    await add.waitFor();
    await pause(rec.page, 600);
    const tape = await startTape(rec.page);
    await press(rec.page, add);
    await press(rec.page, rec.page.getByRole('tab', { name: 'Paste an error' }).or(rec.page.getByRole('button', { name: 'Paste an error' })).first());
    await pause(rec.page, 400);
    await rec.page.getByLabel('Error or stack trace').fill(TRACES[0].text);
    await rec.page.getByText(/Removed before saving/).waitFor();
    await pause(rec.page, 2600);
    await press(rec.page, rec.page.getByRole('button', { name: 'Create bug from error' }));
    await rec.page.getByRole('dialog').filter({ hasText: 'Cannot read properties' }).first().waitFor();
    await pause(rec.page, 3000);
    return { ...(await finish(rec, tape)), label: 'Orbit Checkout · New ticket' };
  },

  // 2. Time travel: the board as it was, scrubbed back a week at a time.
  'time-travel': async () => {
    const rec = await session({ who: owner });
    await rec.page.goto(APP + board);
    const travel = rec.page.getByRole('button', { name: 'Time travel' });
    await travel.waitFor();
    await pause(rec.page, 800);
    const tape = await startTape(rec.page);
    await press(rec.page, travel);
    const slider = rec.page.getByRole('slider', { name: 'Day to show' });
    await slider.waitFor();
    await pause(rec.page, 1200);
    await slider.focus();
    for (let i = 0; i < 5; i += 1) { await slider.press('PageDown'); await pause(rec.page, 900); }
    await pause(rec.page, 800);
    for (let i = 0; i < 2; i += 1) { await slider.press('PageUp'); await pause(rec.page, 900); }
    await pause(rec.page, 1200);
    return { ...(await finish(rec, tape)), label: 'Orbit Checkout · The board as it was' };
  },

  // 3. Live: a teammate picks up a card and moves it; it is held, then moves and glows here.
  live: async () => {
    const rec = await session({ who: owner });
    // Ravi gets his own browser: Chrome stops sending screencast frames for a page once another page
    // in the same browser takes focus, and his card has to take focus to be picked up.
    const elsewhere = await chromium.launch({ channel: 'chrome' });
    const them = await session({ who: mate, via: elsewhere });
    await Promise.all([rec.page.goto(APP + board), them.page.goto(APP + board)]);
    await Promise.all([rec.page.waitForLoadState('networkidle'), them.page.waitForLoadState('networkidle')]);
    await pause(rec.page, 1200);
    const tape = await startTape(rec.page);
    // A card from In Review, moved on to Done (In Progress is over its WIP limit, so a move into it
    // would rightly be refused).
    const review = project.statuses.find((s) => s.name === 'In Review').key;
    const { tickets } = await call('GET', `${board}/tickets?status=${review}&sort=rank&limit=5`, null, owner.token);
    const key = tickets[0].key ?? `${project.key}-${tickets[0].number}`;
    await pause(rec.page, 800);
    await them.page.getByRole('button', { name: new RegExp(`\\b${key}\\b`) }).first().focus();
    await them.page.keyboard.press('Space');
    await pause(rec.page, 1800);
    await them.page.keyboard.press('ArrowRight');
    await pause(rec.page, 400);
    await them.page.keyboard.press('Space');
    await pause(rec.page, 2600);
    const moved = await call('GET', `${board}/tickets/${key.split('-').pop()}`, null, owner.token);
    console.log(`  ${key} is now in ${moved.ticket.status}`);
    await elsewhere.close();
    return { ...(await finish(rec, tape)), label: 'Orbit Checkout · Board (Ravi is moving a card)' };
  },

  // 4. Outside-in: someone without an account reports a problem and gets a private tracking page.
  'report-a-problem': async () => {
    const { portal } = await call('GET', `${board}/portal`, null, owner.token);
    const path = new URL(portal.url).pathname;
    const rec = await session({ theme: 'light' });
    await rec.page.goto(APP + path);
    const what = rec.page.getByLabel('What happened?');
    await what.waitFor();
    await pause(rec.page, 700);
    const tape = await startTape(rec.page);
    await press(rec.page, what);
    await what.pressSequentially('The pay button spins forever on my phone', { delay: 35 });
    await press(rec.page, rec.page.getByRole('button', { name: 'Next' }));
    await rec.page.getByLabel('Details').pressSequentially('I tap Pay, the spinner never stops, and nothing is charged.', { delay: 22 });
    await press(rec.page, rec.page.getByRole('button', { name: 'Next' }));
    await rec.page.getByLabel('Email (optional)').pressSequentially('reporter@example.com', { delay: 30 });
    await pause(rec.page, 500);
    await press(rec.page, rec.page.getByRole('button', { name: 'Send report' }));
    await rec.page.getByText('Your reference is').waitFor();
    await pause(rec.page, 2000);
    await press(rec.page, rec.page.getByRole('link', { name: 'Follow your report' }));
    await rec.page.getByRole('heading', { name: /spins forever/ }).waitFor();
    await pause(rec.page, 2600);
    return { ...(await finish(rec, tape)), label: 'Report a problem · Orbit Checkout' };
  },
};

// ---------- the stills ----------
const STILLS = {
  'board-dark': { path: board, theme: 'dark', label: 'Orbit Checkout · Board', ready: (p) => p.getByRole('button', { name: 'Time travel' }) },
  'analytics-light': { path: `${board}/analytics`, theme: 'light', label: 'Orbit Checkout · Analytics', ready: (p) => p.locator('.recharts-area').first() },
  'flow-dark': { path: `${board}/flow`, theme: 'dark', label: 'Orbit Checkout · Flow', ready: (p) => p.locator('main h1').first() },
  'landing-dark': { path: '/tour', theme: 'dark', label: 'Tessera', ready: (p) => p.locator('h1') },
};

browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [name, run] of Object.entries(CLIPS)) {
    if (!wanted(name)) continue;
    const { file, seconds, label } = await run();
    await compose(file, name, label, { seconds });
    console.log('clip', name);
  }
  for (const [name, s] of Object.entries(STILLS)) {
    if (!wanted(name)) continue;
    const rec = await session({ who: owner, theme: s.theme });
    await rec.page.goto(APP + s.path);
    await s.ready(rec.page).waitFor({ timeout: 20000 });
    await pause(rec.page, 1800);
    const shot = join(TMP, `${name}.png`);
    await rec.page.screenshot({ path: shot });
    await rec.context.close();
    await compose(shot, name, s.label);
    console.log('still', name);
  }
} finally {
  await browser.close();
  rmSync(TMP, { recursive: true, force: true });
}
