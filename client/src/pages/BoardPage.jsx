import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Archive, Ban, CalendarClock, CircleCheck, History, Hourglass, Layers, ListTree, Plus, Repeat, Rocket, Search, Siren, UserRound,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { qk, useAgeing, useProject, useProjectLive, useSprints, useTickets } from '../lib/queries.js';
import { dueState, formatDue, roleAtLeast, TYPES } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import {
  Avatar, Badge, Button, Dialog, EmptyState, IconButton, Input, KeyChip, PriorityMark, STATUS_META, Select, Skeleton, Spinner, Toggle, TypeMark,
} from '../ds/core.jsx';
import TicketDrawer from '../components/LazyTicketDrawer.jsx';
import NewTicketDialog from '../components/NewTicketDialog.jsx';
import { ProjectMissing } from '../components/states.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { SlaCardBadge } from '../components/AutomationSettings.jsx';
import { SearchHelp, SearchUnderstood, SetupChecklist } from '../components/SetupSettings.jsx';
import { CardPrBadge } from '../components/GithubTools.jsx';
import { StorageBanner } from '../components/PlatformTools.jsx';

// Time travel loads only when someone opens it.
const TimeTravelBoard = lazy(() => import('../components/TimeTravelBoard.jsx'));
import { closeToCard, openFromCard } from '../lib/viewTransition.js';
import { getSocket } from '../lib/socket.js';
import { usePreferences } from '../lib/preferences.js';

// An ongoing incident (E10) shows above the board for everyone until it is resolved.
function IncidentBanner({ pid }) {
  const { data } = useQuery({ queryKey: ['incidents', pid], queryFn: () => api(`/projects/${pid}/incidents`).then((d) => d.incidents) });
  const open = (data ?? []).filter((i) => i.status === 'open');
  if (!open.length) return null;
  return (
    <div role="status" className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-card border border-danger/30 bg-danger/10 px-3 py-2 text-small text-danger sm:mx-6">
      <Siren className="size-4 shrink-0" aria-hidden />
      {open.map((i) => <span key={i.id}><strong>{i.severity.toUpperCase()}</strong> {i.title}{i.commander && ` · commander ${i.commander.name}`}</span>)}
      <Link to={`/projects/${pid}/together?tab=incidents`} className="ds-focus ml-auto rounded-hair font-medium underline underline-offset-4">Open incident</Link>
    </div>
  );
}

// Keyboard moves on the board. Up and down move within a column (the standard sortable steps).
// Left and right always mean "the next column", in the same swimlane: the lifted card is tilted a
// little, and the standard steps read that tilt as a sideways move, so a card could stay put.
function boardKeyboardCoordinates(event, args) {
  if (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft') return sortableKeyboardCoordinates(event, args);
  event.preventDefault();
  const { droppableRects, collisionRect } = args.context;
  if (!collisionRect) return undefined;
  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  const right = event.code === 'ArrowRight';
  const next = [...droppableRects.entries()]
    .filter(([id, r]) => String(id).startsWith('col:') && (right ? r.left > cx : r.left + r.width < cx))
    .map(([, r]) => ({ r, dx: Math.abs(r.left + r.width / 2 - cx), dy: cy < r.top ? r.top - cy : cy > r.top + r.height ? cy - r.top - r.height : 0 }))
    .sort((a, b) => a.dy - b.dy || a.dx - b.dx)[0]?.r;
  if (!next) return undefined;
  return {
    x: next.left + (next.width - collisionRect.width) / 2,
    y: Math.min(Math.max(collisionRect.top, next.top + 8), Math.max(next.top + 8, next.top + next.height - collisionRect.height)),
  };
}

const idOf = (t) => `t${t.number}`;
const numberOf = (id) => Number(String(id).slice(1));

// Swimlanes: a column key is "status", or "lane::status" when the board is split into lanes.
const statusOfKey = (k) => (k.includes('::') ? k.split('::')[1] : k);
const laneOfKey = (k) => (k.includes('::') ? k.split('::')[0] : null);
const LANES = [
  { value: '', label: 'No swimlanes' },
  { value: 'assignee', label: 'Lanes by assignee' },
  { value: 'epic', label: 'Lanes by epic' },
  { value: 'priority', label: 'Lanes by priority' },
];
const laneOf = (mode, t) => {
  if (mode === 'assignee') return t.assignee?.id ?? 'none';
  if (mode === 'priority') return t.priority;
  if (mode === 'epic') return t.type === 'epic' ? t.id : (t.epic ?? 'none');
  return '';
};
const TYPE_OPTIONS = [{ value: '', label: 'All types' }, ...TYPES.map((t) => ({ value: t.key, label: `${t.label}s`, leading: <TypeMark type={t.key} /> }))];

// "5h", "2.5d": how long a card has been in progress.
const ageText = (hours) => (hours < 24 ? `${Math.max(1, Math.round(hours))}h` : `${Math.round((hours / 24) * 10) / 10}d`);

// Typing somewhere: single-key shortcuts must not fire.
const typing = (el) => el?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="combobox"]');

