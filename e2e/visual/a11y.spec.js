import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { call, person, project } from '../tests/api.js';

// The strict review's accessibility pass: axe (every WCAG 2.0/2.1/2.2 A and AA rule) on the four
// named pages and the states inside them that matter (each portal step, the ticket drawer, a chart
// switched to its table), in light and dark. Then the keyboard: every element Tab reaches shows a
// focus ring. AXE_REPORT=<label> writes the findings to audit/reports/<label>/axe.json.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const label = process.env.AXE_REPORT;

let ctx;
test.beforeAll(async () => {
  const owner = await person('Nandini Rao');
  const p = await project(owner, 'AXE');
  const base = `/projects/${p.id}`;
  for (const [i, title] of ['Checkout button does nothing on Safari 17', 'Add Apple Pay to the payment step', 'Coupon field rejects lowercase codes', 'Search results page loads slowly', 'Gift card balance shows NaN', 'Promo banner covers the pay button'].entries()) {
    await call('POST', `${base}/tickets`, { title, type: ['bug', 'feature', 'task'][i % 3], priority: ['critical', 'high', 'medium', 'low'][i % 4], labels: i % 2 ? ['payments'] : [] }, owner.token);
  }
  await call('POST', `${base}/tickets/2/move`, { status: 'in_progress' }, owner.token);
  await call('POST', `${base}/tickets/3/move`, { status: 'done' }, owner.token);
  await call('POST', `${base}/tickets/1/comments`, { body: 'Seen on iOS too.' }, owner.token);
  const portal = (await call('PUT', `${base}/portal`, { enabled: true, intro: 'Something not working? Tell us.' }, owner.token)).portal;
  ctx = { owner, p, base, portalPath: new URL(portal.url).pathname };
});

async function open(browser, theme, signedIn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript(([th, token]) => {
    localStorage.setItem('tessera.theme', th);
    localStorage.setItem('tessera.publicLang', 'en');
    if (token) localStorage.setItem('tessera.token', token);
  }, [theme, signedIn ? ctx.owner.token : null]);
  return context.newPage();
}

