import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { CalendarDays, ChevronLeft, ChevronRight, Flag, Layers, Palmtree, Rocket } from 'lucide-react';
import { useMilestones, useProject, useProjectLeave, useProjectLive, useSprints, useTickets } from '../lib/queries.js';
import { TEAM_TZ, addDays, daysBetween, shortDay, startOfWeek, todayKey, weekdayOf } from '../lib/days.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import TicketDrawer from '../components/LazyTicketDrawer.jsx';
import { Button, EmptyState, Spinner, TypeIcon } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote, KeyChip } from '../ds/core.jsx';

const SPANS = [{ weeks: 6, label: '6 weeks' }, { weeks: 12, label: '3 months' }, { weeks: 26, label: '6 months' }];
const range = (a, b) => (a === b ? shortDay(a) : `${shortDay(a)} – ${shortDay(b)}`);
const dayIn = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TEAM_TZ }).format(new Date(iso));

// Where a ticket sits on the timeline. Start and due date give a bar; a due date alone gives a
// diamond on that day; a start alone runs to today (or to when it was finished), drawn open-ended.
function spanOf(t, done, today) {
  if (t.startDate && t.dueDate) return { from: t.startDate, to: t.dueDate, kind: 'bar' };
  if (t.dueDate) return { from: t.dueDate, to: t.dueDate, kind: 'point' };
  const end = done && t.resolvedAt ? dayIn(t.resolvedAt) : today;
  return { from: t.startDate, to: end < t.startDate ? t.startDate : end, kind: 'open' };
}

const TONES = {
  todo: { bar: 'bg-status-todo/45 text-fg-muted', point: 'border-status-todo bg-surface' },
  in_progress: { bar: 'bg-status-progress/80 text-status-progress', point: 'border-status-progress bg-status-progress' },
  done: { bar: 'bg-status-done/60 text-status-done', point: 'border-status-done bg-status-done' },
  epic: { bar: 'bg-epic text-epic', point: 'border-epic bg-epic' },
  derived: { bar: 'bg-epic/30 text-epic', point: 'border-epic bg-epic' },
};

