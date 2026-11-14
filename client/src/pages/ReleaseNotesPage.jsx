import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, FileText } from 'lucide-react';
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { useProject } from '../lib/queries.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { Button, EmptyState, Field, Spinner } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const minus = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

// Everything finished in a period, grouped by type, as Markdown for GitHub Releases or a changelog.
export default function ReleaseNotesPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: project, error } = useProject(projectId);
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(minus(today(), 13));
  const [version, setVersion] = useState('');
  const [view, setView] = useState('preview');
  const params = new URLSearchParams({ from, to, ...(version.trim() && { version: version.trim() }) });
  const { data, isFetching, error: notesError } = useQuery({
    queryKey: ['release-notes', projectId, params.toString()],
    queryFn: () => api(`/projects/${projectId}/release-notes?${params}`),
    enabled: Boolean(project) && from <= to,
    placeholderData: (prev) => prev,
  });
  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Release notes' }]}
        title={<ProjectSwitcher project={project} />}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" className="input" value={to} min={from} max={today()} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
          <Field label="Version (optional)"><input className="input" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1.4.0" maxLength={40} /></Field>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant={view === 'preview' ? 'secondary' : 'ghost'} onClick={() => setView('preview')}>Preview</Button>
            <Button size="sm" variant={view === 'markdown' ? 'secondary' : 'ghost'} onClick={() => setView('markdown')}>Markdown</Button>
            <Button size="sm" variant="primary" disabled={!data} onClick={() => copyText(data.markdown, 'Markdown copied')}><Copy className="size-3.5" />Copy</Button>
          </div>
        </div>
        {notesError && <p className="text-small text-danger">{notesError.message}</p>}
        {!data && isFetching && <div className="grid place-items-center py-16"><Spinner className="size-6 text-fg-subtle" /></div>}
        {data && (
          <div className="card p-6">
            <p className="mb-4 flex items-center gap-2 text-caption text-fg-subtle"><FileText className="size-3.5" />{data.count} finished ticket{data.count === 1 ? '' : 's'}{isFetching && <Spinner />}</p>
            {view === 'preview' ? <Markdown text={data.markdown} /> : <pre className="overflow-auto whitespace-pre-wrap rounded-tile border border-line bg-sunken p-4 font-code text-caption text-fg">{data.markdown}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
