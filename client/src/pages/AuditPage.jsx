import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, History } from 'lucide-react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/queries.js';
import { formatDate, formatDateTime, roleAtLeast, timeAgo } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { auditSentence } from '../components/AutomationSettings.jsx';
import { Avatar, Button, EmptyState, Spinner } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';

// The project audit log (E4C): who changed the project's setup, newest first.
const AREAS = [
  { key: '', label: 'Everything' },
  { key: 'people', label: 'People' },
  { key: 'setup', label: 'Setup' },
  { key: 'automation', label: 'Automation' },
  { key: 'planning', label: 'Planning' },
  { key: 'tickets', label: 'Bulk, import, export' },
];

export default function AuditPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: project, error } = useProject(projectId);
  const [area, setArea] = useState('');
  const isManager = roleAtLeast(project?.myRole, 'manager');
  const log = useInfiniteQuery({
    queryKey: ['audit', projectId, area],
    queryFn: ({ pageParam }) => api(`/projects/${projectId}/audit?${new URLSearchParams({ ...(area && { area }), ...(pageParam && { before: pageParam }) })}`),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: Boolean(project) && isManager,
  });
  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  // Grouped by day, newest first.
  const days = [];
  for (const e of entries) {
    const day = formatDate(e.at);
    if (days.at(-1)?.day !== day) days.push({ day, entries: [] });
    days.at(-1).entries.push(e);
  }
  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Settings', to: `/projects/${projectId}/settings` }, { label: 'Audit log' }]}
        title={<ProjectSwitcher project={project} />}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link to={`/projects/${projectId}/settings`} className="inline-flex items-center gap-1 text-small text-fg-subtle hover:text-fg"><ArrowLeft className="size-4" />Settings</Link>
          <h1 className="text-h2 font-semibold text-fg">Audit log</h1>
        </div>
        {!isManager ? (
          <EmptyState icon={History} title="Only managers and admins see this">The audit log shows who changed this project's setup. Ask a manager if you need to know about a change.</EmptyState>
        ) : (
          <>
            <p className="text-small text-fg-subtle">Changes to this project's setup, newest first, kept for a year. Edits to single tickets are in each ticket's own history.</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
              {AREAS.map((a) => (
                <button key={a.key} type="button" aria-pressed={area === a.key} onClick={() => setArea(a.key)}
                  className={clsx('rounded-full border px-3 py-1 text-caption font-medium',
                    area === a.key ? 'border-accent bg-accent-soft text-accent  ' : 'border-line text-fg-muted  ')}>
                  {a.label}
                </button>
              ))}
            </div>
            {log.isLoading && <div className="grid place-items-center py-10"><Spinner className="size-5 text-fg-subtle" /></div>}
            {log.error && <p className="text-small text-danger">{log.error.message}</p>}
            {log.data && entries.length === 0 && <EmptyState icon={History} title="Quiet so far">No setup changes to show here yet. Changes to members, columns, fields, templates and rules are written down here as they happen.</EmptyState>}
            {days.map((d) => (
              <section key={d.day} className="card p-4">
                <h2 className="mb-2 text-caption font-semibold uppercase tracking-wide text-fg-subtle">{d.day}</h2>
                <ol className="space-y-2.5">
                  {d.entries.map((e) => (
                    <li key={e.id} className="flex gap-2.5 text-small">
                      {e.actor ? <Avatar user={e.actor} size="sm" /> : <span className="size-5 shrink-0 rounded-full bg-press" />}
                      <span className="min-w-0 text-fg-muted">
                        <b className="font-medium text-fg">{e.actor?.name ?? 'A deleted account'}</b>{' '}
                        {auditSentence(e)}
                        <span className="ml-1.5 text-caption text-fg-subtle" title={formatDateTime(e.at)}>{timeAgo(e.at)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            {log.hasNextPage && <div className="text-center"><Button loading={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>Load older</Button></div>}
          </>
        )}
      </div>
    </div>
  );
}
