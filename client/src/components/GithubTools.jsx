import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  AlertTriangle, CheckCircle2, CircleDot, Clock, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestDraft, ListTodo,
  RefreshCw, Search, Users, XCircle,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { formatDate, roleAtLeast, timeAgo } from '../lib/format.js';
import { Badge, Button, Spinner } from './ui.jsx';
import { ask } from './confirm.jsx';
import { EmptyNote } from '../ds/core.jsx';

// GitHub deep integration (E7): pull request status, issue link, suspect commit, code health,
// and the settings for the project's GitHub token, card moves and issue sync.

// ---------- pull request chips ----------

export function PrChips({ pr }) {
  if (!pr) return null;
  const chips = [];
  if (pr.state === 'merged') chips.push(<Badge key="m" tone="brand"><GitMerge className="size-3" />Merged</Badge>);
  else if (pr.state === 'closed') chips.push(<Badge key="c">Closed</Badge>);
  else if (pr.draft) chips.push(<Badge key="d"><GitPullRequestDraft className="size-3" />Draft</Badge>);
  if (pr.state === 'open') {
    if (pr.review === 'approved') chips.push(<Badge key="r" tone="teal"><CheckCircle2 className="size-3" />Approved</Badge>);
    if (pr.review === 'changes_requested') chips.push(<Badge key="r" tone="amber"><XCircle className="size-3" />Changes requested</Badge>);
    if (pr.review === 'requested') chips.push(<Badge key="r"><Clock className="size-3" />Review requested</Badge>);
    if (pr.conflicts) chips.push(<Badge key="x" tone="red"><AlertTriangle className="size-3" />Conflicts</Badge>);
  }
  if (pr.ci === 'success') chips.push(<Badge key="ci" tone="teal"><CheckCircle2 className="size-3" />CI passing</Badge>);
  if (pr.ci === 'failure') chips.push(<Badge key="ci" tone="red"><XCircle className="size-3" />CI failing</Badge>);
  if (pr.ci === 'pending') chips.push(<Badge key="ci"><CircleDot className="size-3" />CI running</Badge>);
  if (pr.sourceChanged && !pr.testsChanged) chips.push(<Badge key="t" tone="amber" title="Code changed in this pull request, but no test file did">No test changes</Badge>);
  return <span className="flex flex-wrap gap-1">{chips}</span>;
}

// The most important thing about a card's pull requests, as one small badge.
export function CardPrBadge({ links }) {
  const prs = (links ?? []).filter((l) => l.pr).map((l) => l.pr);
  if (!prs.length) return links?.length ? <GitPullRequest className="size-3" aria-label="Linked to GitHub" /> : null;
  const open = prs.filter((p) => p.state === 'open');
  const label = open.some((p) => p.ci === 'failure') ? ['CI failing', 'red']
    : open.some((p) => p.conflicts) ? ['Conflicts', 'red']
      : open.some((p) => p.review === 'changes_requested') ? ['Changes requested', 'amber']
        : open.some((p) => p.review === 'approved') ? ['Approved', 'teal']
          : prs.every((p) => p.state === 'merged') ? ['Merged', 'brand']
            : open.some((p) => p.draft) ? ['Draft PR', 'zinc'] : ['PR open', 'zinc'];
  const tone = { red: 'bg-danger/12 text-danger', amber: 'bg-warning/12 text-warning', teal: 'bg-success/12 text-success', brand: 'bg-accent-soft text-accent', zinc: 'bg-hover text-fg-muted' }[label[1]];
  return <span className={clsx('inline-flex items-center gap-0.5 rounded-hair px-1 font-medium', tone)}><GitPullRequest className="size-3" aria-hidden />{label[0]}</span>;
}

// ---------- drawer: links, PR status, the GitHub issue ----------

