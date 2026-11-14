import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { call, person, project } from '../tests/api.js';

// The consistency pass: every screen at 360, 768, 1280 and 1920 px, dark and light, filled with
// the content that breaks layouts (a 200-character title, the most labels a ticket can carry,
// Hindi and Bengali names, a very long comment with an unbroken string), plus every state:
// loading, empty, failed, viewer, archived and offline. Screenshots go to visual/stress/<SET>/
// (SET=before or after), and anything that runs past the right edge of the window is written to
// overflow.json beside them, so problems are found by measuring, not only by looking.
const SET = process.env.SET ?? 'before';
const OUT = fileURLToPath(new URL(`./stress/${SET}/`, import.meta.url));
mkdirSync(OUT, { recursive: true });
const WIDTHS = { 360: 780, 768: 1024, 1280: 800, 1920: 1080 };
const ONLY = process.env.ONLY?.split(',');

const LONG_TITLE = 'Checkout total is wrong when a gift card, a percentage coupon and free shipping are combined on an order over the free-shipping threshold, and the error only appears after changing the delivery address twice'.slice(0, 200);
const LABELS = ['checkout', 'payments', 'gift-cards', 'coupons', 'shipping', 'regression', 'needs-repro', 'safari', 'mobile', 'customer-reported', 'high-revenue', 'q4-launch', 'accessibility', 'performance', 'localisation', 'ux', 'backend', 'frontend', 'api', 'data-integrity'];
const LONG_COMMENT = `${'Steps: open the cart, apply GIFT-50, apply SAVE10, change the delivery address to Kolkata, then back to Mumbai. '.repeat(12)}\n\nTrace id: ${'a3f9c2e17b'.repeat(16)}\nhttps://shop.example.com/checkout/confirm?session=${'Zx8kQ2'.repeat(20)}`;

let ctx;
test.beforeAll(async () => {
  const owner = await person('অনন্যা চট্টোপাধ্যায়-বন্দ্যোপাধ্যায়');
  const p = (await call('POST', '/projects', { name: 'Northwind Grocery Delivery — Customer Experience Platform', key: 'NWGD' }, owner.token)).project;
  const base = `/projects/${p.id}`;
  const viewer = await person('विवेक श्रीनिवासन रामचंद्रन');
  const inv = await call('POST', `${base}/invites`, { email: viewer.email, role: 'viewer' }, owner.token);
  await call('POST', `/invites/${new URL(inv.acceptUrl).pathname.split('/').pop()}/accept`, {}, viewer.token);
  const dev = await person('Maximilian Alexander Featherstonehaugh-Worthington');
  const inv2 = await call('POST', `${base}/invites`, { email: dev.email, role: 'developer' }, owner.token);
  await call('POST', `/invites/${new URL(inv2.acceptUrl).pathname.split('/').pop()}/accept`, {}, dev.token);
  const me = owner.user.id;
  const tickets = [
    { title: LONG_TITLE, type: 'bug', priority: 'critical', labels: LABELS, assigneeId: me },
    { title: 'বাংলায় লেখা অর্ডারের নাম চেকআউটে ভেঙে যাচ্ছে', type: 'bug', priority: 'high', labels: ['localisation'], assigneeId: dev.user.id },
    { title: 'हिंदी में खोज परिणाम गलत क्रम में दिखते हैं', type: 'task', priority: 'medium', labels: ['search', 'localisation'] },
    { title: 'Supercalifragilisticexpialidocious_unbroken_identifier_that_never_wraps_anywhere_at_all_in_the_layout', type: 'task', priority: 'low' },
    { title: 'Add Apple Pay', type: 'feature', priority: 'high', labels: ['payments'], assigneeId: me },
    { title: 'Write release notes for 2.4', type: 'task', priority: 'low' },
  ];
  for (const t of tickets) await call('POST', `${base}/tickets`, t, owner.token);
  await call('POST', `${base}/tickets/2/move`, { status: 'in_progress' }, owner.token);
  await call('POST', `${base}/tickets/6/move`, { status: 'done' }, owner.token);
  await call('POST', `${base}/tickets/1/comments`, { body: LONG_COMMENT }, owner.token);
  await call('POST', `${base}/tickets/1/comments`, { body: 'देखा, मुंबई से कोलकाता बदलने पर ही होता है।' }, dev.token);
  await call('POST', `${base}/sprints`, { name: 'Sprint 14 — checkout hardening and the long-awaited gift-card fix'.slice(0, 60), goal: 'Ship the gift card fix' }, owner.token);
  await call('POST', `${base}/milestones`, { name: 'Festive season launch readiness (Diwali, Durga Puja)' }, owner.token);
  const portal = (await call('PUT', `${base}/portal`, { enabled: true, intro: 'Found a problem with your grocery order, the app, or a delivery? Tell us what happened and we will look into it, usually the same day.' }, owner.token)).portal;
  const report = await fetch(`http://localhost:8741/api/portal/${portal.url.split('/report/')[1]}/reports`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: LONG_TITLE, email: 'reporter@example.com', name: 'শ্রীমতী রবীন্দ্রনাথ' }),
  }).then((r) => r.json());
  const roadmap = (await call('PUT', `${base}/roadmap`, { enabled: true, intro: 'What we are building next.' }, owner.token)).roadmap;
  const share = (await call('POST', `${base}/share-links`, { name: 'Client: Northwind Holdings International (quarterly review)', showPeople: true }, owner.token)).link;
  const invite = await call('POST', `${base}/invites`, { email: 'new.person@example.com', role: 'developer' }, owner.token);
  const archived = await project(owner, 'OLD');
  await call('POST', `/projects/${archived.id}/archive`, {}, owner.token);
  const empty = await project(owner, 'NEW');
  const path = (u) => new URL(u).pathname;
  ctx = { owner, viewer, p, archived, empty, portal: path(portal.url), track: path(report.trackUrl), roadmap: path(roadmap.url), share: path(share.url), invite: path(invite.acceptUrl) };
});

