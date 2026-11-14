import { AlertTriangle } from 'lucide-react';
import { useProjectLeave, useWorkload } from '../lib/queries.js';
import { addDays, awayText, todayKey } from '../lib/days.js';
import { UserRound } from 'lucide-react';
import { Avatar, Select, useField } from '../ds/core.jsx';

const BUSY = new Set(['heavy', 'overloaded']);

// The workload row for each member, keyed by user id (from /projects/:id/workload).
export function useLoadByUser(projectId) {
  const { data } = useWorkload(projectId);
  return new Map((data?.members ?? []).map((r) => [r.user.id, r]));
}

// "6 open · overloaded", shown in the picker so the load is visible before choosing.
const loadText = (row) => {
  if (!row) return '';
  const level = BUSY.has(row.level) ? ` · ${row.level}` : '';
  return ` (${row.open} open${level})`;
};

// The member with the least work right now, other than `exceptId`; null if nobody is lighter.
export function lightestOther(load, workers, exceptId) {
  const busy = load.get(exceptId);
  let best = null;
  for (const m of workers) {
    if (m.user.id === exceptId) continue;
    const row = load.get(m.user.id) ?? { score: 0, open: 0 };
    if (!best || row.score < best.row.score) best = { member: m, row };
  }
  return best && busy && best.row.score < busy.score ? best : null;
}

// Why assigning this person is risky, in one sentence; null when their load is fine.
export function overloadMessage(row, name) {
  if (!row || !BUSY.has(row.level)) return null;
  const overdue = row.byDue?.overdue ? `, ${row.byDue.overdue} overdue` : '';
  const urgent = (row.byPriority?.critical ?? 0) + (row.byPriority?.high ?? 0);
  const urgentText = urgent ? `, ${urgent} high or critical` : '';
  return `${name} already has ${row.open} open ticket${row.open === 1 ? '' : 's'}${overdue}${urgentText}: ${row.level} compared with the rest of the team.`;
}

// Leave from today to two weeks ahead, for pickers.
export function useNearLeave(projectId) {
  const today = todayKey();
  return useProjectLeave(projectId, today, addDays(today, 14)).data;
}

// Assignee <select> that shows each person's current load (and any leave soon) next to their name.
export default function AssigneeSelect({ projectId, workers, value, onChange, className, ...props }) {
  const { props: field } = useField(props);
  const load = useLoadByUser(projectId);
  const leave = useNearLeave(projectId);
  const away = (id) => { const a = awayText(leave, id); return a ? ` · ${a}` : ''; };
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} {...field} {...props}>
      <option value="">Unassigned</option>
      {workers.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}{loadText(load.get(m.user.id))}{away(m.user.id)}</option>)}
    </select>
  );
}

// The same choice as the design system's menu (avatars, keyboard, type-to-jump), for the ticket
// drawer's property panel, where every other property is one of these menus too.
export function AssigneeMenu({ projectId, workers, value, onChange, ...props }) {
  const load = useLoadByUser(projectId);
  const leave = useNearLeave(projectId);
  const away = (id) => { const a = awayText(leave, id); return a ? ` · ${a}` : ''; };
  const options = [
    { value: '', label: 'Unassigned', leading: <UserRound className="size-4 shrink-0 text-fg-subtle" aria-hidden /> },
    ...workers.map((m) => ({ value: m.user.id, label: `${m.user.name}${loadText(load.get(m.user.id))}${away(m.user.id)}`, leading: <Avatar name={m.user.name} id={m.user.id} size="sm" /> })),
  ];
  return <Select size="sm" value={value} onChange={onChange} options={options} {...props} />;
}

// Inline warning under a picker (used where nothing is saved until the form is submitted).
export function OverloadNote({ projectId, workers, assigneeId, onPick }) {
  const load = useLoadByUser(projectId);
  const member = workers.find((m) => m.user.id === assigneeId);
  const message = member && overloadMessage(load.get(assigneeId), member.user.name);
  if (!message) return null;
  const alt = lightestOther(load, workers, assigneeId);
  return (
    <p className="mt-1.5 flex gap-1.5 text-caption text-warning" role="status">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>
        {message}
        {alt && (
          <> <button type="button" className="font-semibold underline underline-offset-2" onClick={() => onPick(alt.member.user.id)}>
            Assign {alt.member.user.name} instead
          </button> ({alt.row.open} open).</>
        )}
      </span>
    </p>
  );
}
