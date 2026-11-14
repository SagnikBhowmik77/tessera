import { HttpError } from '../errors.js';
import { Comment, RepoInsight, Ticket, TicketEvent, User } from '../models/index.js';
import { gh, hasGithub, repoOf, sealToken } from './githubapi.js';
import { sourcePath, sourceUrl } from '../bugs/sourcelink.js';
import { createTicket, moveFromIntegration, serializeTicket, ticketKey } from './ticket.service.js';
import { onTicketEvents } from './hooks.js';
import { publish } from '../realtime.js';

// GitHub deep integration (E7), on top of the webhook (step 9) and source links (E5B):
// PR status on cards, card moves on branch/PR, suspect commit + suggested assignee for crashes,
// bug hotspots, knowledge risk, a TODO scanner and two-way GitHub Issues sync. Everything that
// reads GitHub uses the project's own token; nothing is guessed when GitHub can't say.

const enc = encodeURIComponent;
const statusOf = (project, key) => project.statuses.find((s) => s.key === key);
const isDone = (project, key) => statusOf(project, key)?.category === 'done';

// ---------- token ----------

export async function connectToken(project, token) {
  const t = String(token ?? '').trim();
  if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,255}$/.test(t)) throw new HttpError(400, 'bad_token', 'That does not look like a GitHub token (they start with github_pat_ or ghp_)');
  const repo = repoOf(project);
  const me = await gh(project, 'GET', '/user', null, { token: t });
  const r = await gh(project, 'GET', `/repos/${repo}`, null, { token: t });
  project.github.token = sealToken(t);
  project.github.tokenLogin = me.login;
  project.github.tokenRepo = repo;
  project.github.canWrite = Boolean(r.permissions?.push);
  await project.save();
  return tokenSettings(project);
}

export async function removeToken(project) {
  project.github.token = null;
  project.github.tokenLogin = null;
  project.github.tokenRepo = null;
  project.github.canWrite = false;
  await project.save();
  return tokenSettings(project);
}

export function tokenSettings(project) {
  const g = project.github ?? {};
  return {
    set: Boolean(g.token), login: g.tokenLogin ?? null, repo: g.tokenRepo ?? null, canWrite: Boolean(g.canWrite),
    repoNow: project.source?.repo ?? null,
    moves: { branch: g.moves?.branch ?? null, pr: g.moves?.pr ?? null },
    issues: { sync: Boolean(g.issues?.sync), lastError: g.issues?.lastError ?? null },
  };
}

export async function updateGithubOptions(project, { moves, issues }) {
  for (const key of [moves?.branch, moves?.pr]) {
    if (key && !statusOf(project, key)) throw new HttpError(400, 'unknown_status', `This project has no column "${key}"`);
  }
  if (moves) project.github.moves = { branch: moves.branch ?? null, pr: moves.pr ?? null };
  if (issues) {
    if (issues.sync && !project.github.token) throw new HttpError(409, 'github_token_missing', 'Add a GitHub token first: syncing issues needs it');
    project.github.issues = { sync: Boolean(issues.sync), lastError: project.github.issues?.lastError ?? null };
  }
  await project.save();
  return tokenSettings(project);
}

// ---------- pull request status ----------

const isTest = (f) => /(^|\/)(__tests__|tests?|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/i.test(f);
const isSource = (f) => /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rb|php|java|kt|rs|cs|swift|scala|vue|svelte)$/i.test(f) && !isTest(f);