const findings = [];
async function scan(page, where, theme) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of violations) {
    findings.push({ where, theme, rule: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')), why: v.nodes[0]?.failureSummary?.split('\n').slice(0, 3).join(' ') });
  }
  console.log(`${where.padEnd(28)} ${theme.padEnd(5)} ${violations.length ? violations.map((v) => `${v.id}×${v.nodes.length}`).join(', ') : 'no violations'}`);
  for (const v of violations) console.log(`   ${v.id}: ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}`);
  // A guard from now on: any new violation fails the run (and is listed above and in the report).
  expect.soft(violations.map((v) => `${where}: ${v.id}`)).toEqual([]);
}

for (const theme of ['light', 'dark']) {
  test(`axe, WCAG 2.2 AA, every page and state (${theme})`, async ({ browser }) => {
    const out = await open(browser, theme, false);
    // The front page, with every demo loaded, then with the demos in use.
    await out.goto('/');
    await expect(out.locator('h1')).toBeVisible();
    for (const id of ['bugs', 'flow', 'live', 'outside']) {
      await out.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(out.locator(`#${id} figure`)).toBeVisible();
    }
    await scan(out, 'landing', theme);
    const demo = out.locator('#outside figure');
    await demo.getByLabel('What happened?').fill('The pay button does nothing');
    await demo.getByRole('button', { name: 'Send report' }).click();
    await demo.getByRole('button', { name: 'Accept' }).click();
    await out.locator('#live figure').getByRole('region', { name: "Asha's screen" }).getByRole('button', { name: 'Move ORB-12 on' }).click();
    await out.waitForTimeout(500);
    await scan(out, 'landing (demos in use)', theme);
    await out.goto('/login');
    await expect(out.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await scan(out, 'login', theme);
    await out.goto(ctx.portalPath);
    await expect(out.getByLabel('What happened?')).toBeVisible();
    await scan(out, 'portal step 1', theme);
    await out.getByRole('button', { name: 'Next' }).click();
    await scan(out, 'portal step 1 (title error)', theme);
    await out.getByLabel('What happened?').fill('The pay button spins forever');
    await out.getByRole('button', { name: 'Next' }).click();
    await scan(out, 'portal step 2', theme);
    await out.getByRole('button', { name: 'Next' }).click();
    await scan(out, 'portal step 3', theme);
    await out.getByRole('button', { name: 'Send report' }).click();
    await expect(out.getByText('Your reference is')).toBeVisible();
    await scan(out, 'portal sent', theme);
    await out.context().close();

    const page = await open(browser, theme, true);
    await page.goto(ctx.base);
    await expect(page.locator('[data-ticket-card]').first()).toBeVisible();
    await scan(page, 'board', theme);
    await page.goto(`${ctx.base}/tickets/AXE-1`);
    await expect(page.getByRole('dialog', { name: /AXE-1/ })).toBeVisible();
    await scan(page, 'board + ticket drawer', theme);
    await page.goto(`${ctx.base}/analytics`);
    await expect(page.getByRole('heading', { name: 'Cumulative flow' })).toBeVisible();
    await scan(page, 'analytics', theme);
    await page.locator('section[aria-label="Cumulative flow"]').getByRole('button', { name: 'Table' }).click();
    await scan(page, 'analytics (table view)', theme);
    // The rest of the signed-in app, so the bar holds everywhere, not only on the four named pages.
    for (const [where, path, ready] of [
      ['projects', '/projects', 'Orbit'], ['my work', '/my-work', null], ['list', `${ctx.base}/list`, null], ['calendar', `${ctx.base}/calendar`, null],
      ['timeline', `${ctx.base}/timeline`, null], ['sprints', `${ctx.base}/sprints`, null], ['flow', `${ctx.base}/flow`, null], ['triage', `${ctx.base}/triage`, null],
      ['settings', `${ctx.base}/settings`, null], ['account', '/account', null], ['workspaces', '/workspaces', null], ['not found', '/nowhere', null],
    ]) {
      await page.goto(path);
      // Pages that follow live changes never go network-idle; wait for the page itself instead.
      await page.locator('main, [role=main], h1').first().waitFor();
      await page.waitForTimeout(700);
      if (ready) await page.getByText(ready).first().waitFor({ timeout: 3000 }).catch(() => {});
      await scan(page, where, theme);
    }
    await page.context().close();
  });
}

// A focus ring is an outline of at least 2px, or a box-shadow ring, on the focused element (or on
// the visible box around a visually hidden input, like the portal's choice cards).
const ringOf = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const target = visible(el) ? el : el.closest('label, [class*="ds-focus-within"]') ?? el;
  const has = (e) => {
    const s = getComputedStyle(e);
    return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || /0px 0px 0px [2-9]px/.test(s.boxShadow);
  };
  const name = `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} ${(el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 30)}`;
  return { name, ring: has(target) || has(el) };
};

for (const [where, path, signedIn] of [['landing', '/', false], ['login', '/login', false], ['portal', 'PORTAL', false], ['board', 'BOARD', true], ['analytics', 'ANALYTICS', true]]) {
  test(`every Tab stop shows a focus ring: ${where}`, async ({ browser }) => {
    const page = await open(browser, 'dark', signedIn);
    const url = { PORTAL: ctx.portalPath, BOARD: ctx.base, ANALYTICS: `${ctx.base}/analytics` }[path] ?? path;
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const missing = [];
    let stops = 0;
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(ringOf);
      if (!r) continue;
      stops += 1;
      if (!r.ring) missing.push(r.name);
    }
    console.log(`${where}: ${stops} Tab stops, ${missing.length ? `no ring on: ${[...new Set(missing)].join(' | ')}` : 'all show a ring'}`);
    expect.soft([...new Set(missing)]).toEqual([]);
    findings.push(...[...new Set(missing)].map((m) => ({ where, theme: 'dark', rule: 'focus-ring', nodes: 1, help: 'Focused element shows no visible focus ring', targets: [m] })));
    await page.context().close();
  });
}

// Drag and drop without a mouse: Space picks a card up, an arrow moves it, Space drops it; the
// board's live region says what happened at each step, and the move is really saved.
test('keyboard drag and drop, with what a screen reader hears', async ({ browser }) => {
  const page = await open(browser, 'dark', true);
  await page.goto(ctx.base);
  const card = page.getByRole('button', { name: /AXE-4\b/ });
  await card.focus();
  const heard = async () => (await page.locator('[id^="DndLiveRegion"]').textContent())?.trim();
  await page.keyboard.press('Space');
  await expect.poll(heard).toMatch(/Picked up AXE-4/i);
  const picked = await heard();
  await page.keyboard.press('ArrowRight');
  await expect.poll(heard).not.toBe(picked);
  const moved = await heard();
  await page.keyboard.press('Space');
  await expect.poll(heard).not.toBe(moved);
  const dropped = await heard();
  console.log(`heard: "${picked}" → "${moved}" → "${dropped}"`);
  await expect.poll(async () => (await call('GET', `${ctx.base}/tickets/4`, null, ctx.owner.token)).ticket.status).toBe('in_progress');
  await page.context().close();
});

test.afterAll(() => {
  if (!label) return;
  const dir = fileURLToPath(new URL(`../audit/reports/${label}/`, import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}axe.json`, JSON.stringify(findings, null, 2));
});
