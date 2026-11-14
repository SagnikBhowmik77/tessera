import { useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowLeft, Ban, CalendarRange, Target } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk, useProject, useProjectLive } from '../lib/queries.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import {
  ChartCard, CountUp, Legend, OTHER, SERIES, Sparkline, Tip, activeDot, axis, barCursor, baseAxis, chartDefs, crosshair, fillRef, grid, gridV,
  shortDay, statusPaint, useChartId, useChartMotion, useDark,
} from '../components/charts.jsx';
import { Badge, Button, EmptyState, KeyLink, Spinner, TypeIcon } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote } from '../ds/core.jsx';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hrs = (h) => (h === 0 ? '0' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} d`);

// A sprint number, counted up, with a sparkline where the report has a real series behind it.
function Tile({ label, count, sub, tone, spark }) {
  return (
    <div className="card min-w-0 p-4">
      <div className="truncate text-caption font-medium text-fg-subtle">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className={clsx('text-title font-semibold tabular-nums tracking-tight', tone)}><CountUp value={count.value} format={count.format} /></div>
        {spark && <div className="mb-0.5 hidden shrink-0 sm:block">{spark}</div>}
      </div>
      {sub && <div className="text-caption text-fg-subtle">{sub}</div>}
    </div>
  );
}

function TicketList({ projectId, title, hint, tickets, extra }) {
  if (!tickets.length) return null;
  return (
    <section className="card" aria-label={title}>
      <header className="border-b border-line px-4 py-3 ">
        <h2 className="text-small font-semibold">{title} <span className="font-normal text-fg-subtle">· {tickets.length}</span></h2>
        {hint && <p className="text-caption text-fg-subtle">{hint}</p>}
      </header>
      <ul className="divide-y divide-line">
        {tickets.map((t) => (
          <li key={t.key} className="flex items-center gap-2 px-4 py-2 text-small">
            <TypeIcon type={t.type} />
            <KeyLink to={`/projects/${projectId}/tickets/${t.key}`}>{t.key}</KeyLink>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {extra?.(t)}
            <span className="hidden text-caption text-fg-subtle sm:inline">{t.statusName}</span>
            {t.storyPoints !== null && <Badge>{t.storyPoints} pt</Badge>}
            {t.assignee && <span className="hidden w-24 truncate text-right text-caption text-fg-subtle md:inline">{t.assignee}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Remaining work as a line over a soft gradient (done violet: what is left to finish), scope as a
// stepped line, and the ideal as a dashed neutral.
function Burndown({ report }) {
  const dark = useDark();
  const mode = dark ? 'dark' : 'light';
  const uid = useChartId();
  const enter = useChartMotion();
  const unit = report.unit === 'points' ? 'points' : 'tickets';
  const data = report.burndown.map((p) => ({ day: p.day, Remaining: p.remaining, Scope: p.scope, Ideal: p.ideal }));
  // With a single day of data there is no line to draw, so show the point.
  const single = data.filter((d) => d.Remaining !== null).length === 1;
  return (
    <ChartCard
      title="Burndown"
      subtitle={`${unit === 'points' ? 'Story points' : 'Tickets'} left at the end of each day, against a straight line to zero. Scope rises when work is added mid-sprint.`}
      table={(
        <table className="w-full text-small">
          <thead><tr className="text-left text-caption text-fg-subtle"><th className="py-1">Day</th><th className="text-right">Remaining</th><th className="text-right">Scope</th><th className="text-right">Ideal</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day} className="border-t border-line">
                <td className="py-1">{shortDay(d.day)}</td>
                <td className="text-right tabular-nums">{d.Remaining ?? '—'}</td>
                <td className="text-right tabular-nums">{d.Scope ?? '—'}</td>
                <td className="text-right tabular-nums">{d.Ideal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    >
      <div className="h-64">
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
            {chartDefs(uid, [{ id: 'remaining', color: SERIES[mode][0] }])}
            <CartesianGrid {...grid} />
            <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={16} {...baseAxis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip cursor={crosshair} content={<Tip labelFormat={shortDay} format={(v) => (v === null || v === undefined ? '—' : `${v} ${unit}`)} />} />
            <Line type="linear" dataKey="Ideal" stroke={OTHER[mode]} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={false} {...enter} />
            <Line type="stepAfter" dataKey="Scope" stroke={SERIES[mode][1]} strokeWidth={2} dot={single ? { r: 3 } : false} activeDot={activeDot} {...enter} />
            <Area type="linear" dataKey="Remaining" stroke={SERIES[mode][0]} strokeWidth={2} fill={fillRef(uid, 'remaining')} dot={{ r: 3, strokeWidth: 0, fill: SERIES[mode][0] }} activeDot={activeDot} {...enter} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ key: 'r', name: 'Remaining', color: SERIES[mode][0] }, { key: 's', name: 'Scope', color: SERIES[mode][1] }, { key: 'i', name: 'Ideal', color: OTHER[mode], dashed: true }]} />
    </ChartCard>
  );
}

// Each column in its status colour, as on the board (a second column of a category hatched).
function Waited({ report }) {
  const mode = useDark() ? 'dark' : 'light';
  const uid = useChartId();
  const enter = useChartMotion();
  const data = report.waited.map((w) => ({ key: w.status, name: w.name, hours: w.hours }));
  const paint = statusPaint(report.waited.map((w) => ({ key: w.status, category: w.category })), data.map((d) => d.key), mode);
  return (
    <ChartCard
      title="Where work waited"
      subtitle="Time the sprint's tickets spent in each unfinished column while in the sprint"
      table={(
        <table className="w-full text-small">
          <thead><tr className="text-left text-caption text-fg-subtle"><th className="py-1">Column</th><th className="text-right">Time</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.name} className="border-t border-line"><td className="py-1">{d.name}</td><td className="text-right tabular-nums">{hrs(d.hours)}</td></tr>)}</tbody>
        </table>
      )}
    >
      {data.length === 0 ? <EmptyNote>No time recorded yet.</EmptyNote> : (
        <div style={{ height: Math.max(96, data.length * 40 + 24) }}>
          <ResponsiveContainer>
            <BarChart layout="vertical" data={data} margin={{ top: 0, right: 56, left: 8, bottom: 0 }}>
              {chartDefs(uid, data.filter((d) => paint[d.key].texture).map((d) => ({ id: d.key, ...paint[d.key] })))}
              <CartesianGrid {...gridV} />
              <XAxis type="number" tickFormatter={hrs} {...axis} />
              <YAxis type="category" dataKey="name" width={96} {...baseAxis} />
              <Tooltip cursor={barCursor} content={<Tip format={(v) => hrs(v)} colorOf={(_, p) => paint[p.payload.key].color} />} />
              <Bar dataKey="hours" name="Time" radius={[0, 4, 4, 0]} maxBarSize={18} {...enter}>
                {data.map((d) => <Cell key={d.key} fill={paint[d.key].texture ? fillRef(uid, d.key) : paint[d.key].color} stroke={paint[d.key].texture ? paint[d.key].color : undefined} />)}
                <LabelList dataKey="hours" position="right" formatter={(v) => hrs(v)} fill="var(--c-fg-muted)" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="mt-4 border-t border-line pt-3 ">
        <h3 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Ban className="size-3.5" />Blocked</h3>
        {report.blocked.tickets.length === 0 ? <EmptyNote className="mt-1">Nothing in this sprint was blocked.</EmptyNote> : (
          <>
            <p className="mt-1 text-small">{hrs(report.blocked.totalHours)} blocked in total.</p>
            <ul className="mt-2 space-y-1 text-small">
              {report.blocked.byReason.map((r) => (
                <li key={r.reason} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg-muted">{r.reason}</span>
                  <span className="tabular-nums text-fg-subtle">{hrs(r.hours)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </ChartCard>
  );
}

// The retro report for a running or finished sprint: what was committed, what was added or taken
// out mid-sprint, what got finished, what slipped (and where it went), and where the work waited.
export default function SprintReportPage() {
  const { projectId, sprintId } = useParams();
  const navigate = useNavigate();
  const { data: project, error } = useProject(projectId);
  const onDeleted = useCallback(() => { toast('This project was deleted, so you are back on your projects.'); navigate('/projects'); }, [navigate]);
  useProjectLive(projectId, { onProjectDeleted: onDeleted });
  const { data: report, error: reportError } = useQuery({
    queryKey: qk.sprintReport(projectId, sprintId),
    queryFn: () => api(`/projects/${projectId}/sprints/${sprintId}/report`).then((d) => d.report),
    enabled: Boolean(project),
    retry: false,
  });

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const s = report?.sprint;
  const points = report?.unit === 'points';
  const amount = (x) => (points ? `${x.points} pt` : plural(x.count, 'ticket'));
  const sub = (x) => (points ? plural(x.count, 'ticket') : null);
  const pick = (x) => (points ? x.points : x.count);
  const scopeEnd = report && pick(report.summary.committed) + pick(report.summary.added) - pick(report.summary.removed);
  const finished = report && pick(report.summary.completed);
  // Counted tiles: points, or tickets in words. The Finished tile also shows how much was done by
  // the end of each day so far (scope minus what remained), straight from the burndown.
  const countOf = (x) => ({ value: pick(x), format: (n) => (points ? `${Math.round(n)} pt` : plural(Math.round(n), 'ticket')) });
  const doneByDay = report ? report.burndown.filter((p) => p.remaining !== null && p.scope !== null).map((p) => p.scope - p.remaining) : [];

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Sprints', to: `/projects/${projectId}/sprints` }, { label: s?.name ?? 'Report' }]}
        title={<ProjectSwitcher project={project} />}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <Link to={`/projects/${projectId}/sprints`} className="inline-flex items-center gap-1 text-small text-fg-subtle hover:text-fg"><ArrowLeft className="size-4" />All sprints</Link>
        {reportError && <EmptyState title="No report" action={<Button onClick={() => navigate(`/projects/${projectId}/sprints`)}>Back to sprints</Button>}>{reportError.message}</EmptyState>}
        {!report && !reportError && <div className="grid place-items-center py-16"><Spinner className="size-6 text-fg-subtle" /></div>}
        {report && (
          <>
            <div>
              <h1 className="flex flex-wrap items-center gap-2 text-h2 font-semibold">
                {s.name} retro
                {s.state === 'active' ? <Badge tone="brand">Running, so far</Badge> : <Badge>Finished</Badge>}
              </h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-fg-subtle">
                <span className="flex items-center gap-1"><CalendarRange className="size-3.5" />{shortDay(s.startDate)} – {shortDay(s.endDate)}</span>
                {s.goal && <span className="flex items-center gap-1"><Target className="size-3.5" />{s.goal}</span>}
              </p>
              <p className="mt-2 text-small">
                Finished <b>{finished}</b> of <b>{scopeEnd}</b> {points ? 'points' : 'tickets'}
                {scopeEnd > 0 && <> ({Math.round((finished / scopeEnd) * 100)}%)</>}.
                {report.summary.added.count > 0 && <> Scope grew by {amount(report.summary.added)} after the start.</>}
                {report.summary.unfinished.count > 0 && (s.state === 'closed'
                  ? <> {amount(report.summary.unfinished)} slipped{report.carriedTo ? ` to ${report.carriedTo.name}` : ' back to the backlog'}.</>
                  : <> {amount(report.summary.unfinished)} still to do.</>)}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Tile label="Committed at start" count={countOf(report.summary.committed)} sub={sub(report.summary.committed)} />
              <Tile label="Added mid-sprint" count={countOf(report.summary.added)} sub={sub(report.summary.added)} tone={report.summary.added.count ? 'text-warning' : undefined} />
              <Tile label="Taken out" count={countOf(report.summary.removed)} sub={sub(report.summary.removed)} />
              <Tile
                label="Finished" count={countOf(report.summary.completed)} sub={sub(report.summary.completed)} tone="text-success"
                spark={doneByDay.some((n) => n > 0) && <Sparkline values={doneByDay} color="var(--c-chart-done)" label={`${points ? 'Points' : 'Tickets'} finished by the end of each day of the sprint so far, reaching ${doneByDay.at(-1)}`} />}
              />
              <Tile
                label={s.state === 'closed' ? 'Slipped' : 'Not finished yet'} count={countOf(report.summary.unfinished)} sub={sub(report.summary.unfinished)}
                tone={report.summary.unfinished.count && s.state === 'closed' ? 'text-danger' : undefined}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Burndown report={report} />
              <Waited report={report} />
            </div>

            <TicketList
              projectId={projectId}
              title={s.state === 'closed' ? 'Slipped' : 'Not finished yet'}
              hint={s.state === 'closed' ? (report.carriedTo ? `Moved to ${report.carriedTo.name} when the sprint was completed` : 'Moved back to the backlog when the sprint was completed') : null}
              tickets={report.unfinished}
              extra={(t) => t.blockedHours > 0 && <Badge tone="red"><Ban className="size-3" />blocked {hrs(t.blockedHours)}</Badge>}
            />
            <TicketList projectId={projectId} title="Added mid-sprint" hint="Not in the sprint when it started" tickets={report.added} />
            <TicketList projectId={projectId} title="Taken out mid-sprint" tickets={report.removed} />
            <TicketList projectId={projectId} title="Finished" tickets={report.completed} />
          </>
        )}
      </div>
    </div>
  );
}
