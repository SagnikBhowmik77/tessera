import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { call, person, project } from '../tests/api.js';

// Records each signature moment as a GIF (visual/moments/<name>.gif). Real interactions on the throwaway test database, nothing staged in the
// page itself: a teammate's changes go through the API exactly as another browser's would.
const DIR = fileURLToPath(new URL('./moments/', import.meta.url));
mkdirSync(DIR, { recursive: true });
const SIZE = { width: 1280, height: 760 };

let ctx;
test.beforeAll(async () => {
  const owner = await person('Ananya Chatterjee');
  const p = await project(owner, 'SHOP');
  const base = `/projects/${p.id}`;
  const mate = await person('Ravi Iyer');
  const inv = await call('POST', `${base}/invites`, { email: mate.email, role: 'developer' }, owner.token);
  await call('POST', `/invites/${new URL(inv.acceptUrl).pathname.split('/').pop()}/accept`, {}, mate.token);
  const titles = [
    ['Checkout button does nothing on Safari 17', 'bug', 'critical'], ['Add Apple Pay to the payment step', 'feature', 'high'],
    ['Coupon field rejects lowercase codes', 'bug', 'high'], ['Search results page loads slowly', 'task', 'medium'],
    ['Order confirmation email has a broken image', 'bug', 'medium'], ['Write release notes for 2.4', 'task', 'low'],
  ];
  for (const [title, type, priority] of titles) await call('POST', `${base}/tickets`, { title, type, priority, assigneeId: owner.user.id }, owner.token);
  await call('POST', `${base}/tickets/2/move`, { status: 'in_progress' }, owner.token);
  await call('POST', `${base}/tickets/6/move`, { status: 'done' }, owner.token);
  ctx = { owner, mate, p, base };
});

// One recorded page. Frames come from Chrome's own screencast (no extra download), with their
// timestamps; ffmpeg (already on the machine) turns them into a GIF at their real timing.
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
async function record(browser, name, fn, { colorScheme = 'dark', token = ctx.owner.token } = {}) {
  const frames = `${DIR}frames-${name}/`;
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const context = await browser.newContext({ viewport: SIZE, colorScheme });
  await context.addInitScript(([th, tk]) => { localStorage.setItem('tessera.theme', th); if (tk) localStorage.setItem('tessera.token', tk); }, [colorScheme, token]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const shots = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = `f${String(shots.length).padStart(5, '0')}.jpg`;
    writeFileSync(`${frames}${file}`, Buffer.from(data, 'base64'));
    shots.push({ file, at: metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: SIZE.width, maxHeight: SIZE.height, everyNthFrame: 1 });
  await fn(page, cdp);
  await page.waitForTimeout(300);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await context.close();
  // Each frame is held until the next one arrived (the screencast only sends frames on change).
  const list = shots.map((s, i) => `file '${s.file}'\nduration ${Math.max(0.02, ((shots[i + 1]?.at ?? s.at + 0.5) - s.at)).toFixed(3)}`).join('\n');
  writeFileSync(`${frames}list.txt`, `ffconcat version 1.0\n${list}\nfile '${shots.at(-1).file}'\n`);
  const palette = `${frames}palette.png`;
  const scale = 'fps=20,scale=960:-1:flags=lanczos';
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${frames}list.txt`, '-vf', `${scale},palettegen=stats_mode=diff`, palette]);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${frames}list.txt`, '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a`, `${DIR}${name}.gif`]);
  rmSync(frames, { recursive: true, force: true });
  console.log(name, `${shots.length} frames`);
}

test('1 done: a card dropped into Done settles and lights up', async ({ browser }) => {
  await record(browser, '1-done-settle', async (page) => {
    await page.goto(`/projects/${ctx.p.id}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const card = page.getByRole('button', { name: /\bSHOP-2\b/ });
    await card.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(350);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    await page.keyboard.press('Space');
    await page.waitForTimeout(1400);
    const where = await page.getByRole('button', { name: /\bSHOP-2\b/ }).evaluate((el) => el.closest('section')?.getAttribute('aria-label'));
    expect(where).toBe('Done');
  });
});

test('2 header mosaic: a teammate adds and finishes tickets, the tiles follow', async ({ browser }) => {
  await record(browser, '2-header-mosaic', async (page) => {
    await page.goto(`/projects/${ctx.p.id}/list`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(900);
    const before = await page.locator('header [role="img"]').first().getAttribute('aria-label');
    await call('POST', `${ctx.base}/tickets`, { title: 'Gift card balance not shown at checkout', type: 'bug', priority: 'high' }, ctx.mate.token);
    await page.waitForTimeout(1300);
    await call('POST', `${ctx.base}/tickets/3/move`, { status: 'done' }, ctx.mate.token);
    await page.waitForTimeout(1300);
    await call('POST', `${ctx.base}/tickets/4/move`, { status: 'in_progress' }, ctx.mate.token);
    await page.waitForTimeout(1500);
    const after = await page.locator('header [role="img"]').first().getAttribute('aria-label');
    console.log('mosaic before:', before, '| after:', after);
    expect(after).not.toBe(before);
  });
});

test('3 card into drawer: View Transitions', async ({ browser }) => {
  await record(browser, '3-card-to-drawer', async (page) => {
    await page.goto(`/projects/${ctx.p.id}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    const used = await page.evaluate(() => {
      window.__vt = 0;
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (cb) => { window.__vt += 1; return start(cb); };
      return 'startViewTransition' in document;
    });
    await page.locator('[data-ticket-card="SHOP-1"]').click();
    await page.getByRole('dialog', { name: /SHOP-1/ }).waitFor();
    await page.waitForTimeout(1100);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    await page.locator('[data-ticket-card="SHOP-5"]').click();
    await page.waitForTimeout(1200);
    const n = await page.evaluate(() => window.__vt);
    console.log('view transitions supported:', used, '| transitions run:', n);
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

test('4 key chips: the same chip on every screen', async ({ browser }) => {
  await record(browser, '4-key-chips', async (page) => {
    for (const path of [`/projects/${ctx.p.id}`, `/projects/${ctx.p.id}/list`, '/my-work', `/projects/${ctx.p.id}/flow`, `/projects/${ctx.p.id}/tickets/SHOP-1`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1100);
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('coupon');
    await page.waitForTimeout(1200);
  }, { colorScheme: 'light' });
});

test('5 first load: tiles assemble into the logo', async ({ browser }) => {
  await record(browser, '5-first-load', async (page, cdp) => {
    // A slower CPU, so the app takes about as long to start as on a mid-range phone.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await page.goto('/login');
    await page.waitForTimeout(1200);
  }, { token: null });
});