// What cards show (E4D), set per project in Settings. Without a provider (e.g. time travel) cards show everything.
export const CardLayout = createContext(null);
// Live collaboration on the board: cards a teammate is holding (number -> who) and cards someone
// else just changed (numbers), so each card can show it without threading props through columns.
export const LiveCards = createContext(null);

export function TicketCard({ ticket, done, lifted, justDone, onOpen, age, usualHours }) {
  const due = dueState(ticket.dueDate, done);
  const layout = useContext(CardLayout);
  const live = useContext(LiveCards);
  const holder = !lifted && live?.held.get(ticket.number);
  const changed = !lifted && !justDone && !holder && live?.flashed.has(ticket.number);
  const show = (part) => !layout || layout.fields.includes(part);
  const customValues = (layout?.custom ?? []).filter((f) => ticket.fields?.[f.key] !== undefined && ticket.fields?.[f.key] !== null);
  const assignee = show('assignee') && ticket.assignee;
  return (
    <div
      onClick={onOpen}
      // The floating copy shown while dragging is not the card itself, so it carries no mark.
      data-ticket-card={lifted ? undefined : ticket.key}
      data-held-by={holder ? holder.name : undefined}
      className={clsx(
        'cursor-pointer select-none rounded-card bg-raised p-3 shadow-raised compact:px-2.5 compact:py-2 transition-[box-shadow,translate,opacity] duration-(--dur-base) ease-glass hover:-translate-y-px hover:shadow-lift',
        lifted && 'rotate-[1.5deg] shadow-lift',
        justDone && 'ds-just-done',
        holder && 'ds-held',
        changed && 'ds-live-flash',
      )}
    >
      {holder && (
        <p className="mb-2 flex items-center gap-1.5 text-micro font-medium text-key" role="status">
          <Avatar name={holder.name} id={holder.id} size="sm" presence />
          {holder.name.split(' ')[0]} is moving this
        </p>
      )}
      <div className="flex items-center gap-2">
        {show('type') && <TypeMark type={ticket.type} />}
        {show('key') && <KeyChip>{ticket.key}</KeyChip>}
        <span className="flex-1" />
        {show('priority') && <PriorityMark priority={ticket.priority} />}
        {assignee && <Avatar name={ticket.assignee.name} id={ticket.assignee.id} size="sm" />}
      </div>
      <p className={clsx('mt-2 line-clamp-3 text-small font-medium leading-snug [overflow-wrap:anywhere]', done ? 'text-fg-muted' : 'text-fg')}>
        {done && <CircleCheck className="mr-1 inline size-3.5 -translate-y-px text-status-done" role="img" aria-label="Done" />}
        {ticket.title}
      </p>
      {show('epic') && ticket.epicInfo && (
        <p className="mt-1.5 flex items-center gap-1 truncate text-caption text-fg-muted" title={`Epic ${ticket.epicInfo.key}`}>
          <Layers className="size-3 shrink-0 text-status-done" aria-hidden />{ticket.epicInfo.title}
        </p>
      )}
      {ticket.epicProgress && ticket.epicProgress.total > 0 && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-press" title={`${ticket.epicProgress.done} of ${ticket.epicProgress.total} tickets done`}>
          <div className="h-full rounded-full bg-status-done" style={{ width: `${Math.round((ticket.epicProgress.done / ticket.epicProgress.total) * 100)}%` }} />
        </div>
      )}
      {customValues.length > 0 && (
        <div className="mt-1.5 space-y-0.5 text-caption text-fg-muted">
          {customValues.map((f) => <p key={f.key} className="truncate"><span className="text-fg-subtle">{f.name}:</span> {ticket.fields[f.key] === true ? 'Yes' : ticket.fields[f.key] === false ? 'No' : String(ticket.fields[f.key])}</p>)}
        </div>
      )}
      {show('labels') && ticket.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 compact:mt-1.5">
          {ticket.labels.slice(0, 3).map((l) => <Badge key={l}>{l}</Badge>)}
          {ticket.labels.length > 3 && <Badge>+{ticket.labels.length - 3}</Badge>}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-caption text-fg-subtle empty:hidden compact:mt-1.5">
        {show('points') && ticket.storyPoints !== null && ticket.storyPoints !== undefined && <span className="font-code tabular-nums" title="Story points">{ticket.storyPoints} pt</span>}
        {show('due') && due && (
          due === 'overdue' || due === 'today'
            ? <Badge tone={due === 'overdue' ? 'danger' : 'warning'} icon={CalendarClock}>{formatDue(ticket.dueDate)}</Badge>
            : <span className="inline-flex items-center gap-1"><CalendarClock className="size-3" aria-hidden />{formatDue(ticket.dueDate)}</span>
        )}
        {show('errors') && ticket.error?.occurrences > 1 && <Badge tone="danger" icon={Repeat}><span title="Times this error was reported">{ticket.error.occurrences}×</span></Badge>}
        {show('links') && ticket.links?.length > 0 && <CardPrBadge links={ticket.links} />}
        {show('blocked') && ticket.blockedSince && !done && <span title={ticket.blockedReason ?? 'Blocked'}><Badge tone="danger" icon={Ban}>Blocked</Badge></span>}
        {show('sla') && !done && <SlaCardBadge sla={ticket.sla} />}
        {show('subtasks') && ticket.subtaskProgress && (
          <span className="inline-flex items-center gap-1 font-code tabular-nums" title="Sub-tasks done"><ListTree className="size-3" aria-hidden />{ticket.subtaskProgress.done}/{ticket.subtaskProgress.total}</span>
        )}
        {ticket.epicProgress && <span className="font-code tabular-nums" title="Tickets in this epic that are done">{ticket.epicProgress.done}/{ticket.epicProgress.total}</span>}
        {show('age') && age?.ageing && (
          <span title={`In progress for ${ageText(age.ageHours)}: longer than 85% of this team's recently finished work (usually done within ${ageText(usualHours)})`}>
            <Badge tone="warning" icon={Hourglass}>{ageText(age.ageHours)}</Badge>
          </span>
        )}
      </div>
    </div>
  );
}