function Bar({ windowStart, total, span, ticket, tone, overdue, thin, onOpen }) {
  const left = Math.max(0, daysBetween(windowStart, span.from));
  const right = Math.min(total, daysBetween(windowStart, span.to) + 1);
  if (right <= 0 || left >= total) return null;
  const what = span.kind === 'point' ? `due ${shortDay(span.from)}` : span.kind === 'open' ? `started ${shortDay(span.from)}, no due date` : range(span.from, span.to);
  const label = `${ticket.key} ${ticket.title}: ${what}${overdue ? ' (overdue)' : ''}`;
  if (span.kind === 'point') {
    return (
      <button type="button" onClick={onOpen} aria-label={label} title={label}
        className="absolute inset-y-0 grid place-items-center" style={{ left: `${(left / total) * 100}%`, width: `${(1 / total) * 100}%`, minWidth: 14 }}>
        <span className={clsx('size-3 rotate-45 rounded-shard border-2', overdue ? 'border-danger bg-danger' : tone.point)} />
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label={label} title={label}
      style={{ left: `${(left / total) * 100}%`, width: `${((right - left) / total) * 100}%` }}
      className={clsx('absolute top-1/2 -translate-y-1/2 rounded-hair transition hover:brightness-110', thin ? 'h-2' : 'h-4', tone.bar,
        span.kind === 'open' && 'rounded-r-none border-r-2 border-dashed border-current opacity-80',
        overdue && 'ring-2 ring-danger ring-offset-1 ring-offset-surface')} />
  );
}

// One line of the timeline: a sticky label on the left, the time axis on the right.
function Row({ label, children, className }) {
  return (
    <div className={clsx('flex min-h-9 items-stretch border-b border-line', className)}>
      <div className="sticky left-0 z-10 flex w-56 shrink-0 items-center gap-1.5 border-r border-line bg-surface px-3 text-small sm:w-64  ">{label}</div>
      <div className="relative min-w-0 flex-1">{children}</div>
    </div>
  );
}

// Gantt-style timeline: tickets with start and due dates as bars, grouped by epic, with sprints,
// milestones, today and team leave on the same time axis.
export default function TimelinePage() {
  const { projectId, ticketKey } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: project, error } = useProject(projectId);
  const onDeleted = useCallback(() => { toast('This project was deleted, so you are back on your projects.'); navigate('/projects'); }, [navigate]);
  useProjectLive(projectId, { onProjectDeleted: onDeleted });

  const today = todayKey();
  const [weeks, setWeeks] = useState(12);
  const [windowStart, setWindowStart] = useState(startOfWeek(addDays(today, -14)));
  const [hideDone, setHideDone] = useState(false);
  const total = weeks * 7;
  const windowEnd = addDays(windowStart, total - 1);

  const { data, isFetching } = useTickets(projectId, { scheduled: 'true', sort: 'number', limit: '500' });
  const { data: epicData } = useTickets(projectId, { type: 'epic', sort: 'number', limit: '200' });
  const { data: sprintData } = useSprints(projectId);
  const { data: milestones } = useMilestones(projectId);
  const { data: leave } = useProjectLeave(projectId, windowStart, windowEnd);

  const categoryOf = useMemo(() => new Map(project?.statuses.map((s) => [s.key, s.category])), [project]);
  const groups = useMemo(() => {
    if (!data || !project) return [];
    const epics = new Map((epicData?.tickets ?? []).map((e) => [e.id, e]));
    const byEpic = new Map();
    const groupOf = (key, epic) => {
      if (!byEpic.has(key)) byEpic.set(key, { epic, rows: [] });
      return byEpic.get(key);
    };
    for (const t of data.tickets) {
      const done = categoryOf.get(t.status) === 'done';
      if (hideDone && done) continue;
      const span = spanOf(t, done, today);
      if (span.to < windowStart || span.from > windowEnd) continue;
      if (t.type === 'epic') { groupOf(t.id, t); continue; }
      const key = t.epic ?? 'none';
      groupOf(key, key === 'none' ? null : epics.get(key) ?? null).rows.push({ t, span, done, overdue: Boolean(!done && t.dueDate && t.dueDate < today) });
    }
    const list = [...byEpic.values()].map((g) => {
      g.rows.sort((a, b) => a.span.from.localeCompare(b.span.from) || a.t.number - b.t.number);
      // The epic's own dates when it has them; otherwise the span of its tickets.
      const own = g.epic && (g.epic.startDate || g.epic.dueDate) ? spanOf(g.epic, categoryOf.get(g.epic.status) === 'done', today) : null;
      const derived = g.rows.length ? { from: g.rows.map((r) => r.span.from).sort()[0], to: g.rows.map((r) => r.span.to).sort().at(-1), kind: 'bar' } : null;
      return { ...g, span: own ?? derived, derived: !own };
    });
    return list.sort((a, b) => Number(!a.epic) - Number(!b.epic) || (a.span?.from ?? '').localeCompare(b.span?.from ?? ''));
  }, [data, epicData, project, categoryOf, hideDone, today, windowStart, windowEnd]);

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const openNumber = ticketKey ? Number(ticketKey.split('-').pop()) : null;
  const open = (t) => navigate(`/projects/${projectId}/timeline/${t.key}`);
  const pct = (day) => `${(daysBetween(windowStart, day) / total) * 100}%`;
  const mid = (day) => `calc(${pct(day)} + ${(0.5 / total) * 100}%)`;
  const inWindow = (day) => day >= windowStart && day <= windowEnd;
  const clip = (from, to) => [from < windowStart ? windowStart : from, to > windowEnd ? windowEnd : to];
  const widthOf = (from, to) => `${((daysBetween(from, to) + 1) / total) * 100}%`;
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(windowStart, i * 7));
  const sprints = (sprintData?.sprints ?? []).filter((s) => s.startDate && s.endDate && s.endDate >= windowStart && s.startDate <= windowEnd);
  const marks = (milestones ?? []).filter((m) => m.dueDate && inWindow(m.dueDate));
  const people = [...new Map((leave ?? []).map((l) => [l.user.id, l.user])).values()];
  const shift = Math.max(1, Math.floor(weeks / 2)) * 7;
  const rowCount = groups.reduce((n, g) => n + 1 + g.rows.length, 0);
  const sectionLabel = (Icon, text) => <span className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Icon className="size-3.5" />{text}</span>;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Timeline' }]}
        title={<ProjectSwitcher project={project} />}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
        <Button size="icon" variant="ghost" onClick={() => setWindowStart(addDays(windowStart, -shift))} aria-label="Earlier"><ChevronLeft className="size-4" /></Button>
        <span className="min-w-40 text-center text-small font-semibold">{shortDay(windowStart)} – {shortDay(windowEnd)}</span>
        <Button size="icon" variant="ghost" onClick={() => setWindowStart(addDays(windowStart, shift))} aria-label="Later"><ChevronRight className="size-4" /></Button>
        <Button size="sm" onClick={() => setWindowStart(startOfWeek(addDays(today, -14)))}>Today</Button>
        <select className="input h-8 w-auto text-caption" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Time span">
          {SPANS.map((s) => <option key={s.weeks} value={s.weeks}>{s.label}</option>)}
        </select>
        <Button size="sm" variant={hideDone ? 'primary' : 'secondary'} aria-pressed={hideDone} onClick={() => setHideDone((v) => !v)}>Hide done</Button>
        <span className="text-caption text-fg-subtle">Set a ticket's start and due dates to place it here.</span>
        {isFetching && <Spinner className="text-fg-subtle" />}
      </div>

      <div className="min-h-0 flex-1 px-4 pb-2 sm:px-6">
        <div className="card scroll-thin h-full overflow-auto">
          <div className="min-w-[820px]">
            <div className="sticky top-0 z-20 bg-surface">
              <Row label={sectionLabel(CalendarDays, 'Week of')}>
                {mondays.map((d, i) => (weeks <= 12 || i % 2 === 0) && (
                  <span key={d} className="absolute top-1/2 -translate-y-1/2 pl-1 text-micro text-fg-subtle" style={{ left: pct(d) }}>{shortDay(d)}</span>
                ))}
              </Row>
              <Row label={sectionLabel(Rocket, 'Sprints')}>
                {sprints.map((s) => {
                  const [from, to] = clip(s.startDate, s.endDate);
                  return (
                    <Link key={s.id} to={`/projects/${projectId}/sprints${s.state === 'planned' ? '' : `/${s.id}`}`} title={`${s.name}: ${range(s.startDate, s.endDate)}${s.goal ? ` · ${s.goal}` : ''}`}
                      className={clsx('absolute top-1/2 h-5 -translate-y-1/2 truncate rounded-hair px-1.5 text-micro font-medium leading-5',
                        s.state === 'active' ? 'bg-key-bg text-key' : 'bg-hover text-fg-muted  ')}
                      style={{ left: pct(from), width: widthOf(from, to) }}>
                      {s.name}
                    </Link>
                  );
                })}
              </Row>
              {marks.length > 0 && (
                <Row label={sectionLabel(Flag, 'Milestones')}>
                  {marks.map((m) => (
                    <span key={m.id} className="absolute top-1/2 -translate-y-1/2 truncate pl-1 text-micro font-medium text-epic" style={{ left: pct(m.dueDate) }} title={`${m.name}, due ${shortDay(m.dueDate)}`}>
                      <Flag className="mr-0.5 inline size-3" />{m.name}
                    </span>
                  ))}
                </Row>
              )}
            </div>

            <div className="relative">
              {/* Weekends, week lines, milestones and today, drawn once behind every row. */}
              <div className="pointer-events-none absolute inset-y-0 right-0 left-56 sm:left-64" aria-hidden="true">
                {weeks <= 12 && Array.from({ length: total }, (_, i) => addDays(windowStart, i)).filter((d) => weekdayOf(d) >= 5).map((d) => (
                  <div key={d} className="absolute inset-y-0 bg-sunken/70" style={{ left: pct(d), width: `${(1 / total) * 100}%` }} />
                ))}
                {mondays.map((d) => <div key={d} className="absolute inset-y-0 border-l border-line" style={{ left: pct(d) }} />)}
                {marks.map((m) => <div key={m.id} className="absolute inset-y-0 border-l-2 border-dashed border-epic/60" style={{ left: mid(m.dueDate) }} />)}
                {inWindow(today) && <div className="absolute inset-y-0 w-0.5 bg-danger" style={{ left: mid(today) }} />}
              </div>
              {rowCount === 0 && <EmptyNote className="relative z-10 m-4 w-fit max-w-[calc(100%-2rem)] rounded-card bg-surface px-4 py-3 shadow-raised">No dated tickets in this period. Give tickets a start or due date, or move the window.</EmptyNote>}
              {groups.map((g) => (
                <div key={g.epic?.id ?? 'none'}>
                  <Row
                    className="bg-sunken/60 "
                    label={g.epic ? (
                      <button type="button" onClick={() => open(g.epic)} className="flex min-w-0 items-center gap-1.5 font-semibold hover:underline">
                        <Layers className="size-3.5 shrink-0 text-epic" /><span className="truncate">{g.epic.title}</span>
                      </button>
                    ) : <span className="font-semibold text-fg-subtle">No epic</span>}
                  >
                    {g.span && g.epic && (
                      <Bar windowStart={windowStart} total={total} span={g.span} ticket={g.epic} thin={g.derived}
                        tone={g.derived ? TONES.derived : TONES.epic} onOpen={() => open(g.epic)} />
                    )}
                  </Row>
                  {g.rows.map(({ t, span, done, overdue }) => (
                    <Row key={t.id} label={(
                      <button type="button" onClick={() => open(t)} className="flex min-w-0 items-center gap-1.5 pl-3 text-left hover:underline">
                        <TypeIcon type={t.type} className="size-3.5 shrink-0" />
                        <KeyChip>{t.key}</KeyChip>
                        <span className={clsx('truncate', done && 'text-fg-subtle line-through')}>{t.title}</span>
                      </button>
                    )}>
                      <Bar windowStart={windowStart} total={total} span={span} ticket={t} overdue={overdue}
                        tone={TONES[categoryOf.get(t.status)] ?? TONES.todo} onOpen={() => open(t)} />
                    </Row>
                  ))}
                </div>
              ))}
              {people.length > 0 && (
                <>
                  <Row className="bg-sunken/60 " label={sectionLabel(Palmtree, 'Team leave')} />
                  {people.map((p) => (
                    <Row key={p.id} label={<span className="truncate pl-3">{p.name}</span>}>
                      {leave.filter((l) => l.user.id === p.id).map((l) => {
                        const [from, to] = clip(l.from, l.to);
                        return (
                          <span key={l.id} title={`${p.name} on leave ${range(l.from, l.to)}${l.note ? ` · ${l.note}` : ''}`}
                            className="absolute top-1/2 h-4 -translate-y-1/2 truncate rounded-hair bg-success/15 px-1 text-micro leading-4 text-success"
                            style={{ left: pct(from), width: widthOf(from, to) }}>
                            {l.note || 'Leave'}
                          </span>
                        );
                      })}
                    </Row>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="px-4 pb-3 text-caption text-fg-subtle sm:px-6">
        Bars run from start to due date. A diamond is a due date with no start; a dashed end means started with no due date yet. Red marks overdue work; the red line is today.
      </p>

      {openNumber && <TicketDrawer project={project} number={openNumber} userId={user.id} onClose={() => navigate(`/projects/${projectId}/timeline`)} />}
    </div>
  );
}
