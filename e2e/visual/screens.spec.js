import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { call, person, project } from '../tests/api.js';

// Captures the main screens in dark and light, at desktop and phone size, into visual/screens/.
// The content is test content made here on a throwaway database, deliberately messy (a very long
// title, a Bengali name, many labels), so layouts are judged against real-world input.
const OUT = fileURLToPath(new URL('./screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const SIZES = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

let ctx;
test.beforeAll(async () => {
  const owner = await person('অনন্যা চট্টোপাধ্যায়');
  const p = await project(owner, 'SHOP');
  const base = `/projects/${p.id}`;
  const me = owner.user.id;
  const tickets = [
    { title: 'Checkout button does nothing on Safari 17', type: 'bug', priority: 'critical', labels: ['checkout', 'safari'], assigneeId: me },
    { title: 'Add Apple Pay to the payment step', type: 'feature', priority: 'high', labels: ['payments'], assigneeId: me },
    { title: 'Cart badge shows the wrong count after removing an item from the mini cart while the recommendations carousel is still loading and the network is slow, which happens a lot on mobile data', type: 'bug', priority: 'medium', labels: ['cart', 'mobile', 'performance', 'ux', 'regression', 'needs-repro'] },
    { title: 'Write release notes for 2.4', type: 'task', priority: 'low', labels: ['docs'] },
    { title: 'Coupon field rejects valid codes with lowercase letters', type: 'bug', priority: 'high', labels: ['checkout'], assigneeId: me },
    { title: 'Search results page loads slowly', type: 'task', priority: 'medium', labels: ['performance'] },
    { title: 'Order confirmation email has a broken image', type: 'bug', priority: 'medium', labels: ['email'] },
  ];
  for (const t of tickets) await call('POST', `${base}/tickets`, t, owner.token);
  await call('POST', `${base}/tickets/2/move`, { status: 'in_progress' }, owner.token);
  await call('POST', `${base}/tickets/5/move`, { status: 'in_progress' }, owner.token);
  await call('POST', `${base}/tickets/4/move`, { status: 'done' }, owner.token);
  await call('POST', `${base}/tickets/1/comments`, { body: 'Reproduced on an iPhone 15 with Safari 17.4. Nothing in the console.' }, owner.token);
  const portal = (await call('PUT', `${base}/portal`, { enabled: true, intro: 'Found a problem in our shop? Tell us what happened.' }, owner.token)).portal;
  const report = await fetch(`http://localhost:8741/api/portal/${portal.url.split('/report/')[1]}/reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'I was charged twice for one order', email: 'reporter@example.com', name: 'Riya' }),
  }).then((r) => r.json());
  const empty = await project(owner, 'EMPTY');
  ctx = { owner, p, empty, portalPath: new URL(portal.url).pathname, trackPath: new URL(report.trackUrl).pathname };
});

// ONLY=settings,board captures just the screens whose names contain one of those words.
const only = process.env.ONLY?.split(',');
const screens = () => [
  { name: '01-login', path: '/login', guest: true },
  { name: '02-register', path: '/register', guest: true },
  { name: '03-projects', path: '/projects' },
  { name: '04-board', path: `/projects/${ctx.p.id}` },
  { name: '05-drawer', path: `/projects/${ctx.p.id}/tickets/SHOP-1` },
  { name: '06-list', path: `/projects/${ctx.p.id}/list` },
  { name: '07-analytics', path: `/projects/${ctx.p.id}/analytics`, full: true },
  { name: '08-settings', path: `/projects/${ctx.p.id}/settings`, full: true },
  { name: '09-my-work', path: '/my-work' },
  { name: '10-board-empty', path: `/projects/${ctx.empty.id}` },
  { name: '11-portal', path: ctx.portalPath, guest: true },
  { name: '12-tracking', path: ctx.trackPath, guest: true },
  { name: '13-unknown-url', path: '/this-page-does-not-exist' },
].filter((s) => !only || only.some((w) => s.name.includes(w)));

// Open states of the shell: the project switcher, the "More" views menu, the phone drawer.
test('shell menus', async ({ browser }) => {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: SIZES.desktop, deviceScaleFactor: 1, colorScheme: theme });
    await context.addInitScript(([th, token]) => { localStorage.setItem('tessera.theme', th); localStorage.setItem('tessera.token', token); }, [theme, ctx.owner.token]);
    const page = await context.newPage();
    await page.goto(`/projects/${ctx.p.id}/flow`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /Switch project/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}20-switcher-${theme}-desktop.png`, clip: { x: 256, y: 0, width: 640, height: 360 } });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Flow' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}21-more-${theme}-desktop.png`, clip: { x: 256, y: 0, width: 760, height: 420 } });
    await page.keyboard.press('Escape');
    // The board: the command palette with a search, then the setup steps opened.
    await page.goto(`/projects/${ctx.p.id}`);
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('coupon');
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}23-palette-${theme}-desktop.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show steps' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}24-setup-steps-${theme}-desktop.png`, clip: { x: 256, y: 170, width: 1024, height: 330 } });
    await page.setViewportSize(SIZES.phone);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}22-drawer-${theme}-phone.png` });
    await context.close();
  }
});

for (const theme of ['dark', 'light']) {
  for (const [device, viewport] of Object.entries(SIZES)) {
    test(`${theme} ${device}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
      await context.addInitScript((th) => localStorage.setItem('tessera.theme', th), theme);
      for (const s of screens()) {
        const page = await context.newPage();
        if (!s.guest) await page.addInitScript((token) => localStorage.setItem('tessera.token', token), ctx.owner.token);
        await page.goto(s.path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        // Long pages (analytics) are captured whole, so everything on them gets checked. They
        // scroll inside the app's <main>, not the window, so the window is made as tall as it.
        if (s.full) {
          const extra = await page.evaluate(() => { const m = document.querySelector('#main'); return m ? m.scrollHeight - m.clientHeight : 0; });
          if (extra > 0) { await page.setViewportSize({ width: viewport.width, height: viewport.height + extra }); await page.waitForTimeout(400); }
        }
        await page.screenshot({ path: `${OUT}${s.name}-${theme}-${device}.png` });
        if (s.full) await page.setViewportSize(viewport);
        await page.close();
      }
      await context.close();
    });
  }
}