function SortableCard({ ticket, disabled, done, justDone, onOpen, age, usualHours }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: idOf(ticket), disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('ds-focus rounded-card', isDragging && 'opacity-30')}
      {...attributes}
      // No aria-label: the card is named by what it shows (key, title, labels, priority, who), so the
      // name matches the visible text (WCAG 2.5.3) and voice control can say what it sees.
      {...listeners}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isDragging) onOpen(); else listeners?.onKeyDown?.(e); }}
    >
      <TicketCard ticket={ticket} done={done} justDone={justDone} onOpen={onOpen} age={age} usualHours={usualHours} />
    </div>
  );
}

// "4" or "4 / 5" (WIP limit), turning into a warning at the limit and a danger mark above it.
function ColumnCount({ count, limit }) {
  if (limit && count > limit) return <Badge tone="danger" icon={AlertTriangle}><span title={`Over the WIP limit of ${limit}`}>{count} / {limit}</span></Badge>;
  if (limit && count === limit) return <Badge tone="warning"><span title={`At the WIP limit of ${limit}`}>{count} / {limit}</span></Badge>;
  return <span className="font-code text-micro tabular-nums text-fg-subtle" title={limit ? `WIP limit ${limit}` : undefined}>{count}{limit ? ` / ${limit}` : ''}</span>;
}

