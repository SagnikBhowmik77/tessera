import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { CheckCircle2, Copy, KeyRound, Rocket, XCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { useProject } from '../lib/queries.js';
import { formatDateTime, roleAtLeast, timeAgo } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { Badge, Button, EmptyState, Spinner } from '../components/ui.jsx';
import { TestsPanel } from '../components/DebugTools.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote } from '../ds/core.jsx';

// Deployments (E8): DORA numbers with their definitions, the deploy history, and (for managers)
// deploy tokens, recording a deploy by hand, held reporter emails, the status page and badge.

const hoursText = (h) => (h === null ? '—' : h >= 48 ? `${Math.round(h / 24 * 10) / 10} days` : `${h} h`);

function Metric({ title, value, sub, def }) {
  return (
    <div className="card p-4">
      <p className="text-caption font-medium text-fg-subtle">{title}</p>
      <p className="mt-1 text-title font-semibold tabular-nums">{value}</p>
      <p className="text-caption text-fg-subtle">{sub}</p>
      <p className="mt-2 text-micro leading-snug text-fg-subtle">{def}</p>
    </div>
  );
}

function Code({ label, code }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-caption text-fg-subtle"><span>{label}</span><Button size="sm" variant="ghost" onClick={() => copyText(code, 'Copied')}><Copy className="size-3.5" />Copy</Button></div>
      <pre className="overflow-x-auto rounded-tile border border-line bg-sunken p-3 font-code text-micro text-fg">{code}</pre>
    </div>
  );
}