export async function prStatus(project, number) {
  const repo = repoOf(project);
  const pr = await gh(project, 'GET', `/repos/${repo}/pulls/${number}`);
  const [reviews, checks, files] = await Promise.all([
    gh(project, 'GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    gh(project, 'GET', `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
    gh(project, 'GET', `/repos/${repo}/pulls/${number}/files?per_page=100`),
  ]);
  // Each reviewer's latest verdict counts.
  const latest = new Map();
  for (const r of reviews ?? []) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user?.login, r.state);
  const verdicts = [...latest.values()];
  const review = verdicts.includes('CHANGES_REQUESTED') ? 'changes_requested'
    : verdicts.includes('APPROVED') ? 'approved'
      : (pr.requested_reviewers?.length || pr.requested_teams?.length) ? 'requested' : null;
  const runs = checks?.check_runs ?? [];
  const ci = !runs.length ? null
    : runs.some((r) => r.status !== 'completed') ? 'pending'
      : runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion)) ? 'failure' : 'success';
  const names = (files ?? []).map((f) => f.filename);
  return {
    number: pr.number,
    state: pr.merged ? 'merged' : pr.state,
    draft: Boolean(pr.draft),
    conflicts: pr.mergeable === false || pr.mergeable_state === 'dirty',
    review,
    ci,
    sourceChanged: names.some(isSource),
    testsChanged: names.some(isTest),
    files: names.slice(0, 100),
    headSha: pr.head.sha,
    checkedAt: new Date(),
  };
}

const prNumberOf = (link) => (link.kind === 'pull_request' ? Number(String(link.ref ?? '').replace('#', '')) || Number(/\/pull\/(\d+)/.exec(link.url)?.[1]) : null);

export async function refreshTicketPrs(project, ticket, { onlyNumber = null } = {}) {
  let changed = 0;
  for (const link of ticket.links ?? []) {
    const n = prNumberOf(link);
    if (!n || (onlyNumber && n !== onlyNumber)) continue;
    link.pr = await prStatus(project, n);
    changed += 1;
  }
  if (changed) {
    ticket.markModified('links');
    await ticket.save();
  }
  return changed;
}

// Webhook: the PR (or its checks/reviews) changed; refresh the cards it is linked to.
export async function refreshFromDelivery(project, event, payload) {
  if (!hasGithub(project)) return [];
  let numbers = [];
  if (['pull_request', 'pull_request_review'].includes(event)) numbers = [payload.pull_request?.number];
  else if (event === 'check_suite') numbers = (payload.check_suite?.pull_requests ?? []).map((p) => p.number);
  else if (event === 'check_run') numbers = (payload.check_run?.pull_requests ?? []).map((p) => p.number);
  numbers = [...new Set(numbers.filter(Boolean))];
  const shas = event === 'status' && payload.sha ? [payload.sha] : [];
  if (!numbers.length && !shas.length) return [];
  const repo = repoOf(project);
  const or = [
    ...numbers.map((n) => ({ 'links.url': `https://github.com/${repo}/pull/${n}` })),
    ...shas.map((sha) => ({ 'links.pr.headSha': sha })),
  ];
  const tickets = await Ticket.find({ project: project._id, deletedAt: null, $or: or });
  const keys = [];
  for (const t of tickets) {
    const only = numbers.length === 1 ? numbers[0] : null;
    if (await refreshTicketPrs(project, t, { onlyNumber: only })) {
      keys.push(ticketKey(project, t.number));
      publish(String(project._id), 'ticket', { action: 'updated', actorId: null, number: t.number });
    }
  }
  return keys;
}

// ---------- automatic card moves ----------

// A branch named after a ticket (fix/SHOP-12-...) moves it to the "branch" column; a pull request
// opened for it (ready, not draft) moves it to the "pr" column. Only forwards: done tickets and
// tickets already further along stay where they are.
export async function moveFromDelivery(project, event, payload, findRefs) {
  const moves = project.github?.moves ?? {};
  let target = null;
  let text = '';
  if (event === 'create' && payload.ref_type === 'branch' && moves.branch) { target = moves.branch; text = payload.ref; }
  if (event === 'pull_request' && ['opened', 'reopened', 'ready_for_review'].includes(payload.action) && !payload.pull_request?.draft && moves.pr) {
    target = moves.pr;
    const pr = payload.pull_request;
    text = `${pr.head?.ref ?? ''}\n${pr.title ?? ''}\n${pr.body ?? ''}`;
  }
  if (!target) return [];
  const order = project.statuses.map((s) => s.key);
  const moved = [];
  for (const ref of findRefs(text, project.key)) {
    const ticket = await Ticket.findOne({ project: project._id, number: ref.number, deletedAt: null });
    if (!ticket || isDone(project, ticket.status) || ticket.status === target) continue;
    if (order.indexOf(ticket.status) > order.indexOf(target)) continue;
    await moveFromIntegration(project, ticket, target, 'github');
    moved.push(ticketKey(project, ticket.number));
    publish(String(project._id), 'ticket', { action: 'updated', actorId: null, number: ticket.number });
  }
  return moved;
}

