import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Flag, Inbox, Palmtree, Rocket } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk, useMilestones, useProject, useProjectLeave, useProjectLive, useSprints, useTickets } from '../lib/queries.js';
import { roleAtLeast } from '../lib/format.js';
import { WEEKDAYS, addDays, addMonths, daysBetween, monthLabel, shortDay, startOfMonth, startOfWeek, todayKey } from '../lib/days.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import TicketDrawer from '../components/LazyTicketDrawer.jsx';
import MyLeave from '../components/MyLeave.jsx';
import { Button, EmptyState, Modal, Spinner, TypeIcon } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';

const DRAG_TYPE = 'application/x-tessera-ticket';
const firstName = (name) => name.split(/\s+/)[0];

// One ticket on the calendar. Draggable to another day (or to "No due date") by people who can work.
function Chip({ ticket, done, overdue, draggable, onOpen }) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, ticket.key); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={onOpen}
      title={`${ticket.key} ${ticket.title}${ticket.assignee ? ` · ${ticket.assignee.name}` : ''}`}
      className={clsx(
        'flex w-full min-w-0 items-center gap-1 rounded-tile border px-1.5 py-0.5 text-left text-micro leading-5 transition',
        draggable && 'cursor-grab active:cursor-grabbing',
        overdue ? 'border-danger/40 bg-danger/10 text-danger   '
          : 'border-line bg-surface hover:border-fg-faint  ',
        done && 'opacity-60',
      )}
    >
      <TypeIcon type={ticket.type} className="size-3 shrink-0" />
      <span className="shrink-0 font-code text-fg-subtle">{ticket.key.split('-')[1]}</span>
      <span className={clsx('truncate', done && 'line-through')}>{ticket.title}</span>
    </button>
  );
}

