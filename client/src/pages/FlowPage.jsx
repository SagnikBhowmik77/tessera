import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowRight, Copy, Info } from 'lucide-react';
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { useProject } from '../lib/queries.js';
import { formatDate, roleAtLeast } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { Button, KeyLink, Spinner } from '../components/ui.jsx';
import {
  ChartCard, DataTable, Legend, TYPE_COLOR, TYPE_ORDER, Tip, axis, barCursor, baseAxis, grid, shortDay, useChartMotion,
} from '../components/charts.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote } from '../ds/core.jsx';

// Flow analytics II (E9): what to do next, when it will be done, why work is slow, and the project
// at a glance. Every number comes from the team's own history.

function Card({ title, sub, children, className }) {
  return (
    <section className={clsx('card min-w-0 p-4', className)}>
      <h2 className="text-small font-semibold">{title}</h2>
      {sub && <p className="mt-0.5 text-caption text-fg-subtle">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function NextBest({ pid, canWork }) {
  const { data } = useQuery({ queryKey: ['flow-next', pid], queryFn: () => api(`/projects/${pid}/flow/next`).then((d) => d.next), enabled: canWork });
  if (!canWork) return null;
  return (
    <Card title="What to work on next" sub="Your tickets and unowned ones, ranked by what is started, overdue, late on its service level, blocking others, urgent or in the sprint.">
      {!data ? <Spinner className="text-fg-subtle" /> : !data.length ? <EmptyNote>Nothing open for you.</EmptyNote> : (
        <ol className="space-y-2 text-small">
          {data.map((t, i) => (
            <li key={t.key} className="flex gap-2">
              <span className="w-4 shrink-0 text-right tabular-nums text-fg-subtle">{i + 1}.</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <KeyLink to={`/projects/${pid}/tickets/${t.key}`} className="mr-1.5">{t.key}</KeyLink>{t.title}
                <span className="block text-caption text-fg-subtle">{t.reasons.join(' · ') || 'nothing urgent about it'}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Forecast({ pid, hasSprint }) {
  const [scope, setScope] = useState('open');
  const [add, setAdd] = useState(0);
  const [pace, setPace] = useState(100);
  const [days, setDays] = useState(14);
  const { data, error, isFetching } = useQuery({
    queryKey: ['forecast', pid, scope, add, pace, days],
    queryFn: () => api(`/projects/${pid}/flow/forecast?scope=${scope}&add=${add}&factor=${pace / 100}&days=${days}`),
    placeholderData: (p) => p,
  });
  return (
    <Card title="When will it be done?" sub="10,000 simulated futures, each day drawn from a real day of the last 6 weeks. 85% means 85 of every 100 simulations finished by then.">
      <div className="grid gap-3 text-caption sm:grid-cols-2">
        <label>Work<select className="input mt-1 h-8 text-caption" value={scope} onChange={(e) => setScope(e.target.value)}><option value="open">All open tickets</option>{hasSprint && <option value="sprint">The running sprint</option>}</select></label>
        <label>What if we add or drop tickets: <b>{add > 0 ? `+${add}` : add}</b><input type="range" min={-20} max={40} value={add} onChange={(e) => setAdd(Number(e.target.value))} className="mt-2 w-full" /></label>
        <label>What if the team's pace is <b>{pace}%</b><input type="range" min={30} max={200} step={10} value={pace} onChange={(e) => setPace(Number(e.target.value))} className="mt-2 w-full" /></label>
        <label>How many in the next<span className="mt-1 flex items-center gap-1"><input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} className="input h-8 w-20 text-caption" /> days</span></label>
      </div>
      {error && <p className="mt-3 text-small text-danger">{error.message}</p>}
      {data && !data.enough && <p className="mt-3 flex items-start gap-2 text-small text-fg-muted"><Info className="mt-0.5 size-4 shrink-0" />{data.reason}</p>}
      {data?.enough && (
        <div className={clsx('mt-4 grid gap-4 sm:grid-cols-2', isFetching && 'opacity-60')}>
          <div>
            <p className="text-caption text-fg-subtle">{data.items} {data.scope.replace(/^all /, '')}{data.add ? ` (${data.add > 0 ? '+' : ''}${data.add} what-if)` : ''}</p>
            {data.whenDone ? (
              <table className="mt-1 text-small"><tbody>
                {[['50% chance', 'p50'], ['85% chance', 'p85'], ['95% chance', 'p95']].map(([l, k]) => <tr key={k}><td className="pr-4 text-fg-subtle">{l}</td><td className="font-medium tabular-nums">{formatDate(data.whenDone[k].date)}</td><td className="pl-3 text-caption text-fg-subtle">{data.whenDone[k].days} days</td></tr>)}
              </tbody></table>
            ) : <p className="mt-1 text-small">Nothing left to do.</p>}
          </div>
          <div>
            <p className="text-caption text-fg-subtle">Finished in the next {data.howMany.days} days, at least</p>
            <table className="mt-1 text-small"><tbody>
              {[['50% chance', 'p50'], ['85% chance', 'p85'], ['95% chance', 'p95']].map(([l, k]) => <tr key={k}><td className="pr-4 text-fg-subtle">{l}</td><td className="font-medium tabular-nums">{data.howMany[k]} tickets</td></tr>)}
            </tbody></table>
          </div>
          <p className="text-micro text-fg-subtle sm:col-span-2">Based on {data.sample.finished} tickets finished over {data.sample.days} days ({data.sample.zeroDays} days with none){data.factor !== 1 ? `, scaled to ${Math.round(data.factor * 100)}% pace` : ''}.</p>
        </div>
      )}
    </Card>
  );
}

// Work mix: finished work by type, stacked bug, feature, task in the same colours as the type
// icons (red never beside green), with a surface gap between segments.
const TYPE_NAME = { bug: 'Bugs', feature: 'Features', task: 'Tasks' };

function Insights({ pid }) {
  const enter = useChartMotion();
  const { data } = useQuery({ queryKey: ['flow-insights', pid], queryFn: () => api(`/projects/${pid}/flow/insights`) });
  if (!data) return <Spinner className="text-fg-subtle" />;
  return (
    <>
      <Card title="Why work is slow" sub={`Rules checked against the last 30 days (${data.window.finished} finished, ${data.window.perDay} a day) and today's board.`}>
        {!data.bottlenecks.length ? <EmptyNote>No bottlenecks right now. Work is flowing.</EmptyNote> : (
          <ul className="space-y-1.5 text-small">{data.bottlenecks.map((b, i) => <li key={i} className="flex items-start gap-2"><AlertTriangle className={clsx('mt-0.5 size-4 shrink-0', b.severity === 'high' ? 'text-danger' : b.severity === 'medium' ? 'text-warning' : 'text-fg-subtle')} aria-label={b.severity} />{b.text}</li>)}</ul>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="WIP limit suggestions" sub="How many tickets each in-progress column needs at once to keep today's pace.">
          {!data.wip.length ? <p className="text-small text-fg-subtle">Needs at least 5 finished tickets in the last 30 days.</p> : (
            <ul className="space-y-3 text-small">{data.wip.map((w) => (
              <li key={w.status}>
                <p className="flex flex-wrap items-center gap-2"><b>{w.name}</b><span className="text-caption text-fg-subtle">now {w.now} · limit {w.limit ?? 'none'}</span><ArrowRight className="size-3.5 text-fg-subtle" /><span className="font-medium">suggested {w.suggested}</span></p>
                <p className="text-caption text-fg-subtle">{w.reason}</p>
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Estimate accuracy" sub="Finished tickets with story points, last 90 days: days from starting to finishing.">
          <p className="text-small">{data.estimates.verdict}{data.estimates.rho !== null && <span className="text-caption text-fg-subtle"> (rank correlation {data.estimates.rho})</span>}</p>
          {data.estimates.groups.length > 0 && (
            <table className="mt-2 w-full text-caption"><thead><tr className="text-left text-fg-subtle"><th className="py-1">Points</th><th>Tickets</th><th>Median days</th><th>Range</th></tr></thead><tbody>
              {data.estimates.groups.map((g) => <tr key={g.points} className="border-t border-line"><td className="py-1">{g.points}</td><td>{g.tickets}</td><td>{g.medianDays}</td><td>{g.minDays}–{g.maxDays}</td></tr>)}
            </tbody></table>
          )}
        </Card>
        <Card title="Rework" sub="Finished in the last 30 days, then reopened.">
          <p className="text-title font-semibold tabular-nums">{data.rework.rate === null ? '—' : `${data.rework.rate}%`}</p>
          <p className="text-caption text-fg-subtle">{data.rework.reopened} of {data.rework.finished} finished tickets came back: {data.rework.byCrash} by a crash returning, {data.rework.byHand} reopened by hand, {data.rework.byGithub} from GitHub.</p>
        </Card>
        <ChartCard
          title="Work mix"
          subtitle={`What finished work was, per week (last 12 weeks, ${data.mix.total} tickets).`}
          table={<DataTable head={['Week from', 'Bugs', 'Features', 'Tasks']} rows={data.mix.weeks.map((w) => [shortDay(w.week), w.bug, w.feature, w.task])} />}
        >
          {data.mix.total === 0 ? <EmptyNote>Nothing finished in the last 12 weeks yet.</EmptyNote> : (
            <>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.mix.weeks} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="week" tickFormatter={shortDay} minTickGap={20} {...baseAxis} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip cursor={barCursor} content={<Tip labelFormat={(d) => `Week from ${shortDay(d)}`} total="Finished" />} />
                    {TYPE_ORDER.map((t, i) => (
                      <Bar key={t} dataKey={t} name={TYPE_NAME[t]} stackId="m" fill={TYPE_COLOR[t]} stroke="var(--c-surface)" strokeWidth={1.5} maxBarSize={28} radius={i === TYPE_ORDER.length - 1 ? [4, 4, 0, 0] : 0} {...enter} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Legend items={TYPE_ORDER.map((t) => ({ key: t, name: TYPE_NAME[t], color: TYPE_COLOR[t] }))} />
            </>
          )}
          {data.mix.labels.length > 0 && <p className="mt-2 text-caption text-fg-subtle">Top labels: {data.mix.labels.map((l) => `${l.label} (${l.count})`).join(', ')}</p>}
        </ChartCard>
      </div>
    </>
  );
}

function Standup({ pid }) {
  const { data } = useQuery({ queryKey: ['standup', pid], queryFn: () => api(`/projects/${pid}/flow/standup`) });
  return (
    <Card title="Standup" sub={data ? `From the history since ${formatDate(data.since)}: what each person finished and moved, what they have in progress, what blocks them.` : ''}>
      {!data ? <Spinner className="text-fg-subtle" /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {data.people.map((p) => (
              <div key={p.id} className="text-small">
                <p className="font-medium">{p.name}</p>
                <p className="text-caption text-fg-muted">Finished: {p.finished.length ? p.finished.join('; ') : 'nothing'}</p>
                {p.moved.length > 0 && <p className="text-caption text-fg-muted">Moved: {p.moved.join('; ')}</p>}
                <p className="text-caption text-fg-muted">Today: {p.today.length ? p.today.join('; ') : 'nothing in progress'}</p>
                {p.blocked.length > 0 && <p className="text-caption text-danger">Blocked: {p.blocked.join('; ')}</p>}
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => copyText(data.text, 'Standup copied')}><Copy className="size-3.5" />Copy as text</Button>
        </>
      )}
    </Card>
  );
}

const isoDay = (d) => d.toISOString().slice(0, 10);
function Compare({ pid, statuses }) {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 7 * 86400000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const at = (day, end) => new Date(`${day}T${end ? '23:59' : '00:00'}:00+05:30`).toISOString();
  const toAt = to >= isoDay(new Date()) ? new Date().toISOString() : at(to, true);
  const { data, error } = useQuery({ queryKey: ['compare-dates', pid, from, to], queryFn: () => api(`/projects/${pid}/flow/compare?from=${encodeURIComponent(at(from))}&to=${encodeURIComponent(toAt)}`), enabled: from < to });
  const name = (k) => statuses.find((s) => s.key === k)?.name ?? k;
  return (
    <Card title="Compare two dates" sub="The board at the start of one day against the end of another, rebuilt from the history. To watch it change, use time travel on the board and press Replay.">
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <input type="date" className="input h-8 w-auto text-caption" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="From" />
        <ArrowRight className="size-3.5 text-fg-subtle" />
        <input type="date" className="input h-8 w-auto text-caption" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="To" />
      </div>
      {error && <p className="mt-2 text-small text-danger">{error.message}</p>}
      {data && (
        <div className="mt-3 space-y-2 text-small">
          <p className="flex flex-wrap gap-3 text-caption">{data.columns.map((c) => <span key={c.key}><b>{c.name}</b> {c.from} → {c.to}</span>)}</p>
          <p className="text-caption text-fg-subtle">{data.added.length} added · {data.finished} finished · {data.moved.length} moved · {data.reassigned.length} reassigned · {data.removed.length} binned</p>
          {data.moved.length > 0 && <ul className="max-h-40 space-y-0.5 overflow-y-auto text-caption">{data.moved.map((m) => <li key={m.key}><KeyLink to={`/projects/${pid}/tickets/${m.key}`}>{m.key}</KeyLink> {m.title}: {name(m.from)} → {name(m.to)}</li>)}</ul>}
        </div>
      )}
    </Card>
  );
}

const TILE = { todo: 'bg-status-todo/50', in_progress: 'bg-status-progress', done: 'bg-status-done' };
function Mosaic({ pid }) {
  const { data } = useQuery({ queryKey: ['mosaic', pid], queryFn: () => api(`/projects/${pid}/flow/mosaic`).then((d) => d.tiles) });
  return (
    <Card title="Project Mosaic" sub="One tile per ticket, in order. Colour is where it is; a red ring means blocked, a dark dot means a crash.">
      {!data ? <Spinner className="text-fg-subtle" /> : !data.length ? <EmptyNote>No tickets yet.</EmptyNote> : (
        <>
          <div className="flex flex-wrap gap-1" role="list" aria-label="Tickets">
            {data.map((t) => (
              <Link key={t.key} to={`/projects/${pid}/tickets/${t.key}`} role="listitem" title={`${t.key} ${t.title} · ${t.status} · ${t.ageDays} days${t.blocked ? ' · blocked' : ''}${t.crash ? ' · crash' : ''}`}
                className={clsx('relative size-4 rounded-shard', TILE[t.category] ?? TILE.todo, t.blocked && 'ring-2 ring-danger ring-offset-1 ring-offset-surface')}>
                {t.crash && <span className="absolute inset-1 rounded-full bg-fg/70" />}
                <span className="sr-only">{t.key} {t.title}, {t.status}</span>
              </Link>
            ))}
          </div>
          <p className="mt-3 flex flex-wrap gap-3 text-caption text-fg-subtle">
            {[['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']].map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className={clsx('size-3 rounded-shard', TILE[k])} />{l} ({data.filter((t) => (t.category ?? 'todo') === k).length})</span>)}
          </p>
        </>
      )}
    </Card>
  );
}

export default function FlowPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { data: project, error } = useProject(projectId);
  const { data: sprints } = useQuery({ queryKey: ['sprints', projectId], queryFn: () => api(`/projects/${projectId}/sprints`), enabled: Boolean(project) });
  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const hasSprint = (sprints?.sprints ?? []).some((s) => s.state === 'active');
  return (
    <div>
      <PageHeader crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Flow' }]} title={<ProjectSwitcher project={project} />}>
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <NextBest pid={projectId} canWork={roleAtLeast(project.myRole, 'developer')} />
          <Forecast pid={projectId} hasSprint={hasSprint} />
        </div>
        <Insights pid={projectId} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Standup pid={projectId} />
          <Compare pid={projectId} statuses={project.statuses} />
        </div>
        <Mosaic pid={projectId} />
      </div>
    </div>
  );
}