// ---------- suspect commit and suggested assignee ----------

export async function suspectFor(project, ticket) {
  if (!ticket.error) throw new HttpError(400, 'not_an_error', 'This ticket was not made from an error');
  const repo = repoOf(project);
  const branch = project.source?.branch || 'main';
  const frame = ticket.error.frames.find((f) => f.inApp && sourcePath(f.file, project.source?.pathPrefix));
  if (!frame) {
    const result = { found: false, reason: 'No frame of your code maps to a file in the repository (see Settings → Source code).', checkedAt: new Date() };
    ticket.error.suspect = result;
    ticket.markModified('error');
    await ticket.save();
    return result;
  }
  const path = sourcePath(frame.file, project.source?.pathPrefix);
  const until = new Date(ticket.error.firstSeenAt ?? ticket.createdAt).toISOString();
  const [before, recent] = await Promise.all([
    gh(project, 'GET', `/repos/${repo}/commits?path=${enc(path)}&sha=${enc(branch)}&until=${enc(until)}&per_page=5`),
    gh(project, 'GET', `/repos/${repo}/commits?path=${enc(path)}&sha=${enc(branch)}&per_page=30`),
  ]);
  const brief = (c) => c && ({
    sha: c.sha, short: c.sha.slice(0, 7), message: String(c.commit?.message ?? '').split('\n')[0].slice(0, 200),
    author: c.author?.login ?? c.commit?.author?.name ?? null, date: c.commit?.author?.date ?? null, url: c.html_url,
  });
  // Who knows this file: commit authors over its last 30 commits, matched to project members by
  // their linked GitHub account or their commit email.
  const tally = new Map();
  for (const c of recent ?? []) {
    const login = c.author?.login ?? null;
    const email = c.commit?.author?.email?.toLowerCase() ?? null;
    const k = login ?? email ?? c.commit?.author?.name;
    if (!k) continue;
    const row = tally.get(k) ?? { login, email, name: c.commit?.author?.name ?? login, commits: 0 };
    row.commits += 1;
    tally.set(k, row);
  }
  const memberIds = project.members.map((m) => m.user);
  const users = await User.find({ _id: { $in: memberIds } }, { name: 1, email: 1, 'oauth.github.login': 1 }).lean();
  const workers = new Set(project.members.filter((m) => m.role !== 'viewer').map((m) => String(m.user)));
  const candidates = [...tally.values()].sort((a, b) => b.commits - a.commits).slice(0, 5).map((row) => {
    const u = users.find((x) => (row.login && x.oauth?.github?.login?.toLowerCase() === row.login.toLowerCase()) || (row.email && x.email === row.email));
    return { login: row.login, name: row.name, commits: row.commits, member: u && workers.has(String(u._id)) ? { id: String(u._id), name: u.name } : null };
  });
  const result = {
    found: true, file: path, line: frame.line, fileUrl: sourceUrl(project.source, frame, ticket.error.language),
    suspect: brief(before?.[0]) ?? null,
    suggested: candidates.find((c) => c.member)?.member ?? null,
    candidates,
    checkedAt: new Date(),
  };
  ticket.error.suspect = result;
  ticket.markModified('error');
  await ticket.save();
  return result;
}

// ---------- hotspots (no token needed) ----------