const screens = () => {
  const b = `/projects/${ctx.p.id}`;
  return [
    ['login', '/login', { guest: true }],
    ['register', '/register', { guest: true }],
    ['projects', '/projects'],
    ['board', b],
    ['drawer', `${b}/tickets/NWGD-1`],
    ['list', `${b}/list`],
    ['calendar', `${b}/calendar`],
    ['timeline', `${b}/timeline`],
    ['sprints', `${b}/sprints`],
    ['analytics', `${b}/analytics`],
    ['flow', `${b}/flow`],
    ['together', `${b}/together`],
    ['triage', `${b}/triage`],
    ['deploys', `${b}/deploys`],
    ['releases', `${b}/releases`],
    ['settings', `${b}/settings`],
    ['audit', `${b}/settings/audit`],
    ['my-work', '/my-work'],
    ['workspaces', '/workspaces'],
    ['account', '/account'],
    ['portal', ctx.portal, { guest: true }],
    ['tracking', ctx.track, { guest: true }],
    ['roadmap', ctx.roadmap, { guest: true }],
    ['shared-board', ctx.share, { guest: true }],
    ['invite', ctx.invite, { guest: true }],
    ['not-found', '/nothing-here', { guest: true }],
    ['empty-board', `/projects/${ctx.empty.id}`],
    ['state-viewer-board', b, { as: 'viewer' }],
    ['state-viewer-drawer', `${b}/tickets/NWGD-1`, { as: 'viewer' }],
    ['state-archived-board', `/projects/${ctx.archived.id}`],
    ['state-archived-settings', `/projects/${ctx.archived.id}/settings`],
    ['state-loading-board', b, { slow: true }],
    ['state-failed-list', `${b}/list`, { fail: true }],
    ['state-offline-drawer', `${b}/tickets/NWGD-1`, { offline: true }],
    ['state-offline-board', b, { offline: true }],
  ].filter(([name]) => !ONLY || ONLY.some((w) => name.includes(w)));
};

