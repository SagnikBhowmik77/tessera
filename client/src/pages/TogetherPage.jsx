import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Copy, Siren, ThumbsUp, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { useProject, useProjectLive } from '../lib/queries.js';
import { formatDate, formatDateTime, roleAtLeast } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { Badge, Button, EmptyState, KeyLink, Spinner } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote } from '../ds/core.jsx';

// Live collaboration II (E10): estimating together, retro boards and incidents. All state is
// stored on the server and pushed to everyone with the project open.

function useAct(keys) {
  const qc = useQueryClient();
  const [error, setError] = useState(null);
  const m = useMutation({
    mutationFn: ({ path, method = 'POST', body }) => api(path, { method, body }),
    onMutate: () => setError(null),
    onError: (e) => setError(e.message),
    onSettled: () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  });
  return { run: (path, body, method) => m.mutateAsync({ path, body, method }).catch(() => null), busy: m.isPending, error };
}

const Err = ({ children }) => (children ? <p role="alert" className="text-small text-danger">{children}</p> : null);

function Poker({ pid, canWork }) {
  const [params] = useSearchParams();
  const [ref, setRef] = useState(params.get('ticket') ?? '');
  const { data } = useQuery({ queryKey: ['poker', pid], queryFn: () => api(`/projects/${pid}/poker`).then((d) => d.rounds) });
  const act = useAct([['poker', pid]]);
  const base = `/projects/${pid}/poker`;
  return (
    <div className="space-y-4">
      {canWork && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (ref.trim()) act.run(base, { ticket: ref.trim() }).then((r) => r && setRef('')); }}>
          <label className="text-small">
            <span className="mb-1 block font-medium">Estimate a ticket</span>
            <input className="input w-40" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. 12" />
          </label>
          <Button type="submit" variant="primary" loading={act.busy}>Start a round</Button>
        </form>
      )}
      <Err>{act.error}</Err>
      {!data ? <Spinner className="text-fg-subtle" /> : !data.length ? (
        <EmptyNote>No estimate rounds are open. Start one here or with "Estimate together" on a ticket.</EmptyNote>
      ) : data.map((r) => {
        // While voting, the only value the server shows you is your own.
        const myVote = r.status === 'voting' ? r.votes.find((v) => v.value !== null)?.value : null;
        return (
          <section key={r.id} className="card space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                <KeyLink to={`/projects/${pid}/tickets/${r.ticket?.key}`}>{r.ticket?.key}</KeyLink> {r.ticket?.title}
              </h3>
              <span className="text-caption text-fg-subtle">started by {r.startedBy ?? 'a former member'}{r.ticket?.storyPoints != null && ` · now ${r.ticket.storyPoints} points`}</span>
            </div>
            {r.status === 'voting' && canWork && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Your estimate">
                {r.values.map((v) => (
                  <button key={v} type="button" aria-pressed={myVote === v} onClick={() => act.run(`${base}/${r.id}/vote`, { value: v }, 'PUT')}
                    className={clsx('h-14 w-10 rounded-tile border text-h3 font-semibold tabular-nums', myVote === v ? 'border-key-line bg-key-bg text-fg  ' : 'border-line-strong hover:border-fg-faint ')}>
                    {v}
                  </button>
                ))}
              </div>
            )}
            <ul className="flex flex-wrap gap-2 text-small">
              {r.votes.map((v) => (
                <li key={v.user} className="rounded-tile border border-line px-2 py-1 ">
                  {v.name}: <strong className="tabular-nums">{v.value ?? 'voted'}</strong>
                </li>
              ))}
              {!r.votes.length && <li className="text-fg-subtle">No votes yet.</li>}
            </ul>
            {r.stats && (
              <p className="text-small">
                {r.stats.consensus ? `Everyone agreed: ${r.stats.min}.` : `From ${r.stats.min} to ${r.stats.max}, middle ${r.stats.median}.`}
                {r.stats.unsure > 0 && ` ${r.stats.unsure} not sure.`}
              </p>
            )}
            {canWork && (
              <div className="flex flex-wrap gap-2">
                {r.status === 'voting' && <Button size="sm" disabled={!r.votes.length} onClick={() => act.run(`${base}/${r.id}/reveal`)}>Show votes</Button>}
                {r.status === 'revealed' && (
                  <>
                    {[...new Set(r.votes.map((v) => v.value).filter((v) => v !== '?'))].sort((a, b) => a - b).map((v) => (
                      <Button key={v} size="sm" variant="primary" onClick={() => act.run(`${base}/${r.id}/accept`, { points: Number(v) })}>Use {v}</Button>
                    ))}
                    <Button size="sm" onClick={() => act.run(`${base}/${r.id}/revote`)}>Vote again</Button>
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RetroBoard({ pid, rid, canWork, canManage, onBack }) {
  const { data: retro } = useQuery({ queryKey: ['retro', pid, rid], queryFn: () => api(`/projects/${pid}/retros/${rid}`).then((d) => d.retro) });
  const act = useAct([['retro', pid, rid], ['retros', pid]]);
  const [drafts, setDrafts] = useState({});
  if (!retro) return <Spinner className="text-fg-subtle" />;
  const base = `/projects/${pid}/retros/${rid}`;
  const open = retro.status === 'open';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="text-small underline" onClick={onBack}>All retros</button>
        <h3 className="font-semibold">{retro.title}</h3>
        <Badge tone={open ? 'teal' : 'zinc'}>{open ? 'Open' : 'Closed'}</Badge>
        {open && <span className="text-caption text-fg-subtle">{retro.votesLeft} of {retro.votesPerPerson} votes left</span>}
        {open && canManage && <Button size="sm" className="ml-auto" onClick={() => act.run(`${base}/close`)}>Close retro</Button>}
      </div>
      <Err>{act.error}</Err>
      <div className="grid gap-3 md:grid-cols-3">
        {retro.columns.map((c) => (
          <section key={c.key} className="card min-w-0 space-y-2 p-3">
            <h4 className="text-small font-semibold">{c.name}</h4>
            {retro.items.filter((i) => i.column === c.key).map((i) => (
              <article key={i.id} className="rounded-tile border border-line p-2 text-small ">
                <p className="whitespace-pre-wrap break-words">{i.text}</p>
                <div className="mt-1.5 flex items-center gap-2 text-caption text-fg-subtle">
                  <span>{i.author ?? 'Former member'}</span>
                  {i.ticket && <Link to={`/projects/${pid}/tickets/${i.ticket}`} className="font-code underline">{i.ticket}</Link>}
                  <span className="ml-auto flex items-center gap-2">
                    {open && canWork && c.key === 'actions' && !i.ticket && (
                      <button type="button" className="underline" onClick={() => act.run(`${base}/items/${i.id}/ticket`)}>Make a ticket</button>
                    )}
                    {open && i.mine && (
                      <button type="button" aria-label="Delete note" onClick={() => act.run(`${base}/items/${i.id}`, undefined, 'DELETE')}><Trash2 className="size-3.5" /></button>
                    )}
                    <button type="button" disabled={!open || !canWork} aria-pressed={i.voted} aria-label={`Vote (${i.votes})`}
                      onClick={() => act.run(`${base}/items/${i.id}/vote`)}
                      className={clsx('flex items-center gap-1 rounded-hair px-1', i.voted && 'text-accent ')}>
                      <ThumbsUp className="size-3.5" /> <span className="tabular-nums">{i.votes}</span>
                    </button>
                  </span>
                </div>
              </article>
            ))}
            {open && canWork && (
              <form onSubmit={(e) => { e.preventDefault(); const text = (drafts[c.key] ?? '').trim(); if (text) act.run(`${base}/items`, { column: c.key, text }).then((r) => r && setDrafts((d) => ({ ...d, [c.key]: '' }))); }}>
                <textarea className="input min-h-16 w-full text-small" maxLength={500} placeholder="Add a note" aria-label={`Add a note to ${c.name}`} value={drafts[c.key] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))} />
                <Button type="submit" size="sm" className="mt-1">Add</Button>
              </form>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function Retros({ pid, canWork, canManage }) {
  const [openId, setOpenId] = useState(null);
  const [title, setTitle] = useState('');
  const { data } = useQuery({ queryKey: ['retros', pid], queryFn: () => api(`/projects/${pid}/retros`).then((d) => d.retros) });
  const act = useAct([['retros', pid]]);
  if (openId) return <RetroBoard pid={pid} rid={openId} canWork={canWork} canManage={canManage} onBack={() => setOpenId(null)} />;
  const create = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const r = await act.run(`/projects/${pid}/retros`, { title: title.trim() });
    if (r) { setTitle(''); setOpenId(r.retro.id); }
  };
  return (
    <div className="space-y-4">
      {canWork && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={create}>
          <label className="text-small"><span className="mb-1 block font-medium">New retro</span><input className="input w-64" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sprint 4" maxLength={120} /></label>
          <Button type="submit" variant="primary" loading={act.busy}>Create</Button>
        </form>
      )}
      <Err>{act.error}</Err>
      {!data ? <Spinner className="text-fg-subtle" /> : !data.length ? <EmptyNote>No retros yet.</EmptyNote> : (
        <ul className="divide-y divide-line rounded-tile border border-line  ">
          {data.map((r) => (
            <li key={r.id}>
              <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-small hover:bg-hover " onClick={() => setOpenId(r.id)}>
                <span className="font-medium">{r.title}</span>
                <Badge tone={r.status === 'open' ? 'teal' : 'zinc'}>{r.status === 'open' ? 'Open' : 'Closed'}</Badge>
                <span className="ml-auto text-caption text-fg-subtle">{r.items} notes · {formatDate(r.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IncidentView({ pid, inc, canWork, members }) {
  const act = useAct([['incidents', pid]]);
  const [note, setNote] = useState('');
  const [rootCause, setRootCause] = useState(inc.rootCause);
  const [lessons, setLessons] = useState(inc.lessons);
  const [md, setMd] = useState(null);
  const base = `/projects/${pid}/incidents/${inc.id}`;
  const open = inc.status === 'open';
  return (
    <section className={clsx('card space-y-3 p-4', open && 'border-danger/45 ')}>
      <div className="flex flex-wrap items-center gap-2">
        <Siren className={clsx('size-4', open ? 'text-danger' : 'text-fg-subtle')} aria-hidden />
        <h3 className="font-semibold">{inc.title}</h3>
        <Badge tone={open ? 'red' : 'zinc'}>{open ? 'Ongoing' : 'Resolved'}</Badge>
        <Badge>{inc.severity.toUpperCase()}</Badge>
        {inc.ticket && <Link to={`/projects/${pid}/tickets/${inc.ticket}`} className="font-code text-caption underline">{inc.ticket}</Link>}
        <span className="ml-auto text-caption text-fg-subtle">since {formatDateTime(inc.startedAt)}{inc.resolvedAt && ` · resolved ${formatDateTime(inc.resolvedAt)}`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-small">
        <span>Commander:</span>
        {open && canWork ? (
          <select className="input w-48" aria-label="Incident commander" value={inc.commander?.id ?? ''} onChange={(e) => act.run(base, { commanderId: e.target.value }, 'PATCH')}>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : <strong>{inc.commander?.name ?? 'nobody'}</strong>}
      </div>
      <ol className="space-y-1 border-l-2 border-line pl-3 text-small ">
        {inc.timeline.map((e, i) => (
          <li key={i}><span className="text-caption tabular-nums text-fg-subtle">{formatDateTime(e.at)}</span> {e.text}{e.author && <span className="text-fg-subtle"> ({e.author})</span>}</li>
        ))}
      </ol>
      <Err>{act.error}</Err>
      {open && canWork && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) act.run(base, { note: note.trim() }, 'PATCH').then((r) => r && setNote('')); }}>
          <input className="input flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What just happened?" aria-label="Timeline note" maxLength={2000} />
          <Button type="submit">Add to timeline</Button>
        </form>
      )}
      {canWork && (
        <div className="grid gap-2 md:grid-cols-2">
          <label className="text-small"><span className="mb-1 block font-medium">Root cause</span><textarea className="input min-h-20 w-full" value={rootCause} onChange={(e) => setRootCause(e.target.value)} maxLength={5000} /></label>
          <label className="text-small"><span className="mb-1 block font-medium">Lessons</span><textarea className="input min-h-20 w-full" value={lessons} onChange={(e) => setLessons(e.target.value)} maxLength={5000} /></label>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {canWork && (rootCause !== inc.rootCause || lessons !== inc.lessons) && <Button size="sm" onClick={() => act.run(base, { rootCause, lessons }, 'PATCH')}>Save notes</Button>}
        {open && canWork && <Button size="sm" variant="primary" onClick={() => act.run(`${base}/resolve`, {})}>Mark resolved</Button>}
        <Button size="sm" onClick={() => api(`${base}/postmortem`).then((d) => setMd(d.markdown))}>Postmortem</Button>
      </div>
      {md && (
        <div className="space-y-2">
          <Button size="sm" onClick={() => copyText(md)}><Copy className="size-3.5" /> Copy Markdown</Button>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-tile bg-hover p-3 text-caption ">{md}</pre>
        </div>
      )}
    </section>
  );
}

function Incidents({ pid, canWork, members }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('sev2');
  const { data } = useQuery({ queryKey: ['incidents', pid], queryFn: () => api(`/projects/${pid}/incidents`).then((d) => d.incidents) });
  const act = useAct([['incidents', pid]]);
  return (
    <div className="space-y-4">
      {canWork && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim()) act.run(`/projects/${pid}/incidents`, { title: title.trim(), severity }).then((r) => r && setTitle('')); }}>
          <label className="text-small"><span className="mb-1 block font-medium">Start an incident</span><input className="input w-72" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is broken?" maxLength={180} /></label>
          <select className="input w-24" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
            <option value="sev1">SEV1</option><option value="sev2">SEV2</option><option value="sev3">SEV3</option>
          </select>
          <Button type="submit" variant="primary" loading={act.busy}>Start</Button>
        </form>
      )}
      <Err>{act.error}</Err>
      {!data ? <Spinner className="text-fg-subtle" /> : !data.length ? <EmptyNote>No incidents. Starting one opens a critical ticket, records a timeline, and writes a postmortem from it.</EmptyNote>
        : data.map((inc) => <IncidentView key={inc.id} pid={pid} inc={inc} canWork={canWork} members={members} />)}
    </div>
  );
}

const SECTIONS = [['poker', 'Estimate together'], ['retros', 'Retros'], ['incidents', 'Incidents']];

export default function TogetherPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: project, error } = useProject(projectId);
  useProjectLive(projectId);
  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const tab = SECTIONS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'poker';
  const canWork = roleAtLeast(project.myRole, 'developer');
  const canManage = roleAtLeast(project.myRole, 'manager');
  const members = project.members.filter((m) => m.role !== 'viewer').map((m) => ({ id: m.user.id, name: m.user.name }));
  return (
    <div>
      <PageHeader crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Together' }]} title={<ProjectSwitcher project={project} />}>
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <div className="flex gap-1" role="tablist">
          {SECTIONS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k })}
              className={clsx('rounded-tile px-3 py-1.5 text-small font-medium', tab === k ? 'bg-raised text-fg shadow-raised ' : 'text-fg-muted hover:bg-hover  ')}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'poker' && <Poker pid={projectId} canWork={canWork} />}
        {tab === 'retros' && <Retros pid={projectId} canWork={canWork} canManage={canManage} />}
        {tab === 'incidents' && <Incidents pid={projectId} canWork={canWork} members={members} />}
      </div>
    </div>
  );
}