// Settings: the rail following the reader, the narrow chip strip, and an in-app confirm.
test('settings states', async ({ browser }) => {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: SIZES.desktop, deviceScaleFactor: 1, colorScheme: theme });
    await context.addInitScript(([th, token]) => { localStorage.setItem('tessera.theme', th); localStorage.setItem('tessera.token', token); }, [theme, ctx.owner.token]);
    const page = await context.newPage();
    await page.goto(`/projects/${ctx.p.id}/settings`);
    await page.waitForLoadState('networkidle');
    const rail = page.getByRole('navigation', { name: 'Project settings' }).last();
    await rail.getByRole('link', { name: 'Alerts and webhooks' }).click();
    await page.waitForTimeout(900);
    const current = await rail.locator('[aria-current="true"]').textContent();
    if (current !== 'Alerts and webhooks') throw new Error(`the rail should mark Alerts and webhooks, it marks ${current}`);
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'alerts-and-webhooks') throw new Error(`focus should move to the section, it is on ${focused}`);
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}26-settings-rail-${theme}-desktop.png` });
    await rail.getByRole('link', { name: 'Public bug-report page' }).click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: 'New link' }).first().click();
    await page.waitForTimeout(400);
    const dialog = page.getByRole('dialog', { name: 'Make a new link?' });
    await dialog.waitFor();
    await page.screenshot({ path: `${OUT}27-confirm-${theme}-desktop.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.setViewportSize(SIZES.phone);
    await page.waitForTimeout(300);
    await page.getByRole('navigation', { name: 'Project settings' }).first().getByRole('link', { name: 'Integrations' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}28-settings-strip-${theme}-phone.png` });
    // Settings shows one group at a time: the strip opened Integrations, and nothing else shows.
    if (await page.locator('#github').isHidden()) throw new Error('the strip should open the Integrations group');
    if (await page.locator('#members').isVisible()) throw new Error('only one group should show at a time');
    // The denser blocks one by one at phone width, readable at full size (an address with a
    // section opens its group).
    for (const id of ['members', 'board-columns', 'service-levels-sla', 'source-maps']) {
      await page.goto(`/projects/${ctx.p.id}/settings#${id}`);
      await page.locator(`#${id}`).waitFor();
      await page.waitForTimeout(400);
      await page.locator(`#${id}`).screenshot({ path: `${OUT}29-settings-${id}-${theme}-phone.png` });
    }
    await context.close();
  }
});