function Manage({ project, data }) {
  const qc = useQueryClient();
  const pid = project.id;
  const refresh = () => qc.invalidateQueries({ queryKey: ['deploys', pid] });
  const s = data.settings;
  const [env, setEnv] = useState(s.production);
  const [release, setRelease] = useState('');
  const [made, setMade] = useState(null);
  const settings = useMutation({ mutationFn: (body) => api(`/projects/${pid}/deploys/settings`, { method: 'PUT', body }), onSuccess: () => { refresh(); toast.success('Saved'); }, onError: (e) => toast.error(e.message) });
  const record = useMutation({
    mutationFn: () => api(`/projects/${pid}/deploys`, { method: 'POST', body: { release: release.trim() } }),
    onSuccess: (r) => { setRelease(''); refresh(); toast.success(`Recorded ${r.deployment.release}${r.shipped.length ? `; now live: ${r.shipped.join(', ')}` : ''}`); },
    onError: (e) => toast.error(e.message),
  });
  const { data: keys } = useQuery({ queryKey: ['ingest-keys', pid], queryFn: () => api(`/projects/${pid}/ingest-keys`) });
  const token = useMutation({ mutationFn: () => api(`/projects/${pid}/ingest-keys`, { method: 'POST', body: { name: 'Deploys', kind: 'deploy' } }), onSuccess: (r) => { setMade(r.key); qc.invalidateQueries({ queryKey: ['ingest-keys', pid] }); }, onError: (e) => toast.error(e.message) });
  const tokens = (keys?.keys ?? []).filter((k) => k.kind === 'deploy' && !k.revokedAt);
  return (
    <section className="card space-y-5 p-4 text-small">
      <h2 className="text-small font-semibold">Deploy settings</h2>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-caption font-medium">Tell Tessera about deploys</p>
          <p className="text-caption text-fg-subtle">GitHub deployments arrive through the webhook (add the Deployment statuses event). Or call this from your pipeline after each deploy:</p>
          {made ? <Code label="Deploy token (shown once, keep it in your CI secrets)" code={made} /> : (
            <p className="flex items-center gap-2 text-caption">
              <KeyRound className="size-3.5 text-fg-subtle" />{tokens.length ? `${tokens.length} active deploy token${tokens.length === 1 ? '' : 's'}` : 'No deploy token yet'}
              <Button size="sm" loading={token.isPending} onClick={() => token.mutate()}>New deploy token</Button>
            </p>
          )}
          <Code label="After a successful deploy" code={`curl -X POST ${s.hookUrl} \\\n  -H "Authorization: Bearer $TESSERA_DEPLOY_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"release":"1.4.2","sha":"'$GITHUB_SHA'","environment":"${s.production}"}'`} />
          <Code label="CI test results (JUnit XML, with an upload token from Settings)" code={`curl -X POST ${s.hookUrl.replace(/\/deploys$/, '/test-results')} \\\n  -H "Authorization: Bearer $TESSERA_UPLOAD_TOKEN" \\\n  -F file=@junit.xml -F branch=main -F commit=$GITHUB_SHA`} />
          <div className="flex gap-2">
            <input className="input h-9 font-code text-small" value={release} onChange={(e) => setRelease(e.target.value)} placeholder="Release, e.g. 1.4.2" aria-label="Release to record" />
            <Button loading={record.isPending} disabled={!release.trim()} onClick={() => record.mutate()}><Rocket className="size-3.5" />Record a deploy</Button>
          </div>
        </div>
        <div className="space-y-3">
          <label className="block text-caption">Production environment name
            <span className="mt-1 flex gap-2"><input className="input h-9 font-code text-small" value={env} onChange={(e) => setEnv(e.target.value)} />{env !== s.production && <Button size="sm" onClick={() => settings.mutate({ production: env.trim() })}>Save</Button>}</span>
          </label>
          <label className="flex items-start gap-2 text-small">
            <input type="checkbox" className="mt-1 accent-accent" checked={s.emailAfterDeploy} onChange={(e) => settings.mutate({ emailAfterDeploy: e.target.checked })} />
            <span>Wait for the next production deploy before telling outside reporters their bug is fixed</span>
          </label>
          <label className="flex items-center gap-2 text-small">
            <input type="checkbox" className="accent-accent" checked={s.statusPage.enabled} onChange={(e) => settings.mutate({ statusPage: { enabled: e.target.checked } })} />
            Public status page and README badge
          </label>
          {s.statusPage.enabled && (
            <>
              <label className="flex items-center gap-2 text-caption"><input type="checkbox" className="accent-accent" checked={s.statusPage.showCrashes} onChange={(e) => settings.mutate({ statusPage: { showCrashes: e.target.checked } })} />Show how many crashes arrived in the last 24 hours</label>
              <p className="text-caption text-fg-subtle">The page shows the last production deploy, the deploy history and open tickets labelled <code className="font-code">incident</code>. Nothing else about the project.</p>
              <Code label="Status page" code={s.statusPage.pageUrl} />
              <Code label="README badge (show=status, release or deploys)" code={`![status](${s.statusPage.badgeUrl})`} />
              <img src={s.statusPage.badgeUrl} alt="Status badge preview" />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default function DeploysPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: project, error } = useProject(projectId);
  const [range, setRange] = useState('d30');
  const { data } = useQuery({ queryKey: ['deploys', projectId], queryFn: () => api(`/projects/${projectId}/deploys`), enabled: Boolean(project) });
  if (error) return <ProjectMissing error={error} />;
  if (!project || !data) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const d = data.dora[range];
  return (
    <div>
      <PageHeader crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Deploys' }]} title={<ProjectSwitcher project={project} />}>
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <h2 className="text-small font-semibold">Delivery (DORA), {d.environment}</h2>
          <div className="ml-auto flex gap-1">{[['d30', '30 days'], ['d90', '90 days']].map(([k, l]) => <Button key={k} size="sm" variant={range === k ? 'primary' : 'ghost'} onClick={() => setRange(k)}>{l}</Button>)}</div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric title="Deploy frequency" value={`${d.deploys.perWeek}/week`} sub={`${d.deploys.successful} successful of ${d.deploys.total}`} def="Successful production deploys per week." />
          <Metric title="Lead time for changes" value={hoursText(d.leadTime.hours)} sub={`median of ${d.leadTime.tickets} ticket${d.leadTime.tickets === 1 ? '' : 's'}`} def="From the merge that finished a ticket to the production deploy that shipped it." />
          <Metric title="Change failure rate" value={d.changeFailure.rate === null ? '—' : `${d.changeFailure.rate}%`} sub={`${d.changeFailure.failed} of ${d.changeFailure.of} deploys`} def="Deploys that failed, or were followed within 24 hours by a crash coming back or a new crash reporting that release." />
          <Metric title="Time to restore" value={hoursText(d.timeToRestore.hours)} sub={`median of ${d.timeToRestore.incidents} comeback${d.timeToRestore.incidents === 1 ? '' : 's'}`} def="From a finished crash coming back to its ticket being finished again." />
        </div>

        <section className="card p-4">
          <h2 className="mb-2 text-small font-semibold">Deploys</h2>
          {!data.deployments.length ? <EmptyNote>No deploys recorded yet.</EmptyNote> : (
            <ul className="divide-y divide-line text-small ">
              {data.deployments.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2 py-2">
                  {x.status === 'success' ? <CheckCircle2 className="size-4 text-success" aria-label="Succeeded" /> : <XCircle className="size-4 text-danger" aria-label="Failed" />}
                  <span className="font-code">{x.release ?? '—'}</span>
                  <Badge tone={x.environment === d.environment ? 'brand' : 'zinc'}>{x.environment}</Badge>
                  {x.shipped > 0 && <span className="text-caption text-fg-subtle">shipped {x.shipped} ticket{x.shipped === 1 ? '' : 's'}</span>}
                  <span className={clsx('ml-auto text-caption text-fg-subtle')} title={formatDateTime(x.at)}>{timeAgo(x.at)} · {x.source === 'github' ? 'GitHub' : x.source === 'hook' ? 'deploy hook' : 'by hand'}</span>
                  {x.url && <a href={x.url} target="_blank" rel="noreferrer" className="text-caption underline">open</a>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <TestsPanel project={project} />

        {roleAtLeast(project.myRole, 'manager') && !project.archivedAt && <Manage project={project} data={data} />}
      </div>
    </div>
  );
}
