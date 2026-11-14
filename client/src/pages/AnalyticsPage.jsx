import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import { AlertOctagon, AlertTriangle, Bug, Clock, Gauge, Hourglass, Repeat, TrendingUp } from 'lucide-react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/queries.js';
import { formatDate, timeAgo } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { SlaReport } from '../components/AutomationSettings.jsx';
import { Avatar, Badge, KeyChip, Segmented, Skeleton } from '../ds/index.jsx';
import {
  ChartCard, CountUp, DataTable, Legend, RingDot, SERIES, Sparkline, Tip, activeDot, axis, barCursor, baseAxis, chartDefs, crosshair, duration,
  durationCount, fillRef, grid, gridV, minusDays, p85, shortDay, statusPaint, todayKey, useChartId, useChartMotion, useDark,
} from '../components/charts.jsx';
import { ImpactBadge } from '../components/ErrorInsights.jsx';
import { CodeHealth } from '../components/GithubTools.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote } from '../ds/core.jsx';

// Hours as words: minutes under an hour, hours under a day, days above. The server rounds to
// 0.1 h (6 min), so 0 means "under 3 minutes", never "1 min".
const hrs = (h) => {
  if (!h) return '< 3 min';
  if (h < 1) return `${Math.round(h * 60)} min`;
  return h < 24 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} d`;
};
// The same on an axis, where the origin is simply 0.
const tickHrs = (v) => (v === 0 ? '0' : hrs(v));
// Ticks on whole, round steps of the unit the longest bar is read in (days, hours or minutes),
// so the axis says 0, 5 d, 10 d rather than 6.3 d, 12.5 d.
function hourTicks(maxHours) {
  const unit = maxHours >= 24 ? 24 : maxHours >= 1 ? 1 : 1 / 60;
  const top = maxHours / unit;
  const step = [1, 2, 5, 10, 20, 50, 100].find((s) => top / s <= 5) ?? Math.ceil(top / 5);
  return Array.from({ length: Math.ceil(top / step) + 1 }, (_, i) => i * step * unit);
}

// Blocked time (E3): hours spent blocked in the range, by reason, plus the tickets that waited
// longest. Blocked means something is wrong, so it wears the danger status colour (not a series colour).
function BlockedTime({ blocked, projectId }) {
  if (!blocked) return null;
  const max = Math.max(1, ...blocked.byReason.map((r) => r.hours));
  return (
    <ChartCard
      title="Blocked time"
      subtitle={blocked.tickets
        ? `${hrs(blocked.totalHours)} across ${blocked.tickets} ticket${blocked.tickets === 1 ? '' : 's'} in this range · ${blocked.blockedNow} blocked right now`
        : 'Nothing was blocked in this range.'}
      table={blocked.byReason.length ? <DataTable head={['Reason', 'Hours']} rows={blocked.byReason.map((r) => [r.reason, r.hours])} /> : null}
    >
      {blocked.byReason.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <ul className="space-y-3" aria-label="Blocked time by reason">
            {blocked.byReason.map((r) => (
              <li key={r.reason} className="text-small">
                <div className="flex justify-between gap-3"><span className="truncate text-fg">{r.reason}</span><span className="tabular-nums text-fg-muted">{hrs(r.hours)}</span></div>
                <div className="mt-1.5 h-2 rounded-full bg-press">
                  <div className="h-full rounded-full bg-danger" style={{ width: `${Math.max(2, (r.hours / max) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <div>
            <p className="mb-1.5 text-caption font-medium text-fg-subtle">Waited longest</p>
            <ul>
              {blocked.topTickets.map((t) => (
                <li key={t.key ?? t.title} className="border-b border-line last:border-0">
                  {t.key ? (
                    <Link to={`/projects/${projectId}/tickets/${t.key}`} className="ds-focus flex items-center gap-3 rounded-tile py-2 text-small transition-colors duration-(--dur-fast) hover:bg-hover">
                      <KeyChip>{t.key}</KeyChip>
                      <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
                      <span className="tabular-nums text-fg-muted">{hrs(t.hours)}</span>
                    </Link>
                  ) : <span className="block py-2 text-small text-fg-subtle">{t.title} · {hrs(t.hours)}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </ChartCard>
  );
}

// A number that says one thing: label, value (counted up, tabular figures), a line of context and,
// where there is a real series behind it, a sparkline of its recent shape.
function Tile({ icon: Icon, label, value, count, hint, tone, spark }) {
  return (
    <div className="flex min-w-0 flex-col rounded-card bg-surface p-4 shadow-surface">
      <div className="flex items-center gap-2 text-caption text-fg-subtle"><Icon className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{label}</span></div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className={clsx('shrink-0 whitespace-nowrap text-h1 font-semibold tracking-tight tabular-nums', tone ?? 'text-fg')}>
          {count ? <CountUp value={count.value} format={count.format} /> : value}
        </div>
        {spark && <div className="mb-1 hidden min-w-10 max-w-24 flex-1 min-[420px]:block [&>svg]:w-full">{spark}</div>}
      </div>
      {hint && <div className="mt-0.5 text-caption text-fg-subtle">{hint}</div>}
    </div>
  );
}
const whole = (n) => String(Math.round(n));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const LEVEL = {
  overloaded: { label: 'Overloaded', tone: 'danger', icon: AlertOctagon },
  heavy: { label: 'Heavy', tone: 'warning', icon: AlertTriangle },
  balanced: { label: 'Balanced', tone: 'neutral' },
  light: { label: 'Light', tone: 'neutral' },
};
const BUCKETS = [['overdue', 'Overdue'], ['thisWeek', 'This week'], ['nextWeek', 'Next week'], ['later', 'Later'], ['noDate', 'No date']];

// Open work per person by due bucket: a heat grid on one hue (more work, stronger violet).
function Workload({ data, mode }) {
  if (!data?.members.length) return <EmptyNote>No one who can be assigned work yet.</EmptyNote>;
  const max = Math.max(1, ...data.members.flatMap((m) => BUCKETS.map(([k]) => m.byDue[k])));
  const hue = SERIES[mode][0];
  return (
    <div className="ds-scroll overflow-x-auto">
      <table className="w-full min-w-[34rem] text-caption">
        <caption className="sr-only">Open tickets per person by when they are due</caption>
        <thead className="text-left text-fg-subtle">
          <tr>
            <th scope="col" className="pb-2 font-medium">Person</th>
            {BUCKETS.map(([, l]) => <th key={l} scope="col" className="pb-2 text-center font-medium">{l}</th>)}
            <th scope="col" className="pb-2 text-right font-medium">Load</th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((m) => {
            const level = LEVEL[m.level] ?? LEVEL.balanced;
            return (
              <tr key={m.user.id} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                  <span className="flex items-center gap-2"><Avatar name={m.user.name} id={m.user.id} size="sm" /><span className="truncate text-small text-fg">{m.user.name}</span><span className="text-fg-subtle">{m.open} open</span></span>
                </th>
                {BUCKETS.map(([k, l]) => {
                  const n = m.byDue[k];
                  const pct = n ? Math.round(18 + 72 * (n / max)) : 0;
                  return (
                    <td key={k} className="p-0.5">
                      <div
                        title={`${m.user.name}: ${n} ${l.toLowerCase()}`}
                        className={clsx('grid h-8 place-items-center rounded-tile font-medium tabular-nums', !n && 'bg-hover text-fg-faint', n && pct < 55 && 'text-fg', pct >= 55 && 'text-white')}
                        style={n ? { background: `color-mix(in oklab, ${hue} ${pct}%, var(--c-surface))` } : undefined}
                      >
                        {n}
                      </div>
                    </td>
                  );
                })}
                <td className="py-1.5 pl-2 text-right">
                  <span title={`Score ${m.score} (team average ${data.team.averageScore})`}><Badge tone={level.tone} icon={level.icon}>{level.label}</Badge></span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-caption text-fg-subtle">Load compares each person's open work (story points, or priority when there are none) with the team's average of {data.team.averageScore}.</p>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-4 p-4 sm:p-6" aria-busy="true" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      <div className="grid gap-4 xl:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-80" />)}</div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const mode = useDark() ? 'dark' : 'light';
  const [days, setDays] = useState(30);
  const to = todayKey();
  const from = minusDays(to, days - 1);
  const { data: project, error } = useProject(projectId);
  const { data: a, isLoading } = useQuery({
    queryKey: ['analytics', projectId, from, to],
    queryFn: () => api(`/projects/${projectId}/analytics?from=${from}&to=${to}`),
    enabled: Boolean(project),
  });
  const { data: workload } = useQuery({ queryKey: ['workload', projectId], queryFn: () => api(`/projects/${projectId}/workload`), enabled: Boolean(project) });
  const { data: errors } = useQuery({ queryKey: ['errors', projectId], queryFn: () => api(`/projects/${projectId}/errors`).then((d) => d.errors), enabled: Boolean(project) });
  const uid = useChartId();
  const enter = useChartMotion();

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <AnalyticsSkeleton />;

  const statuses = a ? a.cfd.statuses : [];
  const nameOf = (k) => project.statuses.find((s) => s.key === k)?.name ?? k;
  // Each column wears its status category's colour, as on cards and badges (to do grey, in
  // progress amber, done violet); a second column of the same category is hatched.
  const paint = statusPaint(project.statuses, [...new Set([...statuses, ...(a?.timeInStatus.map((s) => s.key) ?? [])])], mode);
  const colorOf = (k) => paint[k]?.color;
  const fillOf = (k, area) => (paint[k]?.texture || area ? fillRef(uid, k) : paint[k]?.color);
  const cfdRows = a?.cfd.days.map((d) => ({ day: d.day, ...d.counts })) ?? [];
  const done = a?.throughput.reduce((s, d) => s + d.count, 0) ?? 0;
  // The cycle-time chart's unit follows the work: days, hours, or minutes for quick work.
  const ct = a?.cycleTime;
  const unit = !ct?.count ? 'd' : ct.p85Days >= 1 ? 'd' : ct.p85Hours >= 1 ? 'h' : 'min';
  const inUnit = (p) => (unit === 'd' ? p.days : unit === 'h' ? p.hours : Math.round(p.hours * 60));
  const unitWord = { d: 'days', h: 'hours', min: 'minutes' }[unit];
  const p85Line = !ct?.count ? null : unit === 'd' ? ct.p85Days : unit === 'h' ? ct.p85Hours : Math.round(ct.p85Hours * 60);
  const points = ct?.points.map((p) => ({ x: new Date(p.resolvedAt).getTime(), y: inUnit(p), key: p.key })) ?? [];
  const overWip = a?.wip.filter((w) => w.over).length ?? 0;
  const doneColor = 'var(--c-chart-done)';
  // Sparklines: only series the page really has. Each finished ticket's cycle time (oldest first),
  // and finished tickets per day. Lead time, WIP and stale counts have no history here, so no line.
  const cycleSpark = ct?.points.map((p) => p.hours) ?? [];
  const finishedSpark = a?.throughput.map((d) => d.count) ?? [];
  const bestDay = Math.max(0, ...finishedSpark);

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Analytics' }]}
        title={<ProjectSwitcher project={project} />}
        actions={(
          <Segmented size="sm" label="Time range" value={String(days)} onChange={(v) => setDays(Number(v))}
            options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        )}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>

      {isLoading || !a ? <AnalyticsSkeleton /> : (
        <div className="space-y-4 p-4 sm:p-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile
              icon={Clock} label="Cycle time (median)" value={duration(a.cycleTime)} count={durationCount(a.cycleTime)}
              hint={a.cycleTime.count ? `85% within ${p85(a.cycleTime)}` : 'Nothing finished yet'}
              spark={<Sparkline values={cycleSpark} color={doneColor} label={`Cycle time of each of the ${plural(cycleSpark.length, 'ticket')} finished in this range, oldest first: shortest ${hrs(Math.min(...cycleSpark))}, longest ${hrs(Math.max(...cycleSpark))}`} />}
            />
            <Tile icon={Hourglass} label="Lead time (median)" value={duration(a.leadTime)} count={durationCount(a.leadTime)} hint="Created to done" />
            <Tile
              icon={TrendingUp} label="Finished" value={done} count={{ value: done, format: whole }} hint={`in the last ${days} days`}
              spark={done > 0 && <Sparkline values={finishedSpark} color={doneColor} label={`Tickets finished per day over the last ${days} days; the busiest day had ${bestDay}`} />}
            />
            <Tile icon={Gauge} label="Columns over WIP" value={overWip} count={{ value: overWip, format: whole }} tone={overWip ? 'text-danger' : undefined} hint={a.wip.some((w) => w.limit) ? 'of the columns with a limit' : 'No WIP limits set'} />
            <Tile icon={AlertTriangle} label="Stale tickets" value={a.stale.length} count={{ value: a.stale.length, format: whole }} tone={a.stale.length ? 'text-warning' : undefined} hint="Untouched for 7+ days" />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard
              title="Cumulative flow"
              subtitle="Tickets in each column at the end of each day. Widening bands mean work is piling up."
              table={<DataTable head={['Day', ...statuses.map(nameOf)]} rows={cfdRows.map((r) => [shortDay(r.day), ...statuses.map((k) => r[k])])} />}
            >
              <div className="h-64">
                <ResponsiveContainer>
                  <AreaChart data={cfdRows} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    {chartDefs(uid, statuses.map((k) => ({ id: k, color: colorOf(k), texture: paint[k]?.texture })))}
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} {...baseAxis} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip cursor={crosshair} content={<Tip labelFormat={shortDay} colorOf={colorOf} total="On the board" />} />
                    {[...statuses].reverse().map((k) => (
                      <Area key={k} type="monotone" dataKey={k} name={nameOf(k)} stackId="cfd" stroke={colorOf(k)} strokeWidth={2} fill={fillOf(k, true)} activeDot={activeDot} {...enter} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <Legend items={statuses.map((k) => ({ key: k, name: nameOf(k), color: colorOf(k), texture: paint[k]?.texture }))} />
            </ChartCard>

            <ChartCard
              title="Throughput"
              subtitle="Tickets finished per day."
              table={<DataTable head={['Day', 'Finished']} rows={a.throughput.map((d) => [shortDay(d.day), d.count])} />}
            >
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={a.throughput} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="day" tickFormatter={shortDay} minTickGap={28} {...baseAxis} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip cursor={barCursor} content={<Tip labelFormat={shortDay} />} />
                    <Bar dataKey="count" name="Finished" fill={doneColor} radius={[4, 4, 0, 0]} maxBarSize={24} {...enter} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard
              title="Cycle time"
              subtitle={ct.count ? `Each dot is a finished ticket, in ${unitWord}. The line marks the 85th percentile (${p85(ct)}).` : 'Each finished ticket will appear here as a dot.'}
              table={<DataTable head={['Ticket', 'Finished', unitWord[0].toUpperCase() + unitWord.slice(1)]} rows={points.map((p) => [p.key, formatDate(p.x), p.y])} />}
            >
              {points.length ? (
                <div className="h-64">
                  <ResponsiveContainer>
                    <ScatterChart margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
                      <CartesianGrid {...grid} />
                      <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} tickFormatter={(v) => formatDate(v).replace(/ \d{4}$/, '')} {...baseAxis} />
                      <YAxis type="number" dataKey="y" unit={unit === 'min' ? 'm' : unit} allowDecimals={unit !== 'min'} {...axis} />
                      <Tooltip cursor={crosshair} content={({ active, payload }) => (active && payload?.length ? (
                        <div className="ds-chart-tip px-3 py-2 text-caption">
                          <div className="font-medium text-fg">{payload[0].payload.key}</div>
                          <div className="tabular-nums text-fg-muted">{payload[0].payload.y} {unitWord} · finished {formatDate(payload[0].payload.x)}</div>
                        </div>
                      ) : null)} />
                      {p85Line !== null && (
                        <ReferenceLine y={p85Line} stroke="var(--c-fg-subtle)" strokeDasharray="4 4"
                          label={{ value: '85%', position: 'insideTopRight', fill: 'var(--c-fg-subtle)', fontSize: 11 }} />
                      )}
                      <Scatter data={points} name="Ticket" fill={doneColor} shape={<RingDot />} {...enter} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              ) : <EmptyNote className="h-64 items-center justify-center">Nothing finished in this period.</EmptyNote>}
            </ChartCard>

            <ChartCard
              title="Time in each column"
              subtitle="Average time a ticket spends in a column in this period."
              table={<DataTable head={['Column', 'Average hours', 'Tickets']} rows={a.timeInStatus.map((s) => [s.name, s.averageHours, s.tickets])} />}
            >
              {a.timeInStatus.every((s) => !s.averageHours) ? (
                <p className="grid h-64 place-items-center px-6 text-center text-small text-fg-subtle">
                  {a.timeInStatus.some((s) => s.tickets)
                    ? 'Tickets moved through every column in under 3 minutes in this period, too quick to chart.'
                    : 'No ticket has moved through a column in this period yet.'}
                </p>
              ) : (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart layout="vertical" data={a.timeInStatus} margin={{ top: 6, right: 56, left: 8, bottom: 0 }}>
                    {chartDefs(uid, a.timeInStatus.filter((s) => paint[s.key]?.texture).map((s) => ({ id: s.key, color: colorOf(s.key), texture: paint[s.key].texture })))}
                    <CartesianGrid {...gridV} />
                    <XAxis type="number" tickFormatter={tickHrs} ticks={hourTicks(Math.max(...a.timeInStatus.map((x) => x.averageHours)))} domain={[0, (top) => hourTicks(top).at(-1)]} {...axis} />
                    <YAxis type="category" dataKey="name" width={96} {...baseAxis} />
                    <Tooltip cursor={barCursor} content={<Tip colorOf={(_, p) => colorOf(p.payload.key)} format={(v, p) => `${hrs(v)} · ${plural(p.payload.tickets, 'ticket')}`} />} />
                    <Bar dataKey="averageHours" name="Average" radius={[0, 4, 4, 0]} maxBarSize={24} {...enter}>
                      {a.timeInStatus.map((s) => <Cell key={s.key} fill={fillOf(s.key)} stroke={paint[s.key]?.texture ? colorOf(s.key) : undefined} />)}
                      <LabelList dataKey="averageHours" position="right" formatter={(v) => (v ? hrs(v) : '')} fill="var(--c-fg-muted)" fontSize={11} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              )}
            </ChartCard>
          </div>

          <SlaReport project={project} days={days} />
          <CodeHealth project={project} />

          <ChartCard title="Workload" subtitle="Open work per person, by when it is due. A stronger colour means more tickets.">
            <Workload data={workload} mode={mode} />
          </ChartCard>

          <BlockedTime blocked={a.blocked} projectId={projectId} />

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Stale tickets" subtitle="Open, and nobody has moved, edited or commented in 7+ days.">
              {a.stale.length === 0 ? <EmptyNote>Nothing stale. Everything open has moved recently.</EmptyNote> : (
                <ul>
                  {a.stale.slice(0, 10).map((t) => (
                    <li key={t.key} className="border-b border-line last:border-0">
                      <Link to={`/projects/${projectId}/tickets/${t.key}`} className="ds-focus flex items-center gap-3 rounded-tile py-2 text-small transition-colors duration-(--dur-fast) hover:bg-hover">
                        <KeyChip>{t.key}</KeyChip>
                        <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
                        {t.assignee && <Avatar name={t.assignee.name} id={t.assignee.id} size="sm" />}
                        <Badge tone="warning">{Math.floor(t.idleDays)} days idle</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </ChartCard>
            <ChartCard title="Error groups" subtitle="One row per distinct crash, highest impact first. Impact counts reports this week, people affected, comebacks and priority.">
              {!errors?.length ? <EmptyNote>No errors reported yet. Paste a stack trace when creating a ticket to start.</EmptyNote> : (
                <ul>
                  {[...errors].sort((x, y) => Number(x.resolved || x.muted) - Number(y.resolved || y.muted) || y.impact.score - x.impact.score).slice(0, 10).map((e) => (
                    <li key={e.key} className="border-b border-line last:border-0">
                      <Link to={`/projects/${projectId}/tickets/${e.key}`} className="ds-focus flex items-center gap-3 rounded-tile py-2 text-small transition-colors duration-(--dur-fast) hover:bg-hover">
                        <Bug className={clsx('size-4 shrink-0', e.resolved ? 'text-fg-faint' : 'text-danger')} aria-label={e.resolved ? 'Resolved' : 'Open'} />
                        <KeyChip>{e.key}</KeyChip>
                        <span className="min-w-0 flex-1 truncate text-fg"><span className="font-code text-caption text-fg-muted">{e.errorType ?? 'Error'}</span> {e.message}</span>
                        {e.muted ? <Badge>Muted</Badge> : !e.resolved && <ImpactBadge impact={e.impact} />}
                        {e.topBrowser && <span className="hidden text-caption text-fg-subtle md:block" title="Most common browser among the reports that included one">{e.topBrowser.name} {Math.round(e.topBrowser.share * 100)}%</span>}
                        <Badge tone={e.resolved ? 'neutral' : 'danger'} icon={Repeat}>{e.occurrences}×</Badge>
                        <span className="hidden text-caption text-fg-subtle sm:block">{timeAgo(e.lastSeenAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}