export function GithubLinks({ project, ticket, canWork }) {
  const qc = useQueryClient();
  const pid = project.id;
  const done = () => { qc.invalidateQueries({ queryKey: qk.ticket(pid, ticket.number) }); };
  const refresh = useMutation({ mutationFn: () => api(`/projects/${pid}/tickets/${ticket.number}/github/refresh`, { method: 'POST' }), onSuccess: done, onError: (e) => toast.error(e.message) });
  const issue = useMutation({ mutationFn: () => api(`/projects/${pid}/tickets/${ticket.number}/github/issue`, { method: 'POST' }), onSuccess: (r) => { toast.success(`Opened issue #${r.githubIssue.number}`); done(); }, onError: (e) => toast.error(e.message) });
  const hasToken = Boolean(project.github?.token);
  const prs = (ticket.links ?? []).some((l) => l.kind === 'pull_request');
  if (!ticket.links?.length && !ticket.githubIssue && !ticket.mergedAt && !(hasToken && canWork)) return null;
  return (
    <section className="border-t border-line pt-6">
      <h3 className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle">
        <GitPullRequest className="size-3.5" />{ticket.links?.some((l) => l.kind === 'merge_request') ? 'Code' : 'GitHub'}
        {hasToken && prs && canWork && (
          <button type="button" className="ml-auto inline-flex items-center gap-1 font-normal normal-case tracking-normal text-fg-subtle hover:text-accent" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw className={clsx('size-3', refresh.isPending && 'animate-spin')} />Check pull requests now
          </button>
        )}
      </h3>
      {ticket.mergedAt && (
        <p className="mb-2 flex items-center gap-2 text-small">
          {ticket.shipped ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <Clock className="size-4 text-warning" aria-hidden />}
          {ticket.shipped
            ? <span>Live in {ticket.shipped.environment} since {formatDate(ticket.shipped.at)} (release <span className="font-code">{ticket.shipped.release}</span>)</span>
            : <span>Merged {formatDate(ticket.mergedAt)}, not deployed to production yet</span>}
        </p>
      )}
      {ticket.githubIssue && (
        <p className="mb-2 flex items-center gap-2 text-small">
          <CircleDot className={clsx('size-4', ticket.githubIssue.state === 'closed' ? 'text-fg-subtle' : 'text-success')} />
          <a href={ticket.githubIssue.url} target="_blank" rel="noreferrer" className="hover:underline">Issue #{ticket.githubIssue.number}</a>
          <span className="text-caption text-fg-subtle">{ticket.githubIssue.state}{project.github?.issueSync ? ', kept in sync' : ''}</span>
        </p>
      )}
      {ticket.links?.length > 0 && (
        <ul className="space-y-2">
          {ticket.links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-small hover:underline">
                {l.kind === 'pull_request' ? <GitPullRequest className="size-4 text-status-done" /> : l.kind === 'merge_request' ? <GitMerge className="size-4 text-prio-high" aria-label="GitLab merge request" /> : <GitCommitHorizontal className="size-4 text-fg-subtle" />}
                <span className="font-code text-caption text-fg-subtle">{l.ref}</span>
                <span className="truncate">{l.title}</span>
                {l.author && <span className="ml-auto shrink-0 text-caption text-fg-subtle">{l.author}</span>}
              </a>
              {l.pr && l.kind === 'merge_request' && (
                <div className="ml-6 mt-1 flex flex-wrap items-center gap-1 text-micro">
                  <Badge tone={l.pr.state === 'merged' ? 'teal' : l.pr.state === 'closed' ? 'zinc' : 'brand'}>{l.pr.draft ? 'draft' : l.pr.state}</Badge>
                  {l.pr.pipeline && <Badge tone={l.pr.pipeline === 'success' ? 'teal' : l.pr.pipeline === 'failed' ? 'red' : 'amber'}>pipeline {l.pr.pipeline}</Badge>}
                  {l.pr.mergeStatus && l.pr.state === 'opened' && <span className="text-fg-subtle">{String(l.pr.mergeStatus).replace(/_/g, ' ')}</span>}
                </div>
              )}
              {l.pr && l.kind !== 'merge_request' && <div className="ml-6 mt-1 flex flex-wrap items-center gap-1"><PrChips pr={l.pr} /><span className="text-micro text-fg-subtle">checked {timeAgo(l.pr.checkedAt)}</span></div>}
            </li>
          ))}
        </ul>
      )}
      {!ticket.githubIssue && hasToken && canWork && (
        <Button size="sm" variant="ghost" className="mt-2" loading={issue.isPending} onClick={() => issue.mutate()}><CircleDot className="size-3.5" />Open a GitHub issue for this</Button>
      )}
    </section>
  );
}

// ---------- crash: suspect commit and who knows the file ----------