// Props that make an element accept a dragged ticket, and whether one is over it now.
function useDropTarget(onDrop, enabled) {
  const [over, setOver] = useState(false);
  if (!enabled) return [{}, false];
  return [{
    onDragOver: (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { e.preventDefault(); setOver(false); const key = e.dataTransfer.getData(DRAG_TYPE); if (key) onDrop(key); },
  }, over];
}

function DayCell({ day, inMonth, today, tickets, leave, sprintMarks, milestones, doneKeys, canWork, onMove, onOpen }) {
  const [drop, over] = useDropTarget((key) => onMove(key, day), canWork);
  const away = leave.filter((l) => l.from <= day && day <= l.to);
  return (
    <div
      {...drop}
      className={clsx(
        'flex min-h-28 min-w-0 flex-col gap-1 border-b border-r border-line p-1.5 ',
        !inMonth && 'bg-sunken/60 ',
        over && 'bg-accent-soft',
      )}
      aria-label={shortDay(day)}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className={clsx('grid size-6 shrink-0 place-items-center rounded-full text-caption tabular-nums',
          day === today ? 'ds-gradient font-semibold text-on-gradient' : inMonth ? 'text-fg-muted' : 'text-fg-subtle')}>
          {Number(day.slice(8))}
        </span>
        {sprintMarks.map((m) => (
          <span key={m.text} className="truncate rounded-hair bg-key-bg px-1 text-micro font-medium text-accent  " title={m.title}>
            <Rocket className="mr-0.5 inline size-2.5" />{m.text}
          </span>
        ))}
      </div>
      {milestones.map((m) => (
        <span key={m.id} className="truncate rounded-hair bg-epic/12 px-1 text-micro font-medium text-epic" title={`Milestone due: ${m.name}`}>
          <Flag className="mr-0.5 inline size-2.5" />{m.name}
        </span>
      ))}
      {away.length > 0 && (
        <span className="truncate text-micro text-success" title={away.map((l) => `${l.user.name} on leave${l.note ? ` (${l.note})` : ''}`).join('\n')}>
          <Palmtree className="mr-0.5 inline size-2.5" />{away.map((l) => firstName(l.user.name)).join(', ')} away
        </span>
      )}
      <div className="scroll-thin flex max-h-36 flex-col gap-1 overflow-y-auto">
        {tickets.map((t) => {
          const done = doneKeys.has(t.status);
          return <Chip key={t.id} ticket={t} done={done} overdue={!done && day < today} draggable={canWork} onOpen={() => onOpen(t)} />;
        })}
      </div>
    </div>
  );
}

// Month calendar: tickets on their due dates, sprint starts and ends, milestone due dates and who
// is on leave. Drag a ticket to another day to change its due date, or to "No due date".
export default function CalendarPage() {
  const { projectId, ticketKey } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: project, error } = useProject(projectId);
  const onDeleted = useCallback(() => { toast('This project was deleted, so you are back on your projects.'); navigate('/projects'); }, [navigate]);
  useProjectLive(projectId, { onProjectDeleted: onDeleted });

  const today = todayKey();
  const [month, setMonth] = useState(startOfMonth(today));
  const [openOnly, setOpenOnly] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const gridStart = startOfWeek(month);
  const gridEnd = addDays(startOfWeek(addDays(addMonths(month, 1), -1)), 6);
  const days = useMemo(() => Array.from({ length: daysBetween(gridStart, gridEnd) + 1 }, (_, i) => addDays(gridStart, i)), [gridStart, gridEnd]);

  const params = { dueFrom: gridStart, dueTo: gridEnd, sort: 'due', limit: '500', ...(openOnly && { open: 'true' }) };
  const { data, isFetching } = useTickets(projectId, params);
  const { data: unscheduled } = useTickets(projectId, { due: 'none', open: 'true', sort: 'priority', limit: '100' });
  const { data: leave } = useProjectLeave(projectId, gridStart, gridEnd);
  const { data: sprintData } = useSprints(projectId);
  const { data: milestones } = useMilestones(projectId);

  const doneKeys = useMemo(() => new Set(project?.statuses.filter((s) => s.category === 'done').map((s) => s.key)), [project]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const t of data?.tickets ?? []) {
      if (!map.has(t.dueDate)) map.set(t.dueDate, []);
      map.get(t.dueDate).push(t);
    }
    return map;
  }, [data]);
  const sprintMarks = (day) => (sprintData?.sprints ?? []).flatMap((s) => {
    const marks = [];
    if (s.startDate === day) marks.push({ text: `${s.name} starts`, title: s.goal || s.name });
    if (s.endDate === day) marks.push({ text: `${s.name} ends`, title: s.goal || s.name });
    return marks;
  });

  const canWork = Boolean(project && roleAtLeast(project.myRole, 'developer') && !project.archivedAt);
  const all = [...(data?.tickets ?? []), ...(unscheduled?.tickets ?? [])];
  const move = async (key, day) => {
    const t = all.find((x) => x.key === key);
    if (t && t.dueDate === day) return;
    try {
      await api(`/projects/${projectId}/tickets/${key}`, { method: 'PATCH', body: { dueDate: day } });
      toast.success(day ? `${key} now due ${shortDay(day)}` : `${key} has no due date now`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      qc.invalidateQueries({ queryKey: qk.tickets(projectId) });
    }
  };
  const [dropNone, overNone] = useDropTarget((key) => move(key, null), canWork);
  const open = (t) => navigate(`/projects/${projectId}/calendar/${t.key}`);

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const openNumber = ticketKey ? Number(ticketKey.split('-').pop()) : null;
  const monthEnd = addDays(addMonths(month, 1), -1);
  const awayThisMonth = (leave ?? []).filter((l) => l.to >= month && l.from <= monthEnd);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Calendar' }]}
        title={<ProjectSwitcher project={project} />}
        actions={<Button onClick={() => setLeaveOpen(true)}><Palmtree className="size-4" />My leave</Button>}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
        <Button size="icon" variant="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft className="size-4" /></Button>
        <h2 className="min-w-36 text-center text-small font-semibold">{monthLabel(month)}</h2>
        <Button size="icon" variant="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRight className="size-4" /></Button>
        <Button size="sm" onClick={() => setMonth(startOfMonth(today))} disabled={month === startOfMonth(today)}>Today</Button>
        <Button size="sm" variant={openOnly ? 'primary' : 'secondary'} aria-pressed={openOnly} onClick={() => setOpenOnly((v) => !v)}>Open only</Button>
        <span className="text-caption text-fg-subtle">{data ? `${data.total} due in view` : ''}{canWork ? ' · drag a ticket to another day to change its due date' : ''}</span>
        {isFetching && <Spinner className="text-fg-subtle" />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 sm:px-6 lg:flex-row">
        {/* Scrolls sideways on narrow screens, so it can take focus and be scrolled from the keyboard. */}
        <div className="scroll-thin ds-focus min-w-0 flex-1 overflow-x-auto rounded-card" tabIndex={0} role="region" aria-label="Month">
          <div className="card min-w-[720px] overflow-hidden">
            <div className="grid grid-cols-7 border-b border-line text-micro font-semibold uppercase tracking-wide text-fg-subtle ">
              {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 border-l border-line">
              {days.map((day) => (
                <DayCell
                  key={day} day={day} today={today} inMonth={day.slice(0, 7) === month.slice(0, 7)}
                  tickets={byDay.get(day) ?? []} leave={leave ?? []} sprintMarks={sprintMarks(day)}
                  milestones={(milestones ?? []).filter((m) => m.dueDate === day && !m.closedAt)}
                  doneKeys={doneKeys} canWork={canWork} onMove={move} onOpen={open}
                />
              ))}
            </div>
          </div>
        </div>

        <aside className="w-full shrink-0 space-y-4 lg:w-64">
          <section {...dropNone} className={clsx('card p-3', overNone && 'ring-2 ring-key-line')} aria-label="No due date">
            <h3 className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Inbox className="size-3.5" />No due date</h3>
            <p className="mb-2 text-caption text-fg-subtle">{canWork ? 'Open tickets without a date. Drag one onto a day, or drop a ticket here to clear its date.' : 'Open tickets without a date.'}</p>
            <div className="scroll-thin flex max-h-72 flex-col gap-1 overflow-y-auto">
              {(unscheduled?.tickets ?? []).map((t) => <Chip key={t.id} ticket={t} draggable={canWork} onOpen={() => open(t)} />)}
              {unscheduled?.tickets?.length === 0 && <p className="text-caption text-fg-subtle">Every open ticket has a date.</p>}
            </div>
          </section>
          <section className="card p-3" aria-label="Team leave this month">
            <h3 className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Palmtree className="size-3.5" />Leave in {monthLabel(month).split(' ')[0]}</h3>
            {awayThisMonth.length === 0 ? <p className="text-caption text-fg-subtle">Nobody is away.</p> : (
              <ul className="space-y-1.5 text-caption">
                {awayThisMonth.map((l) => (
                  <li key={l.id}>
                    <span className="font-medium">{l.user.name}</span>
                    <span className="text-fg-subtle"> · {l.from === l.to ? shortDay(l.from) : `${shortDay(l.from)} – ${shortDay(l.to)}`}</span>
                    {l.note && <span className="block truncate text-fg-subtle">{l.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {openNumber && <TicketDrawer project={project} number={openNumber} userId={user.id} onClose={() => navigate(`/projects/${projectId}/calendar`)} />}
      <Modal open={leaveOpen} onClose={() => setLeaveOpen(false)} title="My leave" wide><MyLeave /></Modal>
    </div>
  );
}