export async function hotspots(project) {
  const done = new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));
  const tickets = await Ticket.find({ project: project._id, deletedAt: null, $or: [{ type: 'bug', 'links.pr': { $exists: true } }, { error: { $ne: null } }] },
    { type: 1, number: 1, links: 1, error: 1, status: 1 }).lean();
  const files = new Map();
  const row = (f) => { if (!files.has(f)) files.set(f, { file: f, bugFixes: 0, crashes: 0, reports: 0, open: 0 }); return files.get(f); };
  for (const t of tickets) {
    if (t.type === 'bug') {
      const touched = new Set((t.links ?? []).flatMap((l) => l.pr?.files ?? []).filter(isSource));
      for (const f of touched) row(f).bugFixes += 1;
    }
    if (t.error) {
      const fr = (t.error.frames ?? []).find((x) => x.inApp);
      const path = fr && (sourcePath(fr.file, project.source?.pathPrefix) ?? fr.file?.split(/[\\/]/).pop());
      if (path) {
        const r = row(path);
        r.crashes += 1;
        r.reports += t.error.occurrences ?? 1;
        if (!done.has(t.status)) r.open += 1;
      }
    }
  }
  return [...files.values()].map((r) => ({ ...r, score: r.bugFixes * 3 + r.crashes * 2 + Math.log2(1 + r.reports) }))
    .sort((a, b) => b.score - a.score).slice(0, 15);
}

// ---------- knowledge risk and TODOs (on demand, stored) ----------

export async function analyseKnowledge(project) {
  const repo = repoOf(project);
  const since = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
  const list = await gh(project, 'GET', `/repos/${repo}/commits?sha=${enc(project.source?.branch || 'main')}&since=${enc(since)}&per_page=100`);
  const dirs = new Map();
  for (const c of list ?? []) {
    const full = await gh(project, 'GET', `/repos/${repo}/commits/${c.sha}`);
    const who = full.author?.login ?? full.commit?.author?.name ?? 'unknown';
    const touched = new Map();
    for (const f of full.files ?? []) {
      if (!isSource(f.filename)) continue;
      const dir = f.filename.split('/').slice(0, -1).slice(0, 2).join('/') || '(root)';
      touched.set(dir, (touched.get(dir) ?? 0) + (f.additions ?? 0) + (f.deletions ?? 0));
    }
    for (const [dir, lines] of touched) {
      const d = dirs.get(dir) ?? { dir, commits: 0, lines: 0, authors: new Map() };
      d.commits += 1;
      d.lines += lines;
      d.authors.set(who, (d.authors.get(who) ?? 0) + lines);
      dirs.set(dir, d);
    }
  }
  const areas = [...dirs.values()].map((d) => {
    const ranked = [...d.authors].sort((a, b) => b[1] - a[1]);
    const share = d.lines ? ranked[0][1] / d.lines : 0;
    return { dir: d.dir, commits: d.commits, authors: ranked.length, topAuthor: ranked[0][0], share: Math.round(share * 100) / 100, risk: d.commits >= 5 && share >= 0.75 };
  }).sort((a, b) => Number(b.risk) - Number(a.risk) || b.share - a.share || b.commits - a.commits);
  const data = { commits: list?.length ?? 0, since, areas: areas.slice(0, 40) };
  await RepoInsight.findOneAndUpdate({ project: project._id, kind: 'knowledge' }, { $set: { data, at: new Date(), repo } }, { upsert: true });
  return data;
}

const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rb|php|java|kt|rs|cs|swift|scala|vue|svelte|css|scss|html|sql|sh|yml|yaml)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|target|out)\//;
const TODO = /(?:\/\/|#|\/\*|\*|<!--|--)\s*(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/;
const MAX_FILES = 400;

export async function scanTodos(project) {
  const repo = repoOf(project);
  const branch = project.source?.branch || 'main';
  const tree = await gh(project, 'GET', `/repos/${repo}/git/trees/${enc(branch)}?recursive=1`);
  const files = (tree?.tree ?? []).filter((n) => n.type === 'blob' && CODE.test(n.path) && !SKIP.test(n.path) && (n.size ?? 0) <= 200_000);
  const scanned = files.slice(0, MAX_FILES);
  const items = [];
  for (const f of scanned) {
    const blob = await gh(project, 'GET', `/repos/${repo}/git/blobs/${f.sha}`);
    const text = Buffer.from(blob?.content ?? '', 'base64').toString('utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const m = TODO.exec(line);
      if (m && items.length < 500) items.push({ file: f.path, line: i + 1, kind: m[1].toUpperCase(), text: m[2].replace(/\*\/\s*$|-->\s*$/, '').trim().slice(0, 200), ticket: null });
    });
  }
  const old = await RepoInsight.findOne({ project: project._id, kind: 'todos' }).lean();
  // Keep the ticket made earlier for a TODO that is still there.
  for (const it of items) it.ticket = old?.data?.items?.find((o) => o.file === it.file && o.text === it.text)?.ticket ?? null;
  const data = { files: scanned.length, skipped: Math.max(0, files.length - MAX_FILES), truncated: tree?.truncated || items.length >= 500, items };
  await RepoInsight.findOneAndUpdate({ project: project._id, kind: 'todos' }, { $set: { data, at: new Date(), repo } }, { upsert: true });
  return data;
}

