import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarRange, Flag, Inbox, Pencil, Play, Plus, Rocket, Target, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk, useMilestones, useProject, useProjectLive, useSprints } from '../lib/queries.js';
import { roleAtLeast } from '../lib/format.js';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import {
  ChartCard, Legend, STATUS_COLOR, Tip, axis, barCursor, baseAxis, chartDefs, fillRef, grid, shortDay, todayKey, useChartId, useChartMotion,
} from '../components/charts.jsx';
import { Avatar, Badge, Button, ConfirmDialog, EmptyState, Field, KeyLink, Modal, Spinner, TypeIcon } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote } from '../ds/core.jsx';

const plusDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400e3);
const range = (s) => (s.startDate && s.endDate ? `${shortDay(s.startDate)} – ${shortDay(s.endDate)}` : 'No dates yet');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Progress({ done, total, label }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex justify-between text-caption text-fg-subtle"><span>{label}</span><span className="tabular-nums">{done}/{total}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-press" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// One ticket in a sprint or the backlog, with a "Move to" picker.
function TicketRow({ project, ticket, targets, canMove, onMove, done }) {
  const status = project.statuses.find((s) => s.key === ticket.status);
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-small">
      <TypeIcon type={ticket.type} />
      <KeyLink to={`/projects/${project.id}/tickets/${ticket.key}`}>{ticket.key}</KeyLink>
      <span className={clsx('min-w-0 flex-1 truncate', done && 'text-fg-subtle line-through')}>{ticket.title}</span>
      <span className="hidden text-caption text-fg-subtle sm:inline">{status?.name ?? ticket.status}</span>
      {ticket.storyPoints !== null && <Badge>{ticket.storyPoints} pt</Badge>}
      {ticket.assignee ? <Avatar user={ticket.assignee} size="sm" /> : <span className="size-6" />}
      {canMove && (
        <select className="input h-7 w-32 text-caption" value="" aria-label={`Move ${ticket.key} to`} onChange={(e) => e.target.value && onMove(ticket, e.target.value)}>
          <option value="">Move to…</option>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
    </li>
  );
}

function SprintDialog({ sprint, onClose, onSave }) {
  const today = todayKey();
  const [name, setName] = useState(sprint?.name ?? '');
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [startDate, setStart] = useState(sprint?.startDate ?? today);
  const [endDate, setEnd] = useState(sprint?.endDate ?? plusDays(today, 13));
  const [busy, setBusy] = useState(false);
  const started = sprint?.state === 'active';
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ ...(name.trim() && { name: name.trim() }), goal: goal.trim(), ...(!started && { startDate }), endDate });
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally { setBusy(false); }
  };
  const length = startDate && endDate ? daysBetween(startDate, endDate) + 1 : null;
  return (
    <Modal open onClose={onClose} title={sprint ? `Edit ${sprint.name}` : 'New sprint'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="sprint-form" loading={busy}>{sprint ? 'Save' : 'Create sprint'}</Button></>}>
      <form id="sprint-form" onSubmit={submit} className="space-y-3">
        <Field label="Name" hint={sprint ? undefined : 'Leave empty for the next number, e.g. "Sprint 4"'}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Sprint name" />
        </Field>
        <Field label="Goal"><textarea className="input min-h-16" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={300} placeholder="What should this sprint achieve?" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day"><input type="date" className="input" value={startDate} disabled={started} onChange={(e) => setStart(e.target.value)} required /></Field>
          <Field label="Last day"><input type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} required /></Field>
        </div>
        {length !== null && <p className="text-caption text-fg-subtle">{length > 0 ? `${plural(length, 'day')} long` : 'The last day must be on or after the first'}</p>}
      </form>
    </Modal>
  );
}

