import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Ban, Flag, Layers, ListTree, Milestone, Plus, Rocket, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk, useMilestones, useSprints } from '../lib/queries.js';
import { timeAgo } from '../lib/format.js';
import { Button, KeyLink, TypeIcon } from './ui.jsx';
import { EmptyNote, Select } from '../ds/core.jsx';

// "5h", "2.5d"
const hoursText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `${Math.round(h * 10) / 10}h` : `${Math.round((h / 24) * 10) / 10}d`);

function Progress({ done, total, label }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-caption text-fg-subtle"><span>{label}</span><span className="tabular-nums">{done}/{total}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-press" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-status-done" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TicketLine({ projectId, t, onRemove }) {
  return (
    <li className="flex items-center gap-2 text-small">
      <TypeIcon type={t.type} />
      <KeyLink to={`/projects/${projectId}/tickets/${t.key}`}>{t.key}</KeyLink>
      <span className={clsx('min-w-0 flex-1 truncate', t.done && 'text-fg-subtle line-through')}>{t.title}</span>
      {t.deleted && <span className="text-micro text-fg-subtle">in the bin</span>}
      {onRemove && <button type="button" onClick={onRemove} className="text-fg-subtle hover:text-danger" aria-label={`Remove ${t.key}`}><X className="size-3.5" /></button>}
    </li>
  );
}

const Heading = ({ icon: Icon, children }) => (
  <h4 className="mb-1.5 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle"><Icon className="size-3.5" />{children}</h4>
);

// Open sprints to plan into (the current one is kept even if it has since finished).
const sprintOptions = (sprints = [], current) => sprints
  .filter((s) => s.state !== 'closed' || s.id === current)
  .map((s) => ({ id: s.id, label: s.state === 'active' ? `${s.name} (running)` : s.state === 'closed' ? `${s.name} (finished)` : s.name, disabled: s.state === 'closed' }));
const milestoneOptions = (milestones = [], current) => milestones
  .filter((m) => !m.closedAt || m.id === current)
  .map((m) => ({ id: m.id, label: m.closedAt ? `${m.name} (closed)` : m.name, disabled: Boolean(m.closedAt) }));

function PickRow({ icon: Icon, label, value, options, none, canEdit, onChange }) {
  const current = options.find((o) => o.id === value);
  return (
    <div className="flex items-center gap-2 text-small">
      <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
      <span className="w-16 shrink-0 text-caption font-medium text-fg-subtle">{label}</span>
      {canEdit ? (
        <Select size="sm" className="min-w-0 flex-1" value={value ?? ''} aria-label={label} onChange={(v) => onChange(v || null)}
          options={[{ value: '', label: none }, ...options.map((o) => ({ value: o.id, label: o.label, disabled: o.disabled }))]} />
      ) : <span className={current ? '' : 'text-fg-subtle'}>{current?.label ?? none}</span>}
    </div>
  );
}