// Three kinds of breakage, measured rather than eyeballed:
//  wide: a box whose content is wider than the box itself (a sideways scrollbar nobody meant, or
//        content poking out), skipping boxes built to scroll sideways (board, tables, tab strips);
//  clipped: text cut off by overflow:hidden with no ellipsis to say so;
//  page: the window itself scrolling sideways.
const measure = () => {
  const vw = document.documentElement.clientWidth;
  const label = (el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).trim().split(/s+/).slice(0, 6).join(".")}`;
  const sideways = (el) => /overflow-x-(auto|scroll)|overflow-auto/.test(String(el.className)) || el.matches('[role=tablist], table, pre, code');
  const wide = [];
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.clientWidth || el.closest('[aria-hidden=true], svg')) continue;
    const cs = getComputedStyle(el);
    const extra = el.scrollWidth - el.clientWidth;
    if (extra > 2 && cs.overflowX !== 'visible' && !sideways(el)) {
      wide.push({ box: label(el), extra, text: el.textContent.trim().slice(0, 60) });
    } else if (extra > 2 && cs.overflowX === 'visible' && el.children.length === 0 && el.getBoundingClientRect().right > vw) {
      wide.push({ box: label(el), extra, text: el.textContent.trim().slice(0, 60), past: true });
    }
    if (extra > 2 && cs.overflowX === 'hidden' && cs.textOverflow !== 'ellipsis' && el.children.length === 0 && el.textContent.trim()) {
      clipped.push({ box: label(el), extra, text: el.textContent.trim().slice(0, 60) });
    }
  }
  return { page: document.documentElement.scrollWidth - vw, wide: wide.slice(0, 6), clipped: clipped.slice(0, 6) };
};

const found = {};
for (const theme of process.env.THEMES?.split(',') ?? ['dark', 'light']) {
  for (const [w, h] of Object.entries(WIDTHS)) {
    test(`${theme} ${w}`, async ({ browser }) => {
      for (const [name, path, opt = {}] of screens()) {
        const context = await browser.newContext({ viewport: { width: Number(w), height: h }, deviceScaleFactor: 1, colorScheme: theme });
        await context.addInitScript((th) => localStorage.setItem('tessera.theme', th), theme);
        const who = opt.as === 'viewer' ? ctx.viewer : ctx.owner;
        if (!opt.guest) await context.addInitScript((token) => localStorage.setItem('tessera.token', token), who.token);
        const page = await context.newPage();
        if (opt.slow) await page.route(/\/api\/projects\/[a-f0-9]{24}\/(tickets|board)/, async (route) => { await new Promise((r) => setTimeout(r, 4000)); route.continue().catch(() => {}); });
        if (opt.fail) await page.route(/\/api\/projects\/[a-f0-9]{24}$/, (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' }));
        await page.goto(path);
        if (opt.slow) await page.waitForTimeout(900);
        else { await page.waitForLoadState('networkidle'); await page.waitForTimeout(opt.fail ? 4500 : 500); }
        if (opt.offline) { await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await page.waitForTimeout(500); }
        if (process.env.DEBUG_WIDE) console.log(name, w, JSON.stringify(await page.evaluate(() => { const m = document.querySelector('#main'); const edge = m.getBoundingClientRect().right; return [...m.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > edge + 1).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 70)} r=${Math.round(el.getBoundingClientRect().right)}`).slice(0, 12); })));
        const m = await page.evaluate(measure);
        if (m.page > 0 || m.wide.length || m.clipped.length) found[`${name} ${theme} ${w}`] = m;
        if (!process.env.MEASURE_ONLY) await page.screenshot({ path: `${OUT}${name}-${theme}-${w}.png` });
        await context.close();
      }
    });
  }
}

test.afterAll(() => {
  writeFileSync(`${OUT}overflow-${Date.now()}.json`, JSON.stringify(found, null, 1));
});