function CompleteDialog({ sprint, planned, onClose, onDone }) {
  const [carryTo, setCarryTo] = useState('new');
  const [busy, setBusy] = useState(false);
  const left = sprint.tickets - sprint.done;
  const submit = async () => {
    setBusy(true);
    try { await onDone(carryTo); onClose(); } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const options = [
    { id: 'new', label: 'A new sprint, starting the day after this one ends' },
    ...planned.map((p) => ({ id: p.id, label: `${p.name} (${range(p)})` })),
    { id: 'backlog', label: 'The backlog' },
  ];
  return (
    <Modal open onClose={onClose} title={`Complete ${sprint.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Complete sprint</Button></>}>
      <p className="text-small text-fg-muted">
        {plural(sprint.done, 'ticket')} finished. {left === 0 ? 'Nothing is left over.' : `${plural(left, 'ticket')} not finished. Where should they go?`}
      </p>
      {left > 0 && (
        <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">Move unfinished tickets to</legend>
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-small">
              <input type="radio" name="carry" value={o.id} checked={carryTo === o.id} onChange={() => setCarryTo(o.id)} />{o.label}
            </label>
          ))}
        </fieldset>
      )}
      <p className="mt-3 text-caption text-fg-subtle">The retro report keeps what was committed, added, finished and left over.</p>
    </Modal>
  );
}

// Days left in a running sprint, or how late it is.
function whenText(s) {
  if (s.state !== 'active' || !s.endDate) return null;
  const left = daysBetween(todayKey(), s.endDate);
  if (left > 0) return `${plural(left, 'day')} left`;
  if (left === 0) return 'Last day';
  return `Ended ${plural(-left, 'day')} ago`;
}

function SprintCard({ project, sprint, tickets, targets, isManager, canWork, onMove, onEdit, onStart, onComplete, onDelete }) {
  const done = new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));
  const active = sprint.state === 'active';
  return (
    <section className={clsx('card', active && 'ring-2 ring-key-line')} aria-label={sprint.name}>
      <header className="flex flex-wrap items-start gap-3 border-b border-line p-4 ">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{sprint.name}</h2>
            {active ? <Badge tone="brand">Running</Badge> : <Badge>Planned</Badge>}
            <span className="flex items-center gap-1 text-caption text-fg-subtle"><CalendarRange className="size-3.5" />{range(sprint)}</span>
            {whenText(sprint) && <span className="text-caption font-medium text-fg-muted">· {whenText(sprint)}</span>}
          </div>
          {sprint.goal && <p className="mt-1 flex items-start gap-1.5 text-small text-fg-muted"><Target className="mt-0.5 size-3.5 shrink-0" />{sprint.goal}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {active && <Link to={`/projects/${project.id}/sprints/${sprint.id}`} className="btn btn-secondary btn-sm">Report</Link>}
          {isManager && <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${sprint.name}`}><Pencil className="size-3.5" /></Button>}
          {isManager && !active && <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${sprint.name}`}><Trash2 className="size-3.5" /></Button>}
          {isManager && !active && <Button size="sm" onClick={onStart}><Play className="size-3.5" />Start</Button>}
          {isManager && active && <Button size="sm" variant="primary" onClick={onComplete}><Flag className="size-3.5" />Complete</Button>}
        </div>
      </header>
      {sprint.tickets > 0 && (
        <div className="flex gap-4 px-4 pt-3">
          <Progress done={sprint.done} total={sprint.tickets} label="Tickets done" />
          {sprint.points > 0 && <Progress done={sprint.pointsDone} total={sprint.points} label="Story points done" />}
        </div>
      )}
      {tickets === undefined ? <div className="p-4"><Spinner className="text-fg-subtle" /></div> : tickets.length === 0 ? (
        <EmptyNote className="p-4">No tickets yet. Move tickets here from the backlog.</EmptyNote>
      ) : (
        <ul className="divide-y divide-line py-1 ">
          {tickets.map((t) => <TicketRow key={t.id} project={project} ticket={t} done={done.has(t.status)} targets={targets.filter((x) => x.id !== sprint.id)} canMove={canWork} onMove={onMove} />)}
        </ul>
      )}
    </section>
  );
}

// Committed is the plan (to-do grey, hatched so it parts from the violet even where the two
// greys and violets sit close in dark mode); Finished is done violet, solid.
function Velocity({ velocity }) {
  const uid = useChartId();
  const enter = useChartMotion();
  const usePoints = velocity.some((v) => v.committedPoints > 0);
  const data = velocity.map((v) => ({
    name: v.name,
    Committed: usePoints ? v.committedPoints : v.committed,
    Finished: usePoints ? v.completedPoints : v.completed,
  }));
  const unit = usePoints ? 'points' : 'tickets';
  const avg = Math.round((data.reduce((n, d) => n + d.Finished, 0) / data.length) * 10) / 10;
  return (
    <ChartCard
      title="Velocity"
      subtitle={`${usePoints ? 'Story points' : 'Tickets'} committed vs finished per sprint · average ${avg} finished`}
      table={(
        <table className="w-full text-small">
          <thead><tr className="text-left text-caption text-fg-subtle"><th className="py-1">Sprint</th><th className="text-right">Committed</th><th className="text-right">Finished</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.name} className="border-t border-line"><td className="py-1">{d.name}</td><td className="text-right tabular-nums">{d.Committed}</td><td className="text-right tabular-nums">{d.Finished}</td></tr>)}</tbody>
        </table>
      )}
    >
      <div className="h-56">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }} barGap={2}>
            {chartDefs(uid, [{ id: 'committed', color: STATUS_COLOR.todo, texture: 45 }])}
            <CartesianGrid {...grid} />
            <XAxis dataKey="name" {...baseAxis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip cursor={barCursor} content={<Tip format={(v) => `${v} ${unit}`} colorOf={(k) => (k === 'Committed' ? STATUS_COLOR.todo : STATUS_COLOR.done)} />} />
            <Bar dataKey="Committed" fill={fillRef(uid, 'committed')} stroke={STATUS_COLOR.todo} strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={18} {...enter} />
            <Bar dataKey="Finished" fill={STATUS_COLOR.done} radius={[4, 4, 0, 0]} maxBarSize={18} {...enter} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ key: 'c', name: 'Committed', color: STATUS_COLOR.todo, texture: 45 }, { key: 'f', name: 'Finished', color: STATUS_COLOR.done }]} />
    </ChartCard>
  );
}

function SprintsTab({ project }) {
  const pid = project.id;
  const qc = useQueryClient();
  const isManager = roleAtLeast(project.myRole, 'manager') && !project.archivedAt;
  const canWork = roleAtLeast(project.myRole, 'developer') && !project.archivedAt;
  const { data, isLoading } = useSprints(pid);
  const sprints = data?.sprints ?? [];
  const open = sprints.filter((s) => s.state !== 'closed');
  const closed = sprints.filter((s) => s.state === 'closed');
  const planned = open.filter((s) => s.state === 'planned');

  // Each open sprint's tickets, and the backlog (open tickets in no sprint).
  const lists = useQueries({
    queries: [
      ...open.map((s) => ({
        queryKey: qk.tickets(pid, { sprint: s.id, sort: 'rank', limit: '500' }),
        queryFn: () => api(`/projects/${pid}/tickets?sprint=${s.id}&sort=rank&limit=500`),
      })),
      {
        queryKey: qk.tickets(pid, { sprint: 'none', open: 'true', sort: 'rank', limit: '500' }),
        queryFn: () => api(`/projects/${pid}/tickets?sprint=none&open=true&sort=rank&limit=500`),
      },
    ],
  });
  const backlog = lists.at(-1)?.data?.tickets?.filter((t) => t.type !== 'epic');
  const targets = [...open.map((s) => ({ id: s.id, name: s.name })), { id: 'backlog', name: 'Backlog' }];

  const [editing, setEditing] = useState(null); // 'new' or a sprint
  const [completing, setCompleting] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.sprints(pid) });
    qc.invalidateQueries({ queryKey: qk.tickets(pid) });
    qc.invalidateQueries({ queryKey: qk.sprintReport(pid) });
  };
  const call = async (path, method, body) => {
    const res = await api(`/projects/${pid}${path}`, { method, ...(body && { body }) });
    refresh();
    return res;
  };
  const move = async (ticket, target) => {
    try {
      await call(`/tickets/${ticket.key}/sprint`, 'PUT', { sprint: target === 'backlog' ? null : target });
      toast.success(`${ticket.key} moved to ${targets.find((x) => x.id === target)?.name}`);
    } catch (e) { toast.error(e.message); }
  };
  const start = async (s) => {
    try { await call(`/sprints/${s.id}/start`, 'POST'); toast.success(`${s.name} started`); } catch (e) { toast.error(e.message); }
  };

  if (isLoading) return <div className="grid place-items-center py-16"><Spinner className="size-6 text-fg-subtle" /></div>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-small text-fg-subtle">Plan tickets into sprints, run one at a time, and complete it to carry unfinished work over.</p>
        {isManager && <Button className="ml-auto" variant="primary" size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />New sprint</Button>}
      </div>

      {open.length === 0 && (
        <EmptyState icon={Rocket} title="No sprints planned" action={isManager && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="size-4" />Plan the first sprint</Button>}>
          A sprint is a fixed stretch of days with a goal. {isManager ? 'Create one, move tickets into it from the backlog, then start it.' : 'A manager plans and starts sprints.'}
        </EmptyState>
      )}

      {open.map((s, i) => (
        <SprintCard
          key={s.id} project={project} sprint={s} tickets={lists[i]?.data?.tickets} targets={targets}
          isManager={isManager} canWork={canWork} onMove={move}
          onEdit={() => setEditing(s)} onStart={() => start(s)} onComplete={() => setCompleting(s)} onDelete={() => setDeleting(s)}
        />
      ))}

      <section className="card" aria-label="Backlog">
        <header className="flex items-center gap-2 border-b border-line p-4 ">
          <Inbox className="size-4 text-fg-subtle" /><h2 className="font-semibold">Backlog</h2>
          {backlog && <span className="text-caption text-fg-subtle">{plural(backlog.length, 'open ticket')} in no sprint</span>}
        </header>
        {backlog === undefined ? <div className="p-4"><Spinner className="text-fg-subtle" /></div> : backlog.length === 0 ? (
          <p className="p-4 text-small text-fg-subtle">Every open ticket is planned into a sprint.</p>
        ) : (
          <ul className="divide-y divide-line py-1 ">
            {backlog.map((t) => <TicketRow key={t.id} project={project} ticket={t} targets={targets.filter((x) => x.id !== 'backlog')} canMove={canWork && open.length > 0} onMove={move} />)}
          </ul>
        )}
      </section>

      {data?.velocity?.length > 0 && <Velocity velocity={data.velocity} />}

      {closed.length > 0 && (
        <section className="card" aria-label="Finished sprints">
          <h2 className="border-b border-line p-4 font-semibold ">Finished sprints</h2>
          <ul className="divide-y divide-line">
            {closed.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-small">
                <span className="font-medium">{s.name}</span>
                <span className="text-caption text-fg-subtle">{range(s)}</span>
                <span className="text-caption text-fg-subtle">{s.done}/{s.tickets} finished{s.points > 0 ? ` · ${s.pointsDone}/${s.points} points` : ''}</span>
                <Link to={`/projects/${pid}/sprints/${s.id}`} className="ml-auto text-small font-medium text-accent hover:underline ">Retro report</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing && (
        <SprintDialog
          sprint={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (editing === 'new') {
              const r = await call('/sprints', 'POST', body);
              toast.success(`${r.sprint.name} created`);
            } else {
              await call(`/sprints/${editing.id}`, 'PATCH', body);
              toast.success('Sprint saved');
            }
          }}
        />
      )}
      {completing && (
        <CompleteDialog
          sprint={completing} planned={planned} onClose={() => setCompleting(null)}
          onDone={async (carryTo) => {
            const r = await call(`/sprints/${completing.id}/complete`, 'POST', { carryTo });
            toast.success(r.carriedTo && r.unfinished
              ? `${completing.name} completed. ${plural(r.unfinished, 'ticket')} moved to ${r.carriedTo.name}.`
              : `${completing.name} completed`);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)} title={`Delete ${deleting?.name}?`} busy={busy} onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          setBusy(true);
          try { await call(`/sprints/${deleting.id}`, 'DELETE'); toast.success('Sprint deleted'); setDeleting(null); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
        }}
      >
        {deleting?.tickets ? `Its ${plural(deleting.tickets, 'ticket')} go back to the backlog. ` : ''}This can't be undone.
      </ConfirmDialog>
    </div>
  );
}

function MilestoneDialog({ milestone, onClose, onSave }) {
  const [name, setName] = useState(milestone?.name ?? '');
  const [dueDate, setDue] = useState(milestone?.dueDate ?? '');
  const [description, setDescription] = useState(milestone?.description ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { await onSave({ name: name.trim(), description: description.trim(), dueDate: dueDate || null }); onClose(); } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={milestone ? `Edit ${milestone.name}` : 'New milestone'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="milestone-form" loading={busy} disabled={!name.trim()}>{milestone ? 'Save' : 'Create milestone'}</Button></>}>
      <form id="milestone-form" onSubmit={submit} className="space-y-3">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Public beta" required /></Field>
        <Field label="Due date (optional)"><input type="date" className="input" value={dueDate} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Description (optional)"><textarea className="input min-h-16" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
      </form>
    </Modal>
  );
}

function MilestonesTab({ project }) {
  const pid = project.id;
  const qc = useQueryClient();
  const isManager = roleAtLeast(project.myRole, 'manager') && !project.archivedAt;
  const { data: milestones, isLoading } = useMilestones(pid);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const call = async (path, method, body) => {
    const res = await api(`/projects/${pid}${path}`, { method, ...(body && { body }) });
    qc.invalidateQueries({ queryKey: qk.milestones(pid) });
    qc.invalidateQueries({ queryKey: qk.tickets(pid) });
    return res;
  };
  const toggle = async (m) => {
    try {
      await call(`/milestones/${m.id}`, 'PATCH', { closed: !m.closedAt });
      toast.success(m.closedAt ? 'Milestone reopened' : 'Milestone closed');
    } catch (e) { toast.error(e.message); }
  };
  if (isLoading || !milestones) return <div className="grid place-items-center py-16"><Spinner className="size-6 text-fg-subtle" /></div>;
  const due = (m) => {
    if (!m.dueDate) return 'No due date';
    if (m.closedAt) return `Due ${shortDay(m.dueDate)}`;
    if (m.daysLeft > 0) return `Due ${shortDay(m.dueDate)} · ${plural(m.daysLeft, 'day')} left`;
    if (m.daysLeft === 0) return 'Due today';
    return `Due ${shortDay(m.dueDate)} · ${plural(-m.daysLeft, 'day')} ago`;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-small text-fg-subtle">Dated targets that tickets from any sprint or epic count towards. Pick a ticket's milestone in its Planning section.</p>
        {isManager && <Button className="ml-auto" variant="primary" size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />New milestone</Button>}
      </div>
      {milestones.length === 0 ? (
        <EmptyState icon={Flag} title="No milestones yet" action={isManager && <Button variant="primary" onClick={() => setEditing('new')}><Plus className="size-4" />Add a milestone</Button>}>
          For example "Public beta" on 15 December. Progress fills in as its tickets are finished.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {milestones.map((m) => (
            <section key={m.id} className={clsx('card p-4', m.closedAt && 'opacity-70')} aria-label={m.name}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                    {m.name}
                    {m.overdue && <Badge tone="red">Overdue</Badge>}
                    {m.closedAt && <Badge>Closed</Badge>}
                    {!m.closedAt && m.progress.total > 0 && m.progress.done === m.progress.total && <Badge tone="teal">All done</Badge>}
                  </h2>
                  <p className={clsx('text-caption', m.overdue ? 'text-danger' : 'text-fg-subtle')}>{due(m)}</p>
                </div>
                {isManager && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => toggle(m)}>{m.closedAt ? 'Reopen' : 'Close'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(m)} aria-label={`Edit ${m.name}`}><Pencil className="size-3.5" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(m)} aria-label={`Delete ${m.name}`}><Trash2 className="size-3.5" /></Button>
                  </div>
                )}
              </div>
              {m.description && <p className="mt-2 text-small text-fg-muted">{m.description}</p>}
              <div className="mt-3 flex gap-4">
                <Progress done={m.progress.done} total={m.progress.total} label="Tickets done" />
                {m.progress.points > 0 && <Progress done={m.progress.pointsDone} total={m.progress.points} label="Points done" />}
              </div>
              <Link to={`/projects/${pid}/list?milestone=${m.id}`} className="mt-3 inline-block text-caption font-medium text-accent hover:underline ">
                See its {plural(m.progress.total, 'ticket')}
              </Link>
            </section>
          ))}
        </div>
      )}
      {editing && (
        <MilestoneDialog
          milestone={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (editing === 'new') { await call('/milestones', 'POST', body); toast.success('Milestone created'); } else { await call(`/milestones/${editing.id}`, 'PATCH', body); toast.success('Milestone saved'); }
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)} title={`Delete ${deleting?.name}?`} busy={busy} onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          setBusy(true);
          try { await call(`/milestones/${deleting.id}`, 'DELETE'); toast.success('Milestone deleted'); setDeleting(null); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
        }}
      >
        Its tickets stay as they are; they just stop counting towards it. This can't be undone.
      </ConfirmDialog>
    </div>
  );
}

const TABS = [{ id: 'sprints', label: 'Sprints' }, { id: 'milestones', label: 'Milestones' }];

// Sprints (planning, backlog, velocity, finished sprints) and milestones, as two tabs.
export default function SprintsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const { data: project, error } = useProject(projectId);
  const onDeleted = useCallback(() => { toast('This project was deleted, so you are back on your projects.'); navigate('/projects'); }, [navigate]);
  useProjectLive(projectId, { onProjectDeleted: onDeleted });
  const tab = sp.get('tab') === 'milestones' ? 'milestones' : 'sprints';

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: tab === 'milestones' ? 'Milestones' : 'Sprints' }]}
        title={<ProjectSwitcher project={project} />}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <div className="inline-flex rounded-tile bg-hover p-0.5 " role="tablist" aria-label="Planning">
          {TABS.map((t) => (
            <button
              key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              onClick={() => setSp(t.id === 'sprints' ? {} : { tab: t.id }, { replace: true })}
              className={clsx('rounded-tile px-3 py-1 text-small font-medium', tab === t.id ? 'bg-raised text-fg shadow-raised ' : 'text-fg-subtle')}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'sprints' ? <SprintsTab project={project} /> : <MilestonesTab project={project} />}
      </div>
    </div>
  );
}