export async function insights(project) {
  const rows = await RepoInsight.find({ project: project._id }).lean();
  const by = Object.fromEntries(rows.map((r) => [r.kind, { ...r.data, at: r.at, repo: r.repo }]));
  return { knowledge: by.knowledge ?? null, todos: by.todos ?? null, hotspots: await hotspots(project) };
}

export async function ticketFromTodo(project, user, { file, line }) {
  const doc = await RepoInsight.findOne({ project: project._id, kind: 'todos' });
  const item = doc?.data?.items?.find((i) => i.file === file && i.line === line);
  if (!item) throw new HttpError(404, 'todo_not_found', 'That TODO is not in the last scan');
  if (item.ticket) throw new HttpError(409, 'already_ticketed', `Already a ticket: ${item.ticket}`);
  const link = sourceUrl(project.source, { file, line, inApp: true }, null);
  const { ticket } = await createTicket(project, user, {
    title: `${item.kind}: ${item.text || `${file}:${line}`}`.slice(0, 200),
    description: `Found by the TODO scan in \`${file}\` line ${line}${link ? ` ([open on GitHub](${link}))` : ''}.`,
    type: 'task', labels: ['todo'],
  });
  item.ticket = ticket.key;
  doc.markModified('data');
  await doc.save();
  return ticket;
}

// ---------- GitHub Issues, both ways ----------

const issueBody = (project, ticket) => `${ticket.description || ''}\n\n---\n_Tracked in Tessera as ${ticketKey(project, ticket.number)}._`.trim();

export async function importIssues(project) {
  const repo = repoOf(project);
  const list = await gh(project, 'GET', `/repos/${repo}/issues?state=open&per_page=100`);
  let imported = 0;
  let skipped = 0;
  for (const issue of list ?? []) {
    if (issue.pull_request) continue;
    if (await Ticket.exists({ project: project._id, 'githubIssue.number': issue.number })) { skipped += 1; continue; }
    await ticketFromIssue(project, issue);
    imported += 1;
  }
  return { imported, skipped };
}

async function ticketFromIssue(project, issue) {
  const labels = (issue.labels ?? []).map((l) => String(typeof l === 'string' ? l : l.name).toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 10);
  const { ticket } = await createTicket(project, null, {
    title: String(issue.title).slice(0, 200), description: String(issue.body ?? '').slice(0, 20_000),
    type: labels.includes('bug') ? 'bug' : 'task', labels,
  }, { source: 'github', quiet: true });
  await Ticket.updateOne({ _id: ticket.id }, { $set: { githubIssue: { number: issue.number, url: issue.html_url, state: issue.state } } });
  return ticket;
}

export async function createIssue(project, ticket) {
  if (ticket.githubIssue?.number) throw new HttpError(409, 'already_linked', `Already linked to issue #${ticket.githubIssue.number}`);
  const repo = repoOf(project);
  const issue = await gh(project, 'POST', `/repos/${repo}/issues`, { title: ticket.title, body: issueBody(project, ticket) });
  ticket.githubIssue = { number: issue.number, url: issue.html_url, state: issue.state };
  await ticket.save();
  return ticket.githubIssue;
}

