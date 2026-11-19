// GitHub deep integration (E7) against a stand-in for GitHub's REST API that answers in GitHub's
// own response shapes and records every call (throwaway MongoDB; no network).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { __setGithubFetch } from '../src/services/githubapi.js';
import { flushHooks } from '../src/services/hooks.js';
import { Comment, Project, Ticket, TicketEvent, User } from '../src/models/index.js';

let t;
let calls = [];
let routes = [];
const TOKEN = `github_pat_${'A1b2C3d4'.repeat(6)}`;
before(async () => {
  t = await startTestServer();
  __setTransport({ async sendMail() { return {}; } });
  __setGithubFetch(async (url, opts) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    calls.push({ method: opts.method, path, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.authorization });
    for (const [method, re, fn] of routes) {
      if (method === opts.method && re.test(path)) {
        const out = await fn(path, opts);
        const [status, json, headers] = out?.status ? [out.status, out.json, out.headers] : [200, out, {}];
        return new Response(JSON.stringify(json ?? null), { status, headers: { 'content-type': 'application/json', ...headers } });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  });
});
after(async () => { __setGithubFetch(null); __setTransport(null); await t.stop(); });
beforeEach(() => { calls = []; routes = []; });

const REPO = 'acme/shop';
const base = [
  ['GET', /^\/user$/, () => ({ login: 'tessera-bot' })],
  ['GET', /^\/repos\/acme\/shop$/, () => ({ full_name: REPO, permissions: { push: true, pull: true } })],
];

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Shop', key: `GD${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { user: dev.user.id, role: 'developer' } } });
  const url = `/api/projects/${body.project.id}`;
  await t.api('PUT', `${url}/source`, { token: admin.token, body: { repo: REPO, branch: 'main' } });
  return { admin, dev, project: body.project, url };
}
async function withToken(ctx) {
  routes = [...base, ...routes];
  const res = await t.api('PUT', `${ctx.url}/github/token`, { token: ctx.admin.token, body: { token: TOKEN } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.github;
}
async function hook(ctx, event, payload) {
  const secret = (await t.api('PUT', `${ctx.url}/integrations/github`, { token: ctx.admin.token })).body.github.secret;
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const r = await fetch(`${t.base}/api/hooks/github/${ctx.project.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sig }, body: raw });
  return { status: r.status, body: await r.json() };
}

test('token: checked with GitHub, stored encrypted, never shown again', async () => {
  const ctx = await team();
  assert.equal((await t.api('PUT', `${ctx.url}/github/token`, { token: ctx.admin.token, body: { token: 'hunter2' } })).body.error.code, 'bad_token');
  routes = [['GET', /^\/user$/, () => ({ status: 401, json: { message: 'Bad credentials' } })]];
  assert.equal((await t.api('PUT', `${ctx.url}/github/token`, { token: ctx.admin.token, body: { token: TOKEN } })).body.error.code, 'github_token_rejected');
  routes = [];
  const gh = await withToken(ctx);
  assert.deepEqual([gh.set, gh.login, gh.repo, gh.canWrite], [true, 'tessera-bot', REPO, true]);
  assert.equal(calls.find((c) => c.path === '/user').auth, `Bearer ${TOKEN}`);
  const stored = await Project.findById(ctx.project.id).lean();
  assert.equal(JSON.stringify(stored).includes(TOKEN), false, 'stored only encrypted');
  const shown = await t.api('GET', `${ctx.url}/github`, { token: ctx.admin.token });
  assert.equal(JSON.stringify(shown.body).includes(TOKEN), false);
  assert.equal((await t.api('PUT', `${ctx.url}/github/token`, { token: ctx.dev.token, body: { token: TOKEN } })).status, 403);
  const audit = (await t.api('GET', `${ctx.url}/audit`, { token: ctx.admin.token })).body.entries;
  assert.equal(audit[0].action, 'github_token.set');
  assert.equal(JSON.stringify(audit).includes(TOKEN), false);
});

test('pull request status on the card: review, CI, conflicts, missing tests; refreshed from deliveries', async () => {
  const ctx = await team();
  await withToken(ctx);
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.dev.token, body: { title: 'Coupon total wrong', type: 'bug' } });
  routes.push(
    ['GET', /^\/repos\/acme\/shop\/pulls\/7$/, () => ({ number: 7, state: 'open', draft: false, merged: false, mergeable: false, mergeable_state: 'dirty', head: { sha: 'abc123' }, requested_reviewers: [] })],
    ['GET', /^\/repos\/acme\/shop\/pulls\/7\/reviews/, () => [{ user: { login: 'ana' }, state: 'APPROVED' }, { user: { login: 'ben' }, state: 'CHANGES_REQUESTED' }]],
    ['GET', /^\/repos\/acme\/shop\/commits\/abc123\/check-runs/, () => ({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] })],
    ['GET', /^\/repos\/acme\/shop\/pulls\/7\/files/, () => [{ filename: 'src/cart.js' }, { filename: 'README.md' }]],
  );
  const pr = { number: 7, title: 'Fix coupon totals', body: `fixes ${ctx.project.key}-1`, html_url: `https://github.com/${REPO}/pull/7`, head: { ref: 'fix/coupon', sha: 'abc123' }, user: { login: 'ana' }, draft: false };
  const res = await hook(ctx, 'pull_request', { action: 'opened', pull_request: pr, repository: { full_name: REPO } });
  assert.deepEqual(res.body.refreshed, [`${ctx.project.key}-1`]);
  const link = (await t.api('GET', `${ctx.url}/tickets/1`, { token: ctx.dev.token })).body.ticket.links[0];
  assert.deepEqual(
    [link.pr.state, link.pr.draft, link.pr.conflicts, link.pr.review, link.pr.ci, link.pr.sourceChanged, link.pr.testsChanged],
    ['open', false, true, 'changes_requested', 'failure', true, false],
  );
  // Tests added: the warning goes away on the next check run.
  routes.splice(routes.findIndex((r) => String(r[1]).includes('files')), 1, ['GET', /^\/repos\/acme\/shop\/pulls\/7\/files/, () => [{ filename: 'src/cart.js' }, { filename: 'src/cart.test.js' }]]);
  await hook(ctx, 'check_suite', { action: 'completed', check_suite: { pull_requests: [{ number: 7 }] }, repository: { full_name: REPO } });
  const again = (await t.api('GET', `${ctx.url}/tickets/1`, { token: ctx.dev.token })).body.ticket.links[0].pr;
  assert.equal(again.testsChanged, true);
  // Refresh on demand works too.
  assert.equal((await t.api('POST', `${ctx.url}/tickets/1/github/refresh`, { token: ctx.dev.token })).body.refreshed, 1);
});

test('cards move when a branch or a ready pull request appears; only forwards', async () => {
  const ctx = await team();
  await t.api('PUT', `${ctx.url}/github/options`, { token: ctx.admin.token, body: { moves: { branch: 'in_progress', pr: 'in_progress' } } });
  assert.equal((await t.api('PUT', `${ctx.url}/github/options`, { token: ctx.admin.token, body: { moves: { branch: 'nope' } } })).status, 400);
  for (const title of ['One', 'Two', 'Three']) await t.api('POST', `${ctx.url}/tickets`, { token: ctx.dev.token, body: { title } });
  await t.api('POST', `${ctx.url}/tickets/3/move`, { token: ctx.dev.token, body: { status: 'done' } });
  const k = ctx.project.key;
  const b = await hook(ctx, 'create', { ref_type: 'branch', ref: `fix/${k}-1-coupon`, repository: { full_name: REPO } });
  assert.deepEqual(b.body.moved, [`${k}-1`]);
  const draft = await hook(ctx, 'pull_request', { action: 'opened', pull_request: { number: 9, draft: true, title: `${k}-2`, body: '', html_url: `https://github.com/${REPO}/pull/9`, head: { ref: 'wip' } }, repository: { full_name: REPO } });
  assert.deepEqual(draft.body.moved, [], 'drafts do not move cards');
  const ready = await hook(ctx, 'pull_request', { action: 'ready_for_review', pull_request: { number: 9, draft: false, title: `${k}-2 and ${k}-3`, body: '', html_url: `https://github.com/${REPO}/pull/9`, head: { ref: 'wip' } }, repository: { full_name: REPO } });
  assert.deepEqual(ready.body.moved, [`${k}-2`], 'a done ticket stays done');
  const statuses = (await Ticket.find({ project: ctx.project.id }).sort({ number: 1 }).lean()).map((x) => x.status);
  assert.deepEqual(statuses, ['in_progress', 'in_progress', 'done']);
});

test('suspect commit and suggested assignee for a crash', async () => {
  const ctx = await team();
  await withToken(ctx);
  await User.updateOne({ _id: ctx.dev.user.id }, { $set: { 'oauth.github': { id: '42', login: 'dev-gh' } } });
  const trace = "app/models/order.rb:42:in `total': undefined method `price' for nil:NilClass (NoMethodError)\n\tfrom app/controllers/orders_controller.rb:10:in `create'";
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.dev.token, body: { errorText: trace } });
  const commit = (sha, login, msg) => ({ sha, html_url: `https://github.com/${REPO}/commit/${sha}`, author: { login }, commit: { message: msg, author: { name: login, email: `${login}@example.org`, date: '2026-11-09T10:00:00Z' } } });
  routes.push(['GET', /^\/repos\/acme\/shop\/commits\?path=app%2Fmodels%2Forder\.rb/, (path) => (path.includes('until=')
    ? [commit('d00df00d1', 'ana', 'Price from the line item\n\nlonger text')]
    : [commit('a1', 'dev-gh', 'x'), commit('a2', 'dev-gh', 'x'), commit('a3', 'ana', 'x'), commit('a4', 'dev-gh', 'x')])]);
  const res = await t.api('POST', `${ctx.url}/tickets/1/github/suspect`, { token: ctx.dev.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body.suspect;
  assert.deepEqual([s.found, s.file, s.line], [true, 'app/models/order.rb', 42]);
  assert.deepEqual([s.suspect.short, s.suspect.message, s.suspect.author], ['d00df00', 'Price from the line item', 'ana']);
  assert.deepEqual(s.candidates.map((c) => [c.login, c.commits, c.member?.name ?? null]), [['dev-gh', 3, 'Dev'], ['ana', 1, null]]);
  assert.deepEqual(s.suggested, { id: ctx.dev.user.id, name: 'Dev' });
  assert.ok(calls.some((c) => c.path.includes('until=')), 'the suspect is the last change before the crash was first seen');
});

test('hotspots, knowledge risk and the TODO scanner', async () => {
  const ctx = await team();
  await withToken(ctx);
  // Hotspots come from what Tessera already knows: crash frames and bug-fix PR files.
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.dev.token, body: { errorText: "app/models/order.rb:42:in `total': boom (RuntimeError)" } });
  await Ticket.updateOne({ project: ctx.project.id, number: 1 }, { $set: { links: [{ kind: 'pull_request', url: `https://github.com/${REPO}/pull/3`, ref: '#3', pr: { files: ['app/models/order.rb', 'spec/order_spec.rb'] } }] } });
  const hs = (await t.api('GET', `${ctx.url}/github/insights`, { token: ctx.dev.token })).body.hotspots;
  assert.deepEqual([hs[0].file, hs[0].bugFixes, hs[0].crashes], ['app/models/order.rb', 1, 1]);

  const commits = [...Array(6)].map((_, i) => ({ sha: `c${i}` }));
  routes.push(
    ['GET', /^\/repos\/acme\/shop\/commits\?sha=main&since=/, () => commits],
    ['GET', /^\/repos\/acme\/shop\/commits\/c\d$/, (path) => {
      const i = Number(path.at(-1));
      return { author: { login: i < 5 ? 'alice' : 'bob' }, files: [{ filename: i < 5 ? 'src/billing/invoice.js' : 'src/cart/cart.js', additions: 10, deletions: 2 }] };
    }],
  );
  const k = (await t.api('POST', `${ctx.url}/github/knowledge`, { token: ctx.admin.token })).body.knowledge;
  assert.deepEqual(k.areas[0], { dir: 'src/billing', commits: 5, authors: 1, topAuthor: 'alice', share: 1, risk: true });
  assert.equal(k.areas.find((a) => a.dir === 'src/cart').risk, false, 'one commit is not a pattern');

  const b64 = (s) => Buffer.from(s).toString('base64');
  routes.push(
    ['GET', /^\/repos\/acme\/shop\/git\/trees\/main\?recursive=1$/, () => ({ truncated: false, tree: [
      { type: 'blob', path: 'src/cart.js', sha: 's1', size: 100 },
      { type: 'blob', path: 'node_modules/x/index.js', sha: 's2', size: 100 },
      { type: 'blob', path: 'logo.png', sha: 's3', size: 100 },
    ] })],
    ['GET', /^\/repos\/acme\/shop\/git\/blobs\/s1$/, () => ({ content: b64('const a = 1;\n// TODO: handle an empty cart\nlet b; // FIXME round to cents\n') })],
  );
  const todos = (await t.api('POST', `${ctx.url}/github/todos`, { token: ctx.admin.token })).body.todos;
  assert.deepEqual(todos.items.map((i) => [i.file, i.line, i.kind, i.text]), [['src/cart.js', 2, 'TODO', 'handle an empty cart'], ['src/cart.js', 3, 'FIXME', 'round to cents']]);
  assert.equal(calls.some((c) => c.path.includes('/blobs/s2')), false, 'dependencies are not scanned');
  const made = await t.api('POST', `${ctx.url}/github/todos/ticket`, { token: ctx.dev.token, body: { file: 'src/cart.js', line: 2 } });
  assert.equal(made.status, 201);
  assert.equal(made.body.ticket.title, 'TODO: handle an empty cart');
  assert.match(made.body.ticket.description, /https:\/\/github\.com\/acme\/shop\/blob\/main\/src\/cart\.js#L2/);
  assert.equal((await t.api('POST', `${ctx.url}/github/todos/ticket`, { token: ctx.dev.token, body: { file: 'src/cart.js', line: 2 } })).status, 409);
});

test('GitHub issues both ways: import, push title/state, take edits and comments, no loops', async () => {
  const ctx = await team();
  await withToken(ctx);
  const issue = (num, title, extra = {}) => ({ number: num, title, body: 'From GitHub', state: 'open', html_url: `https://github.com/${REPO}/issues/${num}`, labels: [{ name: 'Bug' }], ...extra });
  routes.push(
    ['GET', /^\/repos\/acme\/shop\/issues\?state=open/, () => [issue(11, 'Login loops'), issue(12, 'A pull request', { pull_request: {} })]],
    ['PATCH', /^\/repos\/acme\/shop\/issues\/\d+$/, (_p, opts) => ({ number: 11, state: JSON.parse(opts.body).state ?? 'open' })],
    ['POST', /^\/repos\/acme\/shop\/issues$/, () => issue(13, 'Made in Tessera')],
  );
  assert.equal((await t.api('PUT', `${ctx.url}/github/options`, { token: ctx.admin.token, body: { issues: { sync: true } } })).status, 200);
  const imp = await t.api('POST', `${ctx.url}/github/issues/import`, { token: ctx.admin.token });
  assert.deepEqual(imp.body, { imported: 1, skipped: 0 });
  assert.deepEqual((await t.api('POST', `${ctx.url}/github/issues/import`, { token: ctx.admin.token })).body, { imported: 0, skipped: 1 });
  const first = await Ticket.findOne({ project: ctx.project.id, number: 1 }).lean();
  assert.deepEqual([first.title, first.type, first.labels, first.githubIssue.number, first.source], ['Login loops', 'bug', ['bug'], 11, 'github']);

  // Tessera -> GitHub.
  calls = [];
  await t.api('PATCH', `${ctx.url}/tickets/1`, { token: ctx.admin.token, body: { title: 'Login loops on Safari' } });
  await t.api('POST', `${ctx.url}/tickets/1/move`, { token: ctx.dev.token, body: { status: 'done' } });
  await flushHooks();
  const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
  assert.deepEqual(patches, [{ title: 'Login loops on Safari' }, { state: 'closed', state_reason: 'completed' }]);

  // GitHub -> Tessera. Tessera's own close coming back is a no-op: no second move in the history.
  const moves = async () => TicketEvent.countDocuments({ ticket: first._id, type: 'status_changed' });
  const movesBefore = await moves();
  await hook(ctx, 'issues', { action: 'closed', issue: issue(11, 'Login loops on Safari', { state: 'closed' }), sender: { login: 'tessera-bot' }, repository: { full_name: REPO } });
  assert.equal(await moves(), movesBefore);
  await hook(ctx, 'issues', { action: 'reopened', issue: issue(11, 'Login loops on Safari'), sender: { login: 'ana' }, repository: { full_name: REPO } });
  await hook(ctx, 'issues', { action: 'edited', changes: { title: { from: 'x' } }, issue: issue(11, 'Login loops on Safari 18'), sender: { login: 'ana' }, repository: { full_name: REPO } });
  await hook(ctx, 'issue_comment', { action: 'created', issue: issue(11, 'x'), comment: { body: 'Still happens for me', user: { login: 'ana' }, html_url: `https://github.com/${REPO}/issues/11#c1` }, sender: { login: 'ana' }, repository: { full_name: REPO } });
  const after1 = await Ticket.findOne({ project: ctx.project.id, number: 1 }).lean();
  assert.deepEqual([after1.title, after1.status], ['Login loops on Safari 18', 'todo']);
  const comment = await Comment.findOne({ ticket: after1._id }).lean();
  assert.deepEqual([comment.body, comment.external.login, comment.author], ['Still happens for me', 'ana', null]);
  const opened = await hook(ctx, 'issues', { action: 'opened', issue: issue(14, 'New from GitHub'), sender: { login: 'ana' }, repository: { full_name: REPO } });
  assert.deepEqual(opened.body.issue, { created: `${ctx.project.key}-2` });

  // A Tessera ticket can open its own issue.
  await t.api('POST', `${ctx.url}/tickets`, { token: ctx.dev.token, body: { title: 'Made in Tessera' } });
  const made = await t.api('POST', `${ctx.url}/tickets/3/github/issue`, { token: ctx.dev.token });
  assert.equal(made.body.githubIssue.number, 13);
  assert.match(calls.find((c) => c.method === 'POST').body.body, new RegExp(`Tracked in Tessera as ${ctx.project.key}-3`));

  // An issue Tessera opened never becomes a second ticket, even if GitHub's event beats the save.
  const echo = await hook(ctx, 'issues', { action: 'opened', issue: issue(16, 'Made in Tessera', { body: `Steps\n\n---\n_Tracked in Tessera as ${ctx.project.key}-3._` }), sender: { login: 'tessera-bot' }, repository: { full_name: REPO } });
  assert.deepEqual(echo.body.issue, { skipped: 'own_change' });
  // The token's owner is a person too: what they open and close on GitHub reaches Tessera.
  const mine = await hook(ctx, 'issues', { action: 'opened', issue: issue(17, 'Filed by the token owner'), sender: { login: 'tessera-bot' }, repository: { full_name: REPO } });
  assert.deepEqual(mine.body.issue, { created: `${ctx.project.key}-4` });
  await hook(ctx, 'issues', { action: 'closed', issue: issue(17, 'Filed by the token owner', { state: 'closed' }), sender: { login: 'tessera-bot' }, repository: { full_name: REPO } });
  assert.equal((await Ticket.findOne({ project: ctx.project.id, number: 4 }).lean()).status, 'done');
});