// The public pages after someone acts: the thank-you, then their tracking page with a message.
test('portal states', async ({ browser }) => {
  for (const theme of ['dark', 'light']) {
    for (const [device, viewport] of Object.entries(SIZES)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
      await context.addInitScript((th) => localStorage.setItem('tessera.theme', th), theme);
      const page = await context.newPage();
      await page.goto(ctx.portalPath);
      // The report goes in three steps: what happened, the details, how to reach you.
      await page.getByLabel('What happened?').fill('Search finds nothing for café or crème');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByLabel('Details').fill('I typed café in the search box on the home page and got no results.');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByLabel('Email (optional)').fill('reporter@example.com');
      await page.getByRole('button', { name: 'Send report' }).click();
      await page.getByText('Your reference is').waitFor();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}30-portal-sent-${theme}-${device}.png` });
      await page.getByRole('link', { name: 'Follow your report' }).click();
      await page.getByLabel('Add details or ask a question').fill('It also happens with naïve and jalapeño.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByText('It also happens with').first().waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}31-tracking-thread-${theme}-${device}.png`, fullPage: true });
      await context.close();
    }
  }
});

// Empty, missing and failed states, on the project with nothing in it.
test('empty states', async ({ browser }) => {
  const e = `/projects/${ctx.empty.id}`;
  const shots = [
    ['40-not-found-guest', '/this-page-does-not-exist', { guest: true }],
    ['41-project-missing', '/projects/000000000000000000000000'],
    ['42-project-load-failed', `/projects/${ctx.p.id}/list`, { fail: true }],
    ['43-empty-sprints', `${e}/sprints`],
    ['44-empty-together', `${e}/together`],
    ['45-empty-triage', `${e}/triage`],
    ['46-empty-my-work', '/my-work'],
  ];
  for (const theme of ['dark', 'light']) {
    for (const [device, viewport] of Object.entries(SIZES)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
      await context.addInitScript((th) => localStorage.setItem('tessera.theme', th), theme);
      for (const [name, path, opt = {}] of shots) {
        const page = await context.newPage();
        if (!opt.guest) await page.addInitScript((token) => localStorage.setItem('tessera.token', token), ctx.owner.token);
        // A server that answers with an error, to see the "didn't load" screen (not "not found").
        if (opt.fail) await page.route(/\/api\/projects\/[a-f0-9]{24}$/, (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' }));
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(opt.fail ? 4500 : 600);
        await page.screenshot({ path: `${OUT}${name}-${theme}-${device}.png` });
        await page.close();
      }
      await context.close();
    }
  }
  // A column with nothing in it: empty the Done column and look at the slot it shows.
  await call('POST', `/projects/${ctx.p.id}/tickets/4/move`, { status: 'todo' }, ctx.owner.token);
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: SIZES.desktop, deviceScaleFactor: 1, colorScheme: theme });
    await context.addInitScript(([th, token]) => { localStorage.setItem('tessera.theme', th); localStorage.setItem('tessera.token', token); }, [theme, ctx.owner.token]);
    const page = await context.newPage();
    await page.goto(`/projects/${ctx.p.id}`);
    await page.waitForLoadState('networkidle');
    await page.getByText('Nothing here').waitFor();
    await page.screenshot({ path: `${OUT}48-empty-done-column-${theme}-desktop.png` });
    await context.close();
  }
});

// Last, because it changes the data: move a card into Done with the keyboard only, and catch the
// moment its tile is set (the glow).
test('done glow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: SIZES.desktop, deviceScaleFactor: 1, colorScheme: 'dark' });
  await context.addInitScript((token) => { localStorage.setItem('tessera.theme', 'dark'); localStorage.setItem('tessera.token', token); }, ctx.owner.token);
  const page = await context.newPage();
  await page.goto(`/projects/${ctx.p.id}`);
  await page.waitForLoadState('networkidle');
  const card = page.getByRole('button', { name: /\bSHOP-2\b/ });
  await card.focus();
  // What a screen reader hears at each step (dnd-kit's live region).
  const said = () => page.evaluate(() => [...document.querySelectorAll('[id^="DndLiveRegion"]')].map((el) => el.textContent).join(' | '));
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  console.log('after Space:', await said());
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    console.log(`after ArrowRight ${i + 1}:`, await said());
  }
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  const where = await page.getByRole('button', { name: /\bSHOP-2\b/ }).evaluate((el) => el.closest('section')?.getAttribute('aria-label'));
  if (where !== 'Done') throw new Error(`SHOP-2 should be in Done after the keyboard move, it is in ${where}`);
  await page.screenshot({ path: `${OUT}25-done-glow-dark-desktop.png`, clip: { x: 560, y: 280, width: 640, height: 300 } });
  await context.close();
});
