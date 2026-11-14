import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeftRight, Equal } from 'lucide-react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/queries.js';
import { formatDate } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { Badge, Button, EmptyState, KeyLink, Spinner } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';

// E5B: two crashes side by side. Frames both pass through are marked with "=" (not colour alone),
// and the sentences at the top say what is the same and what differs. It doesn't decide for you
// whether they are the same bug.

function Side({ s, pid }) {
  return (
    <div className="card min-w-0 p-4">
      <KeyLink to={`/projects/${pid}/tickets/${s.key}`}>{s.key}</KeyLink>
      <p className="mt-1 font-code text-small font-semibold text-danger">{s.type ?? 'Error'}</p>
      <p className="break-words font-code text-caption">{s.message}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge>{s.language}</Badge>
        <Badge tone={s.resolved ? 'zinc' : 'red'}>{s.occurrences}× · {s.resolved ? 'finished' : 'open'}</Badge>
        {s.firstSeenAt && <Badge>first {formatDate(s.firstSeenAt)}</Badge>}
        {s.browsers.slice(0, 2).map((b) => <Badge key={b.name} tone="teal">{b.name} {b.count}</Badge>)}
      </div>
      <ol className="mt-3 space-y-0.5 font-code text-micro">
        {s.frames.map((f, i) => (
          <li key={i} className={clsx('flex items-center gap-1.5 truncate rounded-hair px-1.5 py-0.5', f.shared && 'bg-accent-soft', !f.inApp && 'text-fg-subtle')}>
            <span className="w-3 shrink-0" aria-label={f.shared ? 'in both' : undefined}>{f.shared && <Equal className="size-3" />}</span>
            <span className="truncate">{f.fn ?? '<anonymous>'} <span className="text-fg-subtle">{f.file?.split(/[\\/]/).pop()}{f.line ? `:${f.line}` : ''}</span></span>
          </li>
        ))}
        {!s.frames.length && <li className="text-fg-subtle">No stack frames.</li>}
      </ol>
    </div>
  );
}

export default function ComparePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';
  const { data: project, error } = useProject(projectId);
  const { data: errors } = useQuery({ queryKey: ['errors', projectId], queryFn: () => api(`/projects/${projectId}/errors`).then((d) => d.errors), enabled: Boolean(project) });
  const ready = Boolean(a && b && a !== b);
  const cmp = useQuery({
    queryKey: ['compare', projectId, a, b],
    queryFn: () => api(`/projects/${projectId}/errors/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    enabled: Boolean(project) && ready,
  });

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const pick = (k) => (e) => setParams((p) => { const n = new URLSearchParams(p); n.set(k, e.target.value); return n; });
  const options = (errors ?? []).map((e) => <option key={e.key} value={e.key}>{e.key} · {e.errorType ?? 'Error'}: {e.message?.slice(0, 60)}</option>);

  return (
    <div>
      <PageHeader crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Compare crashes' }]} title={<ProjectSwitcher project={project} />}>
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input h-9 min-w-0 flex-1 text-small" value={a} onChange={pick('a')} aria-label="First crash"><option value="">Pick a crash…</option>{options}</select>
          <ArrowLeftRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
          <select className="input h-9 min-w-0 flex-1 text-small" value={b} onChange={pick('b')} aria-label="Second crash"><option value="">Pick another…</option>{options}</select>
        </div>
        {errors && errors.length < 2 && <p className="text-small text-fg-subtle">Comparing needs at least two tickets made from errors in this project.</p>}
        {a && b && a === b && <p className="text-small text-fg-subtle">Pick two different crashes.</p>}
        {cmp.isLoading && ready && <Spinner className="text-fg-subtle" />}
        {cmp.error && <p className="text-small text-danger">{cmp.error.message}</p>}
        {cmp.data && (
          <>
            <ul className="card list-disc space-y-1 p-4 pl-8 text-small">
              {cmp.data.points.map((p) => <li key={p}>{p}</li>)}
            </ul>
            <div className="grid gap-4 md:grid-cols-2">
              <Side s={cmp.data.a} pid={projectId} />
              <Side s={cmp.data.b} pid={projectId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