// Epic, sprint, milestone, sub-tasks, dependencies and the blocked flag for one ticket.
export default function PlanningPanel({ project, number, ticket, canEdit, canWork }) {
  const pid = project.id;
  const qc = useQueryClient();
  const base = `/projects/${pid}/tickets/${number}`;
  const { data: r } = useQuery({ queryKey: qk.relations(pid, number), queryFn: () => api(`${base}/relations`).then((d) => d.relations) });
  const { data: epics } = useQuery({
    queryKey: ['epics', pid],
    queryFn: () => api(`/projects/${pid}/tickets?type=epic&limit=200&sort=number`).then((d) => d.tickets),
    enabled: ticket.type !== 'epic',
  });
  const { data: sprintData } = useSprints(pid);
  const { data: milestones } = useMilestones(pid);
  const [subtask, setSubtask] = useState('');
  const [blocker, setBlocker] = useState('');
  const [flagging, setFlagging] = useState(false);
  const [reason, setReason] = useState('');

  const run = async (path, method, body) => {
    try {
      const res = await api(`${base}${path}`, { method, ...(body && { body }) });
      qc.setQueryData(qk.relations(pid, number), res.relations);
      qc.invalidateQueries({ queryKey: qk.tickets(pid) });
      qc.invalidateQueries({ queryKey: qk.ticket(pid, number) });
      qc.invalidateQueries({ queryKey: qk.history(pid, number) });
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    }
  };

  // Sprint and milestone answer with the ticket itself, not its relations.
  const plan = async (path, body) => {
    try {
      await api(`${base}${path}`, { method: 'PUT', body });
      qc.invalidateQueries({ queryKey: qk.ticket(pid, number) });
      qc.invalidateQueries({ queryKey: qk.tickets(pid) });
      qc.invalidateQueries({ queryKey: qk.history(pid, number) });
      qc.invalidateQueries({ queryKey: qk.sprints(pid) });
      qc.invalidateQueries({ queryKey: qk.milestones(pid) });
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!r) return null;
  const isEpic = ticket.type === 'epic';
  const isSub = Boolean(r.parent);

  return (
    <section className="space-y-4 border-t border-line pt-6" aria-label="Planning">
      {r.blocked && (
        <div className="flex items-start gap-2 rounded-tile bg-danger/10 px-3 py-2 text-small text-danger" role="status">
          <Ban className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1"><b>Blocked</b> · {r.blocked.reason} <span className="text-caption opacity-75">since {timeAgo(r.blocked.since)}</span></span>
          {r.flag && canEdit && <Button size="sm" variant="ghost" onClick={() => run('/flag', 'DELETE')}>Clear flag</Button>}
        </div>
      )}

      {isSub && (
        <p className="text-small text-fg-muted">
          Sub-task of <Link to={`/projects/${pid}/tickets/${r.parent.key}`} className="font-medium text-accent hover:underline ">{r.parent.key} {r.parent.title}</Link>
        </p>
      )}

      {!isEpic && !isSub && (
        <div className="flex items-center gap-2 text-small">
          <Layers className="size-4 text-epic" />
          <span className="w-16 text-caption font-medium text-fg-subtle">Epic</span>
          {canEdit ? (
            <Select size="sm" className="min-w-0 flex-1" value={r.epic?.key ?? ''} aria-label="Epic" onChange={(v) => run('/epic', 'PUT', { epic: v || null })}
              options={[{ value: '', label: 'No epic' }, ...(epics ?? []).map((ep) => ({ value: ep.key, label: `${ep.key} · ${ep.title}` }))]} />
          ) : r.epic
            ? <Link to={`/projects/${pid}/tickets/${r.epic.key}`} className="text-accent hover:underline ">{r.epic.key} {r.epic.title}</Link>
            : <span className="text-fg-subtle">None</span>}
        </div>
      )}

      {!isEpic && <PickRow icon={Rocket} label="Sprint" value={ticket.sprint} options={sprintOptions(sprintData?.sprints, ticket.sprint)} none="Backlog" canEdit={canEdit} onChange={(v) => plan('/sprint', { sprint: v })} />}
      <PickRow icon={Milestone} label="Milestone" value={ticket.milestone} options={milestoneOptions(milestones, ticket.milestone)} none="None" canEdit={canEdit} onChange={(v) => plan('/milestone', { milestone: v })} />

      {isEpic && (
        <div>
          <Heading icon={Layers}>In this epic</Heading>
          <Progress done={r.epicProgress.done} total={r.epicProgress.total} label="Tickets done" />
          {r.epicProgress.points > 0 && <div className="mt-2"><Progress done={r.epicProgress.pointsDone} total={r.epicProgress.points} label="Story points done" /></div>}
          <ul className="mt-2 space-y-1">{r.epicTickets.map((x) => <TicketLine key={x.key} projectId={pid} t={x} />)}</ul>
          {r.epicTickets.length === 0 && <EmptyNote size="xs" className="mt-1">No tickets yet. Open a ticket and choose this epic.</EmptyNote>}
        </div>
      )}

      {!isEpic && !isSub && (
        <div>
          <Heading icon={ListTree}>Sub-tasks</Heading>
          {r.subtasks.length > 0 && <Progress done={r.subtaskProgress.done} total={r.subtaskProgress.total} label="Done" />}
          <ul className="mt-2 space-y-1">{r.subtasks.map((x) => <TicketLine key={x.key} projectId={pid} t={x} />)}</ul>
          {canWork && (
            <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (subtask.trim() && await run('/subtasks', 'POST', { title: subtask.trim() })) setSubtask(''); }}>
              <input className="input h-8 flex-1 text-caption" value={subtask} onChange={(e) => setSubtask(e.target.value)} placeholder="Add a sub-task…" maxLength={200} aria-label="New sub-task title" />
              <Button size="sm" type="submit" disabled={!subtask.trim()}><Plus className="size-3.5" />Add</Button>
            </form>
          )}
        </div>
      )}

      {!isEpic && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Heading icon={Ban}>Blocked by</Heading>
            <ul className="space-y-1">
              {r.blockedBy.map((x) => <TicketLine key={x.key} projectId={pid} t={x} onRemove={canEdit ? () => run(`/blockers/${x.key}`, 'DELETE') : null} />)}
            </ul>
            {r.blockedBy.length === 0 && <p className="text-caption text-fg-subtle">Nothing.</p>}
            {canEdit && (
              <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (blocker.trim() && await run('/blockers', 'POST', { ticket: blocker.trim() })) setBlocker(''); }}>
                <input className="input h-8 w-28 font-code text-caption" value={blocker} onChange={(e) => setBlocker(e.target.value)} placeholder={`${project.key}-12`} aria-label="Blocked by ticket" />
                <Button size="sm" type="submit" disabled={!blocker.trim()}>Add</Button>
              </form>
            )}
          </div>
          <div>
            <Heading icon={ListTree}>Blocks</Heading>
            <ul className="space-y-1">{r.blocks.map((x) => <TicketLine key={x.key} projectId={pid} t={x} />)}</ul>
            {r.blocks.length === 0 && <EmptyNote size="xs">Nothing waits on this.</EmptyNote>}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-caption text-fg-subtle ">
        {r.blockedTime.spells > 0
          ? <span>Blocked {hoursText(r.blockedTime.hours)} in total, {r.blockedTime.spells} time{r.blockedTime.spells === 1 ? '' : 's'}</span>
          : <span>Never blocked</span>}
        {canEdit && !r.flag && !isEpic && (flagging ? (
          <form className="ml-auto flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (reason.trim() && await run('/flag', 'PUT', { reason: reason.trim() })) { setFlagging(false); setReason(''); } }}>
            <input className="input h-8 w-56 text-caption" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is it waiting for?" maxLength={200} autoFocus aria-label="Blocked reason" />
            <Button size="sm" variant="danger" type="submit" disabled={!reason.trim()}>Flag</Button>
            <Button size="sm" onClick={() => setFlagging(false)}>Cancel</Button>
          </form>
        ) : <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFlagging(true)}><Flag className="size-3.5" />Flag as blocked</Button>)}
      </div>
    </section>
  );
}