// Tessera -> GitHub: title, description and open/closed. Comments are not sent: they are often
// internal, and issues on a public repository are public.
async function pushToIssue(project, ticket, events) {
  if (!ticket.githubIssue?.number || !project.github?.issues?.sync || !hasGithub(project)) return;
  const patch = {};
  for (const e of events) {
    if (e.type === 'updated' && e.field === 'title') patch.title = ticket.title;
    if (e.type === 'updated' && e.field === 'description') patch.body = issueBody(project, ticket);
    if (e.type === 'status_changed') {
      if (isDone(project, e.to) && !isDone(project, e.from)) Object.assign(patch, { state: 'closed', state_reason: 'completed' });
      if (!isDone(project, e.to) && isDone(project, e.from)) patch.state = 'open';
    }
  }
  if (!Object.keys(patch).length) return;
  try {
    const issue = await gh(project, 'PATCH', `/repos/${repoOf(project)}/issues/${ticket.githubIssue.number}`, patch);
    await Ticket.updateOne({ _id: ticket._id }, { $set: { 'githubIssue.state': issue.state } });
  } catch (err) {
    project.github.issues.lastError = { message: err.message, at: new Date() };
    await project.save();
  }
}
onTicketEvents((project, ticket, events) => pushToIssue(project, ticket, events));

// GitHub -> Tessera, from the webhook. Changes made by Tessera's own token are skipped (no loops).
export async function issueFromDelivery(project, event, payload) {
  if (!project.github?.issues?.sync || !['issues', 'issue_comment'].includes(event)) return null;
  const issue = payload.issue;
  if (!issue || issue.pull_request) return null;
  if (payload.sender?.login && payload.sender.login === project.github.tokenLogin) return { skipped: 'own_change' };
  let ticket = await Ticket.findOne({ project: project._id, 'githubIssue.number': issue.number, deletedAt: null });
  if (event === 'issues' && payload.action === 'opened' && !ticket) {
    const made = await ticketFromIssue(project, issue);
    return { created: made.key };
  }
  if (!ticket) return null;
  const at = new Date();
  if (event === 'issues') {
    const events = [];
    if (payload.action === 'edited') {
      if (payload.changes?.title && issue.title !== ticket.title) { events.push({ type: 'updated', field: 'title', from: ticket.title, to: issue.title }); ticket.title = String(issue.title).slice(0, 200); }
      if (payload.changes?.body) { events.push({ type: 'updated', field: 'description', from: null, to: null }); ticket.description = String(issue.body ?? '').replace(/\n*---\n_Tracked in Tessera as [A-Z0-9]+-\d+\._\s*$/, '').slice(0, 20_000); }
      if (events.length) {
        await ticket.save();
        await TicketEvent.insertMany(events.map((e) => ({ project: project._id, ticket: ticket._id, actor: null, source: 'github', at, ...e })));
      }
    }
    if (payload.action === 'closed' && !isDone(project, ticket.status)) await moveFromIntegration(project, ticket, project.statuses.find((s) => s.category === 'done').key, 'github');
    if (payload.action === 'reopened' && isDone(project, ticket.status)) await moveFromIntegration(project, ticket, (project.statuses.find((s) => s.category === 'todo') ?? project.statuses[0]).key, 'github');
    await Ticket.updateOne({ _id: ticket._id }, { $set: { 'githubIssue.state': issue.state } });
  }
  if (event === 'issue_comment' && payload.action === 'created') {
    const c = payload.comment;
    const comment = await Comment.create({
      project: project._id, ticket: ticket._id, author: null, body: String(c.body ?? '').slice(0, 10_000),
      external: { source: 'github', login: c.user?.login ?? null, url: c.html_url ?? null },
    });
    await TicketEvent.create({ project: project._id, ticket: ticket._id, actor: null, source: 'github', type: 'commented', to: { comment: comment._id }, at });
  }
  ticket = await Ticket.findById(ticket._id).populate([{ path: 'assignee', select: 'name email' }, { path: 'reporter', select: 'name email' }]);
  publish(String(project._id), 'ticket', { action: 'updated', actorId: null, ticket: serializeTicket(ticket, project) });
  return { updated: ticketKey(project, ticket.number) };
}