export function SuspectCommit({ pid, ticket, canWork, hasToken }) {
  const qc = useQueryClient();
  const s = ticket.error?.suspect;
  const look = useMutation({
    mutationFn: () => api(`/projects/${pid}/tickets/${ticket.number}/github/suspect`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.ticket(pid, ticket.number) }),
    onError: (e) => toast.error(e.message),
  });
  const assign = useMutation({
    mutationFn: (id) => api(`/projects/${pid}/tickets/${ticket.number}`, { method: 'PATCH', body: { assigneeId: id } }),
    onSuccess: () => { toast.success('Assigned'); qc.invalidateQueries({ queryKey: qk.ticket(pid, ticket.number) }); },
    onError: (e) => toast.error(e.message),
  });
  if (!hasToken && !s) return null;
  return (
    <div>
      <h4 className="mb-1 flex items-center gap-1.5 text-caption font-semibold"><Search className="size-3.5" aria-hidden />Suspect commit</h4>
      {!s && <p className="text-caption text-fg-subtle">The last change to the crashing file before it was first seen, and who knows that file best.</p>}
      {s && !s.found && <p className="text-caption text-fg-subtle">{s.reason}</p>}
      {s?.found && (
        <div className="space-y-1.5 text-caption">
          <p>
            In <a href={s.fileUrl ?? undefined} target="_blank" rel="noreferrer" className="font-code underline">{s.file}:{s.line}</a>
            {s.suspect ? <>, the last change before the crash was first seen: <a href={s.suspect.url} target="_blank" rel="noreferrer" className="font-code underline">{s.suspect.short}</a> &ldquo;{s.suspect.message}&rdquo; by {s.suspect.author ?? 'someone'}{s.suspect.date && <> on {formatDate(s.suspect.date)}</>}.</> : ': no commit to this file before the crash was first seen.'}
          </p>
          {s.candidates?.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5">
              <Users className="size-3.5 text-fg-subtle" aria-hidden />
              Most commits to this file: {s.candidates.map((c) => `${c.member?.name ?? c.login ?? c.name} (${c.commits})`).join(', ')}.
              {s.suggested && canWork && ticket.assignee?.id !== s.suggested.id && (
                <Button size="sm" variant="ghost" loading={assign.isPending} onClick={() => assign.mutate(s.suggested.id)}>Assign {s.suggested.name}</Button>
              )}
            </p>
          )}
          <p className="text-micro text-fg-subtle">Looked up {timeAgo(s.checkedAt)}.</p>
        </div>
      )}
      {hasToken && canWork && <Button size="sm" variant="ghost" className="mt-1" loading={look.isPending} onClick={() => look.mutate()}><GitCommitHorizontal className="size-3.5" />{s ? 'Look again' : 'Look it up on GitHub'}</Button>}
    </div>
  );
}

// ---------- analytics: code health ----------