function Column({ status, colKey = status.key, inLane = false, tickets, canWork, onAdd, onOpen, ageing, justDone }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${colKey}` });
  // Inside a swimlane the count is the lane's share, so the column's WIP limit is not applied to it.
  const limit = inLane ? null : status.wipLimit;
  const done = status.category === 'done';
  const meta = STATUS_META[status.category] ?? STATUS_META.todo;
  return (
    <section aria-label={status.name} className={clsx('flex w-[18rem] shrink-0 flex-col rounded-panel border border-line bg-sunken', !inLane && 'max-h-full')}>
      <header className="flex items-center gap-2 px-3 pb-2 pt-3">
        <meta.Icon className={clsx('size-3.5 shrink-0', meta.tone)} strokeWidth={2.25} aria-hidden />
        <h2 className="truncate text-small font-semibold text-fg">{status.name}</h2>
        <ColumnCount count={tickets.length} limit={limit} />
        {canWork && !inLane && <IconButton label={`New ticket in ${status.name}`} icon={Plus} size="sm" className="ml-auto" onClick={() => onAdd(status.key)} />}
      </header>
      <div
        ref={setNodeRef}
        className={clsx(
          'ds-scroll flex flex-col gap-2 rounded-b-panel px-2 pb-2 compact:gap-1.5 transition-colors duration-(--dur-fast)',
          inLane ? 'min-h-14' : 'min-h-24 flex-1 overflow-y-auto',
          isOver && 'bg-hover',
        )}
      >
        <SortableContext items={tickets.map(idOf)} strategy={verticalListSortingStrategy}>
          {tickets.map((t) => (
            <SortableCard
              key={t.id}
              ticket={t}
              disabled={!canWork}
              done={done}
              justDone={justDone === idOf(t)}
              onOpen={() => onOpen(t)}
              age={ageing?.byNumber.get(t.number)}
              usualHours={ageing?.p85Hours}
            />
          ))}
        </SortableContext>
        {tickets.length === 0 && (
          <div className={clsx('grid flex-1 place-items-center rounded-card border border-dashed border-line-strong text-caption text-fg-subtle', inLane ? 'py-3' : 'py-6')}>
            {canWork ? 'Nothing here · drag a card in' : 'Nothing here'}
          </div>
        )}
      </div>
    </section>
  );
}

// The board at a glance: one tile per ticket by status. Over 60 tickets the tiles keep the
// proportions (the words beside it give the real numbers).

export default function BoardPage() {
  const { projectId, ticketKey } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: project, error } = useProject(projectId);
  const onDeleted = useCallback(() => { toast('This project was deleted, so you are back on your projects.'); navigate('/projects'); }, [navigate]);
  useProjectLive(projectId, { onProjectDeleted: onDeleted });

  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // The board's layout (swimlanes, "Assigned to me", the running sprint only) is saved with the
  // account, so it is the same on every device and the next visit.
  const [prefs, updatePrefs] = usePreferences();
  const { lanes, mine, sprintOnly } = prefs.board;
  const setMine = (v) => updatePrefs({ board: { mine: v } });
  const [type, setType] = useState('');
  const setSprintOnly = (v) => updatePrefs({ board: { sprintOnly: v } });
  const setLanes = (v) => updatePrefs({ board: { lanes: v } });
  const { data: sprintData } = useSprints(projectId);
  const running = sprintData?.sprints.find((s) => s.state === 'active');
  const inSprint = sprintOnly && Boolean(running);
  useEffect(() => { const id = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(id); }, [search]);
  const params = useMemo(() => ({
    sort: 'rank', limit: '500', ...(mine && { assignee: 'me' }), ...(type && { type }), ...(q && { q }), ...(inSprint && { sprint: 'active' }),
  }), [mine, type, q, inSprint]);
  const { data, isLoading } = useTickets(projectId, params);
  const { data: ageingData } = useAgeing(projectId);
  const ageing = useMemo(() => (ageingData ? { p85Hours: ageingData.p85Hours, byNumber: new Map(ageingData.tickets.map((x) => [x.number, x])) } : null), [ageingData]);

  const canWork = project && roleAtLeast(project.myRole, 'developer') && !project.archivedAt;
  const isManager = project && roleAtLeast(project.myRole, 'manager');
  const isAdmin = project?.myRole === 'admin';
  const cardLayout = useMemo(() => (project ? {
    fields: project.cardFields ?? [],
    custom: (project.cardFields ?? []).filter((f) => f.startsWith('field:')).map((f) => (project.customFields ?? []).find((c) => `field:${c.key}` === f)).filter(Boolean),
  } : null), [project]);
  const doneKeys = useMemo(() => new Set(project?.statuses.filter((s) => s.category === 'done').map((s) => s.key)), [project]);

  // The lanes to draw, in order: everyone who can be assigned (and Unassigned), the four
  // priorities, or each epic with cards on the board (and No epic).
  const laneDefs = useMemo(() => {
    if (!lanes || !project || !data) return [];
    if (lanes === 'priority') return ['critical', 'high', 'medium', 'low'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), priority: id }));
    if (lanes === 'assignee') {
      const workers = project.members.filter((m) => m.role !== 'viewer');
      return [...workers.map((m) => ({ id: m.user.id, label: m.user.name, user: m.user })), { id: 'none', label: 'Unassigned' }];
    }
    const epics = new Map();
    for (const t of data.tickets) {
      if (t.type === 'epic') epics.set(t.id, { id: t.id, label: t.title, key: t.key });
      else if (t.epic && t.epicInfo && !epics.has(t.epic)) epics.set(t.epic, { id: t.epic, label: t.epicInfo.title, key: t.epicInfo.key });
    }
    return [...epics.values(), { id: 'none', label: 'No epic' }];
  }, [lanes, project, data]);

  // Columns as the server has them; `cols` is the copy that moves while dragging.
  const serverCols = useMemo(() => {
    if (!project || !data) return null;
    const keys = lanes ? laneDefs.flatMap((l) => project.statuses.map((s) => `${l.id}::${s.key}`)) : project.statuses.map((s) => s.key);
    const map = Object.fromEntries(keys.map((k) => [k, []]));
    for (const t of data.tickets) (map[lanes ? `${laneOf(lanes, t)}::${t.status}` : t.status] ??= []).push(t);
    return map;
  }, [project, data, lanes, laneDefs]);
  const [cols, setCols] = useState(null);
  const dragging = useRef(false);
  const origin = useRef(null);
  const snapshot = useRef(null);

  // Live collaboration. Cards a teammate is holding come from the "drag" relay; cards someone else
  // just changed are found by comparing each refresh with the last one. Your own moves (and the
  // ticket open in your drawer) never flash.
  const [held, setHeld] = useState(() => new Map());
  const [flashed, setFlashed] = useState(() => new Set());
  const myChanges = useRef(new Map());
  const touch = (number) => myChanges.current.set(number, Date.now());
  useEffect(() => {
    const socket = getSocket();
    const onDrag = (d) => {
      if (d.projectId !== projectId) return;
      setHeld((m) => { const n = new Map(m); if (d.dragging) n.set(d.number, d.user); else n.delete(d.number); return n; });
    };
    socket.on('drag', onDrag);
    return () => { socket.off('drag', onDrag); setHeld(new Map()); };
  }, [projectId]);
  const tellDrag = (number, dragging) => getSocket().emit('ticket:drag', { projectId, number, dragging });
  const lastSeen = useRef(null);
  const tickets = data?.tickets;
  useEffect(() => {
    if (!tickets) return undefined;
    const now = new Map(tickets.map((t) => [t.number, t.updatedAt]));
    const prev = lastSeen.current;
    lastSeen.current = now;
    if (!prev || !prev.size) return undefined;
    const newest = Math.max(...prev.keys());
    const open = ticketKey ? Number(ticketKey.split('-').pop()) : null;
    const recent = (n) => Date.now() - (myChanges.current.get(n) ?? 0) < 5000;
    const changed = [...now].filter(([n, u]) => (prev.has(n) ? prev.get(n) !== u : n > newest) && !recent(n) && n !== open).map(([n]) => n);
    if (!changed.length) return undefined;
    setFlashed(new Set(changed));
    const id = setTimeout(() => setFlashed(new Set()), 950);
    return () => clearTimeout(id);
  }, [tickets, ticketKey]);
  const liveCards = useMemo(() => ({ held, flashed }), [held, flashed]);
  const [activeId, setActiveId] = useState(null);
  const [wipPrompt, setWipPrompt] = useState(null);
  const [newIn, setNewIn] = useState(null);
  const [travel, setTravel] = useState(false);
  // The card that just landed in a done column glows for a moment (the "tile is set" moment).
  const [justDone, setJustDone] = useState(null);
  const glowTimer = useRef(0);
  useEffect(() => () => { clearTimeout(glowTimer.current); }, []);
  useEffect(() => { if (!dragging.current) setCols(serverCols); }, [serverCols]);

  // C: new ticket (not while typing, or with a dialog or the drawer open).
  useEffect(() => {
    if (!project || !canWork || travel) return undefined;
    const onKey = (e) => {
      if (e.key !== 'c' || e.ctrlKey || e.metaKey || e.altKey || typing(document.activeElement) || newIn || ticketKey) return;
      e.preventDefault();
      setNewIn(project.statuses[0].key);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [project, canWork, travel, newIn, ticketKey]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  );

  const findColumn = (id) => {
    if (!cols || !id) return null;
    if (String(id).startsWith('col:')) return String(id).slice(4);
    return Object.keys(cols).find((k) => cols[k].some((t) => idOf(t) === id)) ?? null;
  };
  const neighbours = (list, id) => {
    const i = list.findIndex((t) => idOf(t) === id);
    return { after: list[i - 1]?.number ?? null, before: list[i + 1]?.number ?? null };
  };

  const refresh = () => qc.invalidateQueries({ queryKey: qk.tickets(projectId) });

  // The card is already where it was dropped (optimistic). If the server refuses, it goes straight
  // back to where it was picked up (the snapshot from onDragStart) and the message says why.
  const move = async (number, body) => {
    try {
      await api(`/projects/${projectId}/tickets/${number}/move`, { method: 'POST', body });
      return true;
    } catch (err) {
      if (snapshot.current) setCols(snapshot.current);
      if (err.code === 'wip_limit' && isManager) setWipPrompt({ message: err.message, number, body });
      else toast.error(`Couldn't move ${project.key}-${number}: ${err.message} It's back where it was.`);
      return false;
    } finally {
      dragging.current = false;
      refresh();
    }
  };

  const onDragStart = ({ active }) => {
    tellDrag(numberOf(active.id), true);
    touch(numberOf(active.id));
    dragging.current = true;
    snapshot.current = cols;
    setActiveId(active.id);
    const column = findColumn(active.id);
    origin.current = { column, ...neighbours(cols[column], active.id) };
  };

  const onDragOver = ({ active, over }) => {
    const from = findColumn(active.id);
    const to = findColumn(over?.id);
    if (!from || !to || from === to) return;
    setCols((c) => {
      const src = [...c[from]];
      const dst = [...c[to]];
      const [item] = src.splice(src.findIndex((t) => idOf(t) === active.id), 1);
      let at = String(over.id).startsWith('col:') ? dst.length : dst.findIndex((t) => idOf(t) === over.id);
      if (at < 0) at = dst.length;
      dst.splice(at, 0, { ...item, status: statusOfKey(to) });
      return { ...c, [from]: src, [to]: dst };
    });
  };

  const onDragEnd = ({ active, over }) => {
    setActiveId(null);
    tellDrag(numberOf(active.id), false);
    touch(numberOf(active.id));
    const column = findColumn(active.id);
    if (!over || !column) { dragging.current = false; setCols(serverCols); return; }
    let list = cols[column];
    const oldIndex = list.findIndex((t) => idOf(t) === active.id);
    const overIndex = String(over.id).startsWith('col:') ? oldIndex : list.findIndex((t) => idOf(t) === over.id);
    if (overIndex >= 0 && overIndex !== oldIndex) {
      list = arrayMove(list, oldIndex, overIndex);
      setCols((c) => ({ ...c, [column]: list }));
    }
    const { after, before } = neighbours(list, active.id);
    const o = origin.current;
    if (o.column === column && o.after === after && o.before === before) { dragging.current = false; return; }
    const number = numberOf(active.id);
    const toLane = laneOfKey(column);
    const intoDone = doneKeys.has(statusOfKey(column)) && !doneKeys.has(statusOfKey(o.column));
    // Into Done: the card settles and lights up at once; if the move fails it goes back instead.
    if (intoDone) {
      clearTimeout(glowTimer.current);
      setJustDone(active.id);
      glowTimer.current = setTimeout(() => setJustDone(null), 1200);
    }
    move(number, { status: statusOfKey(column), after, before }).then((ok) => {
      if (!ok && intoDone) setJustDone(null);
      if (ok && lanes && toLane !== laneOfKey(o.column)) changeLane(number, toLane);
    });
  };

  // Dropped into another swimlane: give the ticket that lane's assignee, priority or epic.
  const changeLane = async (number, laneId) => {
    const lane = laneDefs.find((l) => l.id === laneId);
    try {
      if (lanes === 'epic') {
        await api(`/projects/${projectId}/tickets/${number}/epic`, { method: 'PUT', body: { epic: laneId === 'none' ? null : lane.key } });
      } else {
        const body = lanes === 'assignee' ? { assigneeId: laneId === 'none' ? null : laneId } : { priority: laneId };
        await api(`/projects/${projectId}/tickets/${number}`, { method: 'PATCH', body });
      }
      toast.success(`${project.key}-${number} moved to ${lane?.label ?? 'that lane'}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      refresh();
    }
  };

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <BoardSkeleton />;

  // What screen readers hear while a card moves: ticket keys and column names, not internal ids.
  const columnName = (key) => {
    if (!key) return 'no column';
    const s = project.statuses.find((x) => x.key === statusOfKey(key));
    const lane = laneDefs.find((l) => l.id === laneOfKey(key));
    return `${s?.name ?? 'a column'}${lane ? `, lane ${lane.label}` : ''}`;
  };
  const keyOf = (id) => (cols ? Object.values(cols).flat().find((t) => idOf(t) === id)?.key : null) ?? 'the ticket';
  const where = (overId, activeId) => {
    if (!overId) return 'outside the columns';
    if (String(overId).startsWith('col:')) return `in ${columnName(String(overId).slice(4))}`;
    if (overId === activeId) return `in ${columnName(findColumn(overId))}`;
    return `next to ${keyOf(overId)} in ${columnName(findColumn(overId))}`;
  };
  const accessibility = {
    screenReaderInstructions: { draggable: 'To move a ticket, press Space to pick it up, use the arrow keys to move it, then Space to drop it or Escape to cancel. Press Enter to open it.' },
    announcements: {
      onDragStart: ({ active: a }) => `Picked up ${keyOf(a.id)} from ${columnName(findColumn(a.id))}.`,
      // Nothing while the card is still over its own place: dnd-kit reports that the moment a card
      // is picked up, and saying it would talk over "Picked up …" before a screen reader reads it.
      onDragOver: ({ active: a, over }) => (over && over.id !== a.id ? `${keyOf(a.id)} is ${where(over.id, a.id)}.` : undefined),
      onDragEnd: ({ active: a, over }) => (over ? `Dropped ${keyOf(a.id)} ${where(over.id, a.id)}.` : `Dropped ${keyOf(a.id)}; it stays where it was.`),
      onDragCancel: ({ active: a }) => `Cancelled. ${keyOf(a.id)} is back where it was.`,
    },
  };

  const active = activeId && cols ? Object.values(cols).flat().find((t) => idOf(t) === activeId) : null;
  const openNumber = ticketKey ? Number(ticketKey.split('-').pop()) : null;
  const filtered = mine || type || q || inSprint;
  // The card grows into the drawer, and the drawer shrinks back into it (lib/viewTransition.js).
  const openTicket = (t) => openFromCard(t.key, () => navigate(`/projects/${projectId}/tickets/${t.key}`));

  return (
    <CardLayout.Provider value={cardLayout}>
    <LiveCards.Provider value={liveCards}>
      <div className="flex h-full flex-col">
        <PageHeader
          crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name }]}
          title={(
            <ProjectSwitcher project={project}>
              {project.archivedAt && <Badge tone="warning" icon={Archive}>Archived · read-only</Badge>}
            </ProjectSwitcher>
          )}
          actions={(
            <>
              <div className="hidden -space-x-1.5 sm:flex">
                {project.members.slice(0, 6).map((m) => <Avatar key={m.user.id} name={m.user.name} id={m.user.id} className="ring-2 ring-canvas" />)}
              </div>
              <Button icon={History} onClick={() => setTravel((v) => !v)} aria-pressed={travel}>{travel ? 'Back to now' : 'Time travel'}</Button>
              {canWork && !travel && <Button variant="primary" icon={Plus} kbd="C" onClick={() => setNewIn(project.statuses[0].key)}>New ticket</Button>}
            </>
          )}
        >
          <ProjectTabs projectId={projectId} />
        </PageHeader>
        <IncidentBanner pid={projectId} />
        <StorageBanner project={project} />
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
          <div className="w-full sm:w-64">
            <Input size="sm" icon={Search} placeholder={`Search or jump to ${project.key}-12`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tickets" />
          </div>
          <SearchHelp />
          <Toggle pressed={mine} onChange={setMine} icon={UserRound}>Assigned to me</Toggle>
          {running && <Toggle pressed={inSprint} onChange={setSprintOnly} icon={Rocket} title={running.goal || undefined}>{running.name}</Toggle>}
          <Select size="sm" className="w-36" value={type} onChange={setType} options={TYPE_OPTIONS} aria-label="Type" />
          <Select size="sm" className="w-44" value={lanes} onChange={setLanes} options={LANES} aria-label="Swimlanes" />
          {filtered && <span className="text-caption text-fg-subtle">{data?.total ?? 0} matching</span>}
          {isLoading && <Spinner className="text-fg-subtle" label="Loading tickets" />}
        </div>
        {data?.search && <SearchUnderstood search={data.search} className="-mt-1 px-4 pb-2 sm:px-6" />}
        {isManager && !travel && !project.archivedAt && <SetupChecklist project={project} />}

        {travel ? <Suspense fallback={<div className="mx-4 h-28 rounded-card ds-skeleton sm:mx-6" aria-busy="true" aria-label="Loading time travel" />}><TimeTravelBoard project={project} /></Suspense> : cols && data?.total === 0 && !filtered && Object.values(cols).every((c) => c.length === 0) ? (
          project.archivedAt ? (
            <EmptyState icon={Archive} title="Archived with an empty board">
              This project is read-only. {isAdmin ? 'Unarchive it in Settings to add tickets again.' : 'An admin can unarchive it.'}
            </EmptyState>
          ) : (
            <EmptyState
              icon={Layers}
              title="A clean slate"
              action={canWork && <Button variant="primary" icon={Plus} kbd="C" onClick={() => setNewIn(project.statuses[0].key)}>Create the first ticket</Button>}
            >
              {canWork ? 'Create a ticket, or paste an error or stack trace and Tessera turns it into a bug report. Each ticket becomes a tile in this window.' : 'Nobody has added a ticket yet. Each ticket becomes a tile here.'}
            </EmptyState>
          )
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCorners} accessibility={accessibility} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={({ active }) => { tellDrag(numberOf(active.id), false); setActiveId(null); dragging.current = false; setCols(serverCols); }}>
            {!lanes ? (
              <div className="ds-scroll flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 sm:px-6">
                {cols ? project.statuses.map((s) => (
                  <Column key={s.key} status={s} tickets={cols[s.key] ?? []} canWork={canWork} onAdd={setNewIn} onOpen={openTicket} ageing={ageing} justDone={justDone} />
                )) : project.statuses.map((s) => <ColumnSkeleton key={s.key} />)}
              </div>
            ) : (
              <div className="ds-scroll min-h-0 flex-1 overflow-auto px-4 pb-4 sm:px-6">
                <div className="w-max space-y-4">
                  <div className="sticky top-0 z-10 flex gap-3 bg-canvas/90 py-1.5 backdrop-blur-md">
                    {project.statuses.map((s) => {
                      const n = cols ? Object.entries(cols).filter(([k]) => statusOfKey(k) === s.key).reduce((sum, [, list]) => sum + list.length, 0) : 0;
                      const meta = STATUS_META[s.category] ?? STATUS_META.todo;
                      return (
                        <div key={s.key} className="flex w-[18rem] items-center gap-2 px-3 text-small font-semibold text-fg">
                          <meta.Icon className={clsx('size-3.5 shrink-0', meta.tone)} strokeWidth={2.25} aria-hidden />
                          {s.name}
                          <ColumnCount count={n} limit={s.wipLimit} />
                        </div>
                      );
                    })}
                  </div>
                  {cols && laneDefs.map((l) => {
                    const lists = project.statuses.map((s) => cols[`${l.id}::${s.key}`] ?? []);
                    const count = lists.reduce((sum, list) => sum + list.length, 0);
                    return (
                      <section key={l.id} aria-label={`Lane ${l.label}`}>
                        <h3 className="mb-2 flex items-center gap-2 px-1 text-small font-semibold text-fg">
                          {l.user && <Avatar name={l.user.name} id={l.user.id} size="sm" />}
                          {lanes === 'priority' && <PriorityMark priority={l.priority} />}
                          {lanes === 'epic' && l.id !== 'none' && <Layers className="size-3.5 text-status-done" aria-hidden />}
                          <span className="truncate">{l.label}</span>
                          <span className="font-code text-micro font-normal text-fg-subtle">{count}</span>
                        </h3>
                        <div className="flex gap-3">
                          {project.statuses.map((s, i) => (
                            <Column key={s.key} status={s} colKey={`${l.id}::${s.key}`} inLane tickets={lists[i]} canWork={canWork} onAdd={setNewIn} onOpen={openTicket} ageing={ageing} justDone={justDone} />
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </div>
            )}
            <DragOverlay>{active ? <TicketCard ticket={active} done={doneKeys.has(active.status)} lifted /> : null}</DragOverlay>
          </DndContext>
        )}

        {openNumber && <TicketDrawer project={project} number={openNumber} userId={user.id} onClose={() => closeToCard(`${project.key}-${openNumber}`, () => navigate(`/projects/${projectId}`))} />}
        <NewTicketDialog
          project={project}
          open={Boolean(newIn)}
          status={newIn}
          onClose={() => setNewIn(null)}
          onCreated={(t) => { touch(t.number); navigate(`/projects/${projectId}/tickets/${t.key}`); }}
        />
        <Dialog
          open={Boolean(wipPrompt)}
          onClose={() => setWipPrompt(null)}
          title="This column is full"
          description={wipPrompt?.message}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setWipPrompt(null)}>Keep it where it was</Button>
              <Button variant="primary" onClick={() => { const p = wipPrompt; setWipPrompt(null); move(p.number, { ...p.body, overrideWip: true }); }}>Move it anyway</Button>
            </>
          )}
        >
          <p className="text-small text-fg-muted">As a manager you can go over the limit. The override is recorded in the ticket's history.</p>
        </Dialog>
      </div>
    </LiveCards.Provider>
    </CardLayout.Provider>
  );
}

// While the project loads: the shape of the board, not a spinner.
function ColumnSkeleton() {
  return (
    <div className="flex w-[18rem] shrink-0 flex-col gap-2 rounded-panel border border-line bg-sunken p-2">
      <Skeleton className="mx-1 my-1.5 h-4 w-24" />
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading the board">
      <div className="border-b border-line px-4 pb-3 pt-4 sm:px-6">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-3 h-8 w-56" />
        <Skeleton className="mt-4 h-6 w-96 max-w-full" />
      </div>
      <div className="flex gap-3 overflow-hidden px-4 py-4 sm:px-6">{[0, 1, 2].map((i) => <ColumnSkeleton key={i} />)}</div>
    </div>
  );
}