export function CodeHealth({ project }) {
  const qc = useQueryClient();
  const pid = project.id;
  const isManager = roleAtLeast(project.myRole, 'manager');
  const canWork = roleAtLeast(project.myRole, 'developer');
  const { data } = useQuery({ queryKey: ['code-health', pid], queryFn: () => api(`/projects/${pid}/github/insights`), enabled: canWork });
  const refresh = () => qc.invalidateQueries({ queryKey: ['code-health', pid] });
  const knowledge = useMutation({ mutationFn: () => api(`/projects/${pid}/github/knowledge`, { method: 'POST' }), onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const todos = useMutation({ mutationFn: () => api(`/projects/${pid}/github/todos`, { method: 'POST' }), onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const ticket = useMutation({ mutationFn: (item) => api(`/projects/${pid}/github/todos/ticket`, { method: 'POST', body: { file: item.file, line: item.line } }), onSuccess: (r) => { toast.success(`Made ${r.ticket.key}`); refresh(); }, onError: (e) => toast.error(e.message) });
  if (!canWork || !data) return null;
  const hasToken = Boolean(project.github?.token);
  return (
    <section className="card p-4">
      <h3 className="text-small font-semibold">Code health</h3>
      <p className="mt-0.5 text-caption text-fg-subtle">Where bugs and crashes keep landing, which parts of the code only one person knows, and the TODOs left in it.</p>
      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <div>
          <p className="mb-1 text-caption font-medium">Bug hotspots</p>
          {!data.hotspots.length ? <EmptyNote size="xs">No crash or bug-fix pull request points at a file yet.</EmptyNote> : (
            <ul className="space-y-1 text-caption">
              {data.hotspots.slice(0, 8).map((h) => (
                <li key={h.file} className="flex gap-2"><span className="min-w-0 flex-1 truncate font-code" title={h.file}>{h.file}</span><span className="shrink-0 text-fg-subtle">{[h.bugFixes && `${h.bugFixes} fix${h.bugFixes === 1 ? '' : 'es'}`, h.crashes && `${h.crashes} crash${h.crashes === 1 ? '' : 'es'}`].filter(Boolean).join(' · ')}</span></li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 flex items-center justify-between text-caption font-medium">Knowledge risk {isManager && hasToken && <Button size="sm" variant="ghost" loading={knowledge.isPending} onClick={() => knowledge.mutate()}>{data.knowledge ? 'Again' : 'Analyse'}</Button>}</p>
          {!data.knowledge ? <p className="text-caption text-fg-subtle">{hasToken ? 'Reads the last 180 days of commits (up to 100) to find code only one person changes.' : 'Needs a GitHub token (Settings → GitHub).'}</p> : (
            <>
              <ul className="space-y-1 text-caption">
                {data.knowledge.areas.filter((a) => a.risk).slice(0, 6).map((a) => <li key={a.dir}><span className="font-code">{a.dir}</span> <span className="text-fg-subtle">· {Math.round(a.share * 100)}% by {a.topAuthor} over {a.commits} commits</span></li>)}
                {!data.knowledge.areas.some((a) => a.risk) && <li className="text-fg-subtle">No area where one person made 75%+ of the changes (5+ commits).</li>}
              </ul>
              <p className="mt-1 text-micro text-fg-subtle">{data.knowledge.commits} commits read, {timeAgo(data.knowledge.at)}.</p>
            </>
          )}
        </div>
        <div>
          <p className="mb-1 flex items-center justify-between text-caption font-medium">TODOs in the code {isManager && hasToken && <Button size="sm" variant="ghost" loading={todos.isPending} onClick={() => todos.mutate()}>{data.todos ? 'Scan again' : 'Scan'}</Button>}</p>
          {!data.todos ? <p className="text-caption text-fg-subtle">{hasToken ? 'Finds TODO, FIXME, HACK and XXX comments (up to 400 files).' : 'Needs a GitHub token (Settings → GitHub).'}</p> : (
            <>
              <ul className="max-h-48 space-y-1 overflow-y-auto text-caption">
                {data.todos.items.slice(0, 50).map((i) => (
                  <li key={`${i.file}:${i.line}`} className="flex items-start gap-1.5">
                    <ListTodo className="mt-0.5 size-3 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0 flex-1"><span className="font-code text-fg-subtle">{i.file}:{i.line}</span> {i.kind}: {i.text || '(no text)'}</span>
                    {i.ticket ? <Link to={`/projects/${pid}/tickets/${i.ticket}`} className="shrink-0 font-code underline">{i.ticket}</Link>
                      : <button type="button" className="shrink-0 text-accent underline " onClick={() => ticket.mutate(i)}>Make ticket</button>}
                  </li>
                ))}
                {!data.todos.items.length && <li className="text-fg-subtle">None found.</li>}
              </ul>
              <p className="mt-1 text-micro text-fg-subtle">{data.todos.items.length} found in {data.todos.files} files{data.todos.skipped ? `, ${data.todos.skipped} files not read (limit)` : ''}, {timeAgo(data.todos.at)}.</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- settings ----------

export function GithubDeepSettings({ project, Section }) {
  const qc = useQueryClient();
  const pid = project.id;
  const isAdmin = project.myRole === 'admin';
  const { data } = useQuery({ queryKey: ['github-deep', pid], queryFn: () => api(`/projects/${pid}/github`).then((d) => d.github) });
  const [token, setToken] = useState('');
  const set = (r) => { qc.setQueryData(['github-deep', pid], r.github); qc.invalidateQueries({ queryKey: qk.project(pid) }); };
  const save = useMutation({ mutationFn: () => api(`/projects/${pid}/github/token`, { method: 'PUT', body: { token } }), onSuccess: (r) => { set(r); setToken(''); toast.success(`Connected as ${r.github.login}`); }, onError: (e) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: () => api(`/projects/${pid}/github/token`, { method: 'DELETE' }), onSuccess: set, onError: (e) => toast.error(e.message) });
  const options = useMutation({ mutationFn: (body) => api(`/projects/${pid}/github/options`, { method: 'PUT', body }), onSuccess: (r) => { set(r); toast.success('Saved'); }, onError: (e) => toast.error(e.message) });
  const importIssues = useMutation({ mutationFn: () => api(`/projects/${pid}/github/issues/import`, { method: 'POST' }), onSuccess: (r) => toast.success(`Imported ${r.imported} issue${r.imported === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already here` : ''}`), onError: (e) => toast.error(e.message) });
  if (!data) return <Spinner className="text-fg-subtle" />;
  const columns = project.statuses.filter((s) => s.category !== 'done');
  return (
    <Section title="GitHub token" description="Lets Tessera read the repository: pull request status on cards, suspect commits, code health, and two-way issue sync. Use a fine-grained token for just this repository.">
      <div className="space-y-4 text-small">
        {!data.repoNow && <p className="text-caption text-warning">Set the repository in Source code (below) first.</p>}
        {data.set ? (
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="teal">Connected</Badge> as <b>{data.login}</b> to <span className="font-code">{data.repo}</span>{!data.canWrite && <Badge tone="amber">read only</Badge>}
            {isAdmin && <Button size="sm" variant="ghost" loading={remove.isPending} onClick={async () => { if (await ask('Remove the GitHub token?')) remove.mutate(); }}>Remove</Button>}
          </p>
        ) : isAdmin ? (
          <div className="space-y-2">
            <p className="text-caption text-fg-subtle">On GitHub: Settings → Developer settings → Fine-grained tokens → only this repository, with read access to Contents, Pull requests, Commit statuses and Checks, and read and write on Issues (only if you want issue sync).</p>
            <div className="flex gap-2">
              <input type="password" autoComplete="off" className="input h-9 font-code text-caption" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" aria-label="GitHub token" />
              <Button variant="primary" loading={save.isPending} disabled={!token.trim() || !data.repoNow} onClick={() => save.mutate()}>Connect</Button>
            </div>
            <p className="text-micro text-fg-subtle">Stored encrypted and never shown again.</p>
          </div>
        ) : <p className="text-caption text-fg-subtle">Not connected. An admin can add a token.</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-caption">When a branch for a ticket appears, move it to
            <select className="input mt-1 h-9 text-small" value={data.moves.branch ?? ''} onChange={(e) => options.mutate({ moves: { ...data.moves, branch: e.target.value || null } })}>
              <option value="">Don&apos;t move</option>{columns.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-caption">When a pull request is ready, move it to
            <select className="input mt-1 h-9 text-small" value={data.moves.pr ?? ''} onChange={(e) => options.mutate({ moves: { ...data.moves, pr: e.target.value || null } })}>
              <option value="">Don&apos;t move</option>{columns.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <p className="text-micro text-fg-subtle">Branches and pull requests are matched by the ticket key in their name, title or text ({project.key}-12). Cards only move forward; finished ones stay finished. Needs the webhook above with the Branch or tag creation and Pull requests events.</p>

        <div className="space-y-2 border-t border-line pt-3 ">
          <label className="flex items-center gap-2 text-small">
            <input type="checkbox" className="accent-accent" checked={data.issues.sync} disabled={!data.set} onChange={(e) => options.mutate({ issues: { sync: e.target.checked } })} />
            Keep GitHub issues and tickets in sync
          </label>
          <p className="text-micro text-fg-subtle">New GitHub issues become tickets; title, description and open/closed follow each other both ways; GitHub comments are copied in. Tessera comments are not sent to GitHub (they are often internal, and issues on a public repository are public). Needs the Issues and Issue comments webhook events.</p>
          {data.issues.lastError && <p className="text-caption text-danger">Last sync problem ({timeAgo(data.issues.lastError.at)}): {data.issues.lastError.message}</p>}
          {data.issues.sync && <Button size="sm" loading={importIssues.isPending} onClick={() => importIssues.mutate()}>Import open issues now</Button>}
        </div>
      </div>
    </Section>
  );
}
