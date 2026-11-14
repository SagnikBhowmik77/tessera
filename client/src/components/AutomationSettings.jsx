import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, History, Pencil, Plus, Timer, Trash2, Workflow, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { PRIORITIES, TYPES, formatDateTime, priorityOf, timeAgo } from '../lib/format.js';
import { Badge, Button, ConfirmDialog, Field, KeyLink, Modal } from './ui.jsx';
import { ChartCard } from './ChartCard.jsx';
import { SettingsSection as Section } from './SettingsSection.jsx';
import { EmptyNote, KeyChip, PriorityMark } from '../ds/core.jsx';

// Settings and displays for E4C: automation rules, service levels (SLA), the audit log.


const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const hoursText = (h) => (h >= 48 && h % 24 === 0 ? plural(h / 24, 'day') : plural(h, 'hour'));
// "2 h 15 min", "3 days"
export function spanText(ms) {
  const min = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 && h < 10 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const workers = (project) => project.members.filter((m) => m.role !== 'viewer');
const memberName = (project, id) => project.members.find((m) => m.user.id === id)?.user.name ?? 'a former member';
const statusName = (project, key) => project.statuses.find((s) => s.key === key)?.name ?? key;

// ---- Rules

export const TRIGGERS = {
  created: 'A ticket is created',
  moved: 'A ticket moves into a column',
  priority_changed: 'Priority changes',
  assigned: 'A ticket is assigned to someone',
  label_added: 'A label is added',
  sla_breached: 'A service-level target is missed',
};
const ACTIONS = {
  assign: 'Assign to',
  set_priority: 'Set priority',
  add_label: 'Add label',
  remove_label: 'Remove label',
  move: 'Move to column',
  due_in: 'Set due date',
  add_watcher: 'Add watcher',
};

function triggerText(t, project) {
  switch (t.type) {
    case 'moved': return t.status ? `a ticket moves into ${statusName(project, t.status)}` : 'a ticket moves to another column';
    case 'priority_changed': return t.priority ? `priority changes to ${priorityOf(t.priority).label}` : 'priority changes';
    case 'label_added': return `the label "${t.label}" is added`;
    case 'sla_breached': return t.kind === 'response' ? 'the first-response target is missed' : t.kind === 'resolve' ? 'the resolution target is missed' : 'a service-level target is missed';
    default: return TRIGGERS[t.type].charAt(0).toLowerCase() + TRIGGERS[t.type].slice(1);
  }
}

function conditionText(c) {
  const parts = [];
  if (c.types?.length) parts.push(c.types.map((t) => TYPES.find((x) => x.key === t)?.label ?? t).join(' or '));
  if (c.priorities?.length) parts.push(`${c.priorities.map((p) => priorityOf(p).label).join(' or ')} priority`);
  if (c.labels?.length) parts.push(`labelled ${c.labels.join(' or ')}`);
  if (c.unassigned === true) parts.push('unassigned');
  if (c.unassigned === false) parts.push('assigned to someone');
  return parts.join(', ');
}

function actionText(a, project) {
  switch (a.type) {
    case 'assign': return a.value ? `assign to ${memberName(project, a.value)}` : 'unassign';
    case 'set_priority': return `set priority to ${priorityOf(a.value).label}`;
    case 'add_label': return `add label "${a.value}"`;
    case 'remove_label': return `remove label "${a.value}"`;
    case 'move': return `move to ${statusName(project, a.value)}`;
    case 'due_in': return a.value === 0 ? 'make it due today' : `make it due in ${plural(a.value, 'day')}`;
    case 'add_watcher': return `add ${memberName(project, a.value)} as a watcher`;
    default: return a.type;
  }
}

export function ruleSentence(rule, project) {
  const cond = conditionText(rule.conditions ?? {});
  return `When ${triggerText(rule.trigger, project)}${cond ? ` (only if ${cond})` : ''}: ${rule.actions.map((a) => actionText(a, project)).join(', then ')}.`;
}

const actionDefault = (type, project) => ({
  assign: workers(project)[0]?.user.id ?? null,
  set_priority: 'high',
  add_label: '',
  remove_label: '',
  move: project.statuses[0].key,
  due_in: 3,
  add_watcher: project.members[0]?.user.id,
}[type]);

const EMPTY_RULE = { name: '', trigger: { type: 'created' }, conditions: { types: [], priorities: [], labels: [], unassigned: null }, actions: [] };

function Toggle({ on, onClick, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      className={clsx('ds-focus relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-(--dur-base)', on ? 'border-transparent ds-gradient' : 'border-line-strong bg-press')}>
      <span className={clsx('absolute top-0.5 size-3.5 rounded-full transition-[left] duration-(--dur-base) ease-glass', on ? 'left-[18px] bg-on-gradient' : 'left-0.5 bg-fg-muted')} />
    </button>
  );
}

function Chips({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.key);
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== o.key) : [...value, o.key])}
            className={clsx('ds-focus rounded-full border px-2.5 py-0.5 text-caption font-medium transition-colors duration-(--dur-fast)',
              on ? 'border-transparent bg-fg text-canvas' : 'border-line-strong text-fg-muted hover:text-fg')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ActionValue({ action, project, onChange }) {
  const common = { className: 'input h-8 min-w-0 flex-1 text-caption', 'aria-label': ACTIONS[action.type] };
  switch (action.type) {
    case 'assign':
      return (
        <select {...common} value={action.value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Nobody (unassign)</option>
          {workers(project).map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
        </select>
      );
    case 'add_watcher':
      return <select {...common} value={action.value ?? ''} onChange={(e) => onChange(e.target.value)}>{project.members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}</select>;
    case 'set_priority':
      return <select {...common} value={action.value} onChange={(e) => onChange(e.target.value)}>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>;
    case 'move':
      return <select {...common} value={action.value} onChange={(e) => onChange(e.target.value)}>{project.statuses.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select>;
    case 'due_in':
      return (
        <span className="flex flex-1 items-center gap-1.5 text-caption text-fg-subtle">
          <input type="number" min="0" max="365" className="input h-8 w-20 text-caption" value={action.value} aria-label="Days from today" onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
          days from the day it runs
        </span>
      );
    default:
      return <input {...common} value={action.value} maxLength={30} placeholder="label" onChange={(e) => onChange(e.target.value)} />;
  }
}

function RuleDialog({ project, rule, onClose, onSaved }) {
  const [form, setForm] = useState(() => (rule
    ? { name: rule.name, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions, labelsText: rule.conditions.labels.join(', ') }
    : { ...EMPTY_RULE, actions: [{ type: 'assign', value: actionDefault('assign', project) }], labelsText: '' }));
  const [busy, setBusy] = useState(false);
  const setTrigger = (k, v) => setForm((f) => ({ ...f, trigger: { ...f.trigger, [k]: v } }));
  const setCond = (k, v) => setForm((f) => ({ ...f, conditions: { ...f.conditions, [k]: v } }));
  const setAction = (i, patch) => setForm((f) => ({ ...f, actions: f.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = {
      name: form.name.trim(),
      trigger: form.trigger,
      conditions: { ...form.conditions, labels: form.labelsText.split(',').map((l) => l.trim()).filter(Boolean) },
      actions: form.actions,
    };
    try {
      await api(`/projects/${project.id}/rules${rule ? `/${rule.id}` : ''}`, { method: rule ? 'PATCH' : 'POST', body });
      toast.success(rule ? 'Rule saved' : 'Rule created');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.details?.[0]?.message ?? err.message);
    } finally { setBusy(false); }
  };
  const t = form.trigger;
  return (
    <Modal open onClose={onClose} title={rule ? `Edit ${rule.name}` : 'New automation rule'} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="rule-form" loading={busy} disabled={!form.actions.length}>{rule ? 'Save rule' : 'Create rule'}</Button></>}>
      <form id="rule-form" onSubmit={submit} className="space-y-4">
        <Field label="Rule name"><input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={80} placeholder="Route new bugs to Asha" required /></Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-caption font-semibold uppercase tracking-wide text-fg-subtle">When</legend>
          <div className="flex flex-wrap gap-2">
            <select className="input h-9 w-auto text-small" value={t.type} aria-label="When" onChange={(e) => setForm((f) => ({ ...f, trigger: { type: e.target.value } }))}>
              {Object.entries(TRIGGERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {t.type === 'moved' && (
              <select className="input h-9 w-auto text-small" value={t.status ?? ''} aria-label="Column" onChange={(e) => setTrigger('status', e.target.value || null)}>
                <option value="">Any column</option>
                {project.statuses.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            )}
            {t.type === 'priority_changed' && (
              <select className="input h-9 w-auto text-small" value={t.priority ?? ''} aria-label="New priority" onChange={(e) => setTrigger('priority', e.target.value || null)}>
                <option value="">To any priority</option>
                {PRIORITIES.map((p) => <option key={p.key} value={p.key}>To {p.label}</option>)}
              </select>
            )}
            {t.type === 'label_added' && <input className="input h-9 w-40 text-small" value={t.label ?? ''} maxLength={30} placeholder="label" aria-label="Label" required onChange={(e) => setTrigger('label', e.target.value)} />}
            {t.type === 'sla_breached' && (
              <select className="input h-9 w-auto text-small" value={t.kind ?? ''} aria-label="Which target" onChange={(e) => setTrigger('kind', e.target.value || null)}>
                <option value="">Either target</option><option value="response">First response</option><option value="resolve">Resolution</option>
              </select>
            )}
          </div>
          {t.type === 'label_added' && <p className="text-caption text-fg-subtle">A ticket created with this label counts too.</p>}
          {t.type === 'sla_breached' && !project.sla?.enabled && <p className="text-caption text-warning">Service levels are off for this project, so this rule won't run until they're turned on below.</p>}
        </fieldset>
        <fieldset className="space-y-2.5">
          <legend className="mb-1 text-caption font-semibold uppercase tracking-wide text-fg-subtle">Only if (optional)</legend>
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle"><span className="w-16">Type</span><Chips options={TYPES} value={form.conditions.types} onChange={(v) => setCond('types', v)} /></div>
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle"><span className="w-16">Priority</span><Chips options={PRIORITIES} value={form.conditions.priorities} onChange={(v) => setCond('priorities', v)} /></div>
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle">
            <span className="w-16">Labels</span>
            <input className="input h-8 min-w-0 flex-1 text-caption" value={form.labelsText} placeholder="any of these labels, comma separated" aria-label="Has any of these labels" onChange={(e) => setForm((f) => ({ ...f, labelsText: e.target.value }))} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle">
            <span className="w-16">Assignee</span>
            <select className="input h-8 w-auto text-caption" aria-label="Assignee condition" value={form.conditions.unassigned === null ? '' : String(form.conditions.unassigned)}
              onChange={(e) => setCond('unassigned', e.target.value === '' ? null : e.target.value === 'true')}>
              <option value="">Anyone or nobody</option><option value="true">Only unassigned</option><option value="false">Only assigned</option>
            </select>
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-caption font-semibold uppercase tracking-wide text-fg-subtle">Then</legend>
          {form.actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select className="input h-8 w-40 text-caption" value={a.type} aria-label={`Action ${i + 1}`} onChange={(e) => setAction(i, { type: e.target.value, value: actionDefault(e.target.value, project) })}>
                {Object.entries(ACTIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <ActionValue action={a} project={project} onChange={(value) => setAction(i, { value })} />
              <Button size="icon" variant="ghost" aria-label={`Remove action ${i + 1}`} onClick={() => setForm((f) => ({ ...f, actions: f.actions.filter((_, j) => j !== i) }))}><X className="size-4" /></Button>
            </div>
          ))}
          <Button size="sm" disabled={form.actions.length >= 5} onClick={() => setForm((f) => ({ ...f, actions: [...f.actions, { type: 'add_label', value: '' }] }))}><Plus className="size-3.5" />Add action</Button>
        </fieldset>
      </form>
    </Modal>
  );
}

export function Rules({ project }) {
  const qc = useQueryClient();
  const { data: rules } = useQuery({ queryKey: ['rules', project.id], queryFn: () => api(`/projects/${project.id}/rules`).then((d) => d.rules) });
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['rules', project.id] });
  const act = async (path, method, body, done) => {
    try {
      await api(`/projects/${project.id}/rules${path}`, { method, ...(body && { body }) });
      if (done) toast.success(done);
      refresh();
      return true;
    } catch (e) { toast.error(e.message); return false; }
  };
  const move = (i, by) => {
    const ids = rules.map((r) => r.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    act('/order', 'PUT', { ids });
  };
  return (
    <Section title="Automation rules" description="“When X happens, do Y.” Rules run top to bottom, right after the change that starts them. Changes a rule makes don't start other rules.">
      {rules?.length === 0 && <EmptyNote className="mb-3">No rules yet. For example: when a bug is created and nobody is assigned, assign it to your triage person and add the label “triage”.</EmptyNote>}
      <ul className="divide-y divide-line">
        {(rules ?? []).map((r, i) => (
          <li key={r.id} className="flex items-start gap-3 py-3 text-small">
            <Toggle on={r.enabled} label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.name}`} onClick={() => act(`/${r.id}`, 'PATCH', { enabled: !r.enabled }, r.enabled ? 'Rule turned off' : 'Rule turned on')} />
            <span className="min-w-0 flex-1">
              <span className={clsx('font-medium', !r.enabled && 'text-fg-subtle')}>{r.name}</span>
              {!r.enabled && <Badge className="ml-2">Off</Badge>}
              <span className="block text-caption text-fg-muted">{ruleSentence(r, project)}</span>
              <span className="block text-caption text-fg-subtle">
                {r.runs ? <>Ran {plural(r.runs, 'time')}, last on <KeyChip>{r.lastRun.ticketKey}</KeyChip> {timeAgo(r.lastRun.at)}</> : 'Hasn\'t run yet'}
              </span>
              {r.lastError && (
                <span className="mt-0.5 flex items-start gap-1 text-caption text-warning">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span>On <KeyChip>{r.lastError.ticketKey}</KeyChip> {timeAgo(r.lastError.at)}, it couldn't do everything: {r.lastError.message}</span>
                </span>
              )}
            </span>
            <span className="flex shrink-0">
              <Button size="icon" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${r.name} up`}><ArrowUp className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${r.name} down`}><ArrowDown className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}><Pencil className="size-3.5" /></Button>
              <Button size="icon" variant="ghost" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}><Trash2 className="size-3.5" /></Button>
            </span>
          </li>
        ))}
      </ul>
      <Button size="sm" className="mt-3" disabled={rules?.length >= 30} onClick={() => setEditing('new')}><Workflow className="size-3.5" />New rule</Button>
      {editing && <RuleDialog project={project} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmDialog open={Boolean(deleting)} title={`Delete “${deleting?.name}”?`} onCancel={() => setDeleting(null)}
        onConfirm={async () => { if (await act(`/${deleting.id}`, 'DELETE', null, 'Rule deleted')) setDeleting(null); }}>
        It stops running straight away. Changes it already made to tickets stay, with their history.
      </ConfirmDialog>
    </Section>
  );
}

// ---- Service levels

export function ServiceLevels({ project, refresh }) {
  const fromProject = () => ({
    enabled: Boolean(project.sla?.enabled),
    rows: Object.fromEntries(PRIORITIES.map((p) => {
      const t = project.sla?.targets?.find((x) => x.priority === p.key);
      return [p.key, { response: t?.responseHours ?? '', resolve: t?.resolveHours ?? '' }];
    })),
  });
  const [form, setForm] = useState(fromProject);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(fromProject()), [project.sla]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p, k, v) => setForm((f) => ({ ...f, rows: { ...f.rows, [p]: { ...f.rows[p], [k]: v } } }));
  const num = (v) => (v === '' ? null : Number(v));
  const save = async () => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/sla`, {
        method: 'PUT',
        body: {
          enabled: form.enabled,
          targets: PRIORITIES.map((p) => ({ priority: p.key, responseHours: num(form.rows[p.key].response), resolveHours: num(form.rows[p.key].resolve) }))
            .filter((t) => t.responseHours !== null || t.resolveHours !== null),
        },
      });
      toast.success(form.enabled ? 'Service levels saved' : 'Service levels turned off');
      refresh();
    } catch (e) { toast.error(e.details?.[0]?.message ?? e.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Service levels (SLA)" description="Promise how fast tickets get a first response and get resolved, by priority. Leave a box empty for no target.">
      <div className="mb-3 flex items-center gap-2 text-small">
        <Toggle on={form.enabled} label="Use service levels" onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))} />
        Use service levels in this project
      </div>
      <div className={clsx('overflow-x-auto', !form.enabled && 'opacity-50')}>
        <table className="w-full text-small">
          <thead><tr className="text-left text-caption text-fg-subtle"><th className="py-1 font-medium">Priority</th><th className="py-1 font-medium">First response within</th><th className="py-1 font-medium">Resolved within</th></tr></thead>
          <tbody>
            {PRIORITIES.map((p) => (
              <tr key={p.key}>
                <td className={clsx('py-1.5 pr-3 font-medium', p.text)}>{p.label}</td>
                {['response', 'resolve'].map((k) => (
                  <td key={k} className="py-1.5 pr-3">
                    <span className="flex items-center gap-1.5 text-caption text-fg-subtle">
                      <input type="number" min="1" max="2160" step="1" className="input h-8 w-20 text-caption" disabled={!form.enabled} value={form.rows[p.key][k]}
                        aria-label={`${p.label}: ${k === 'response' ? 'first response' : 'resolved'} within hours`} onChange={(e) => set(p.key, k, e.target.value)} />
                      hours
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 list-disc space-y-0.5 pl-4 text-caption text-fg-subtle">
        <li>Clocks start when a ticket is created and count calendar hours, including nights and weekends.</li>
        <li>A first response is a comment from someone other than the reporter, or the ticket leaving a to-do column. Resolving it counts too.</li>
        <li>When a ticket misses a target, its assignee is notified (the project's managers, if nobody is assigned). Tickets already past a target when you save are shown as late but not notified.</li>
        <li>Missed targets are checked every 5 minutes while the server is running. On free hosting the server sleeps when unused, so a notice can arrive late, but it is never lost.</li>
      </ul>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setForm(fromProject())}>Undo changes</Button>
        <Button variant="primary" loading={busy} disabled={JSON.stringify(form) === JSON.stringify(fromProject())} onClick={save}>Save service levels</Button>
      </div>
    </Section>
  );
}

const SLA_LABEL = { response: 'First response', resolve: 'Resolution' };

function clockBadge(c, now) {
  const left = new Date(c.dueAt) - now;
  switch (c.state) {
    case 'met': return { tone: 'teal', text: 'Met', title: `Done ${formatDateTime(c.doneAt)}, within ${hoursText(c.hours)}` };
    case 'missed': return { tone: 'red', text: `Missed by ${spanText(new Date(c.doneAt) - new Date(c.dueAt))}`, title: `Target was ${hoursText(c.hours)}` };
    case 'breached': return { tone: 'red', text: `Late by ${spanText(left)}`, title: `Was due ${formatDateTime(c.dueAt)} (${hoursText(c.hours)})` };
    case 'at_risk': return { tone: 'amber', text: `${spanText(left)} left`, title: `Due ${formatDateTime(c.dueAt)} (${hoursText(c.hours)})` };
    default: return { tone: 'zinc', text: `${spanText(left)} left`, title: `Due ${formatDateTime(c.dueAt)} (${hoursText(c.hours)})` };
  }
}

// Both clocks of one ticket, for the ticket drawer.
export function SlaPills({ sla }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!sla) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {['response', 'resolve'].filter((k) => sla[k]).map((k) => {
        const b = clockBadge(sla[k], now);
        // Wraps instead of spilling out of a narrow column (the drawer's side panel).
        return <span key={k} title={b.title} className="max-w-full"><Badge tone={b.tone} className="h-auto! min-h-5 whitespace-normal! py-0.5"><Timer className="size-3 shrink-0" />{SLA_LABEL[k]}: {b.text}</Badge></span>;
      })}
    </div>
  );
}

// A small warning on board cards: only when a clock is late or close to it.
export function SlaCardBadge({ sla }) {
  if (!sla) return null;
  const open = ['response', 'resolve'].filter((k) => sla[k] && ['breached', 'at_risk'].includes(sla[k].state));
  if (!open.length) return null;
  const late = open.some((k) => sla[k].state === 'breached');
  const title = open.map((k) => `${SLA_LABEL[k]}: ${sla[k].state === 'breached' ? 'late' : 'due soon'} (target ${hoursText(sla[k].hours)})`).join('. ');
  return (
    <span title={title} className={clsx('inline-flex items-center gap-0.5 rounded-hair px-1 font-medium',
      late ? 'bg-danger/12 text-danger' : 'bg-warning/12 text-warning')}>
      <Timer className="size-3" />{late ? 'SLA late' : 'SLA soon'}
    </span>
  );
}

// How the project is doing against its targets (Analytics page).
export function SlaReport({ project, days }) {
  const { data } = useQuery({
    queryKey: ['sla-report', project.id, days],
    queryFn: () => api(`/projects/${project.id}/sla/report?days=${days}`),
    enabled: Boolean(project.sla?.enabled),
  });
  if (!project.sla?.enabled || !data?.enabled) return null;
  const cell = (c, hours) => {
    if (!hours) return <span className="text-fg-subtle">No target</span>;
    const decided = c.met + c.missed;
    return (
      <span className="tabular-nums">
        {decided ? <b className="font-semibold">{Math.round((c.met / decided) * 100)}% met</b> : <span className="text-fg-subtle">None finished</span>}
        <span className="block text-micro text-fg-subtle">{c.met} met, {c.missed} missed{c.breached ? `, ${c.breached} late now` : ''}{c.at_risk ? `, ${c.at_risk} due soon` : ''}</span>
      </span>
    );
  };
  // One met-rate meter per target, in the priority's own colour beside its signal-bar mark and name
  // (priority is never told by colour alone). A target with nothing decided yet draws no bar.
  const meter = (priority, c, hours, what) => {
    if (!hours) return <span className="text-caption text-fg-faint">No {what.toLowerCase()} target</span>;
    const decided = c.met + c.missed;
    const pct = decided ? Math.round((c.met / decided) * 100) : null;
    return (
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2 text-caption">
          <span className="truncate text-fg-subtle">{what} · {hoursText(hours)}</span>
          {pct === null ? <span className="text-fg-subtle">None finished</span> : <span className="font-medium tabular-nums text-fg">{pct}% met</span>}
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-press" role="img" aria-label={pct === null ? `${what}: nothing finished yet` : `${what}: ${pct}% met, ${c.met} of ${decided}`}>
          {pct !== null && <div className="ds-meter h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: priorityOf(priority).color }} />}
        </div>
        {(c.breached > 0 || c.at_risk > 0) && (
          <p className="mt-1 text-micro tabular-nums text-fg-subtle">{[c.breached && `${c.breached} late now`, c.at_risk && `${c.at_risk} due soon`].filter(Boolean).join(', ')}</p>
        )}
      </div>
    );
  };
  return (
    <ChartCard
      title="Service levels"
      subtitle={`Tickets created in the last ${days} days, against this project's targets. “Late now” means open and past the target.`}
      table={(
        <table className="w-full text-left text-small">
          <thead><tr className="text-caption text-fg-subtle"><th className="py-1.5 pr-4 font-medium">Priority</th><th className="py-1.5 pr-4 font-medium">Tickets</th><th className="py-1.5 pr-4 font-medium">First response</th><th className="py-1.5 font-medium">Resolution</th></tr></thead>
          <tbody className="divide-y divide-line">
            {data.rows.map((r) => (
              <tr key={r.priority}>
                <td className="py-2 pr-4"><PriorityMark priority={r.priority} withLabel /></td>
                <td className="py-2 pr-4 tabular-nums">{r.tickets}</td>
                <td className="py-2 pr-4">{cell(r.response, r.responseHours)}{r.responseHours && <span className="block text-micro text-fg-subtle">target {hoursText(r.responseHours)}</span>}</td>
                <td className="py-2">{cell(r.resolve, r.resolveHours)}{r.resolveHours && <span className="block text-micro text-fg-subtle">target {hoursText(r.resolveHours)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    >
      <ul className="divide-y divide-line">
        {data.rows.map((r) => (
          <li key={r.priority} className="grid gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
            <div className="flex items-center gap-2">
              <PriorityMark priority={r.priority} withLabel />
              <span className="text-caption tabular-nums text-fg-subtle">{r.tickets} ticket{r.tickets === 1 ? '' : 's'}</span>
            </div>
            {meter(r.priority, r.response, r.responseHours, 'First response')}
            {meter(r.priority, r.resolve, r.resolveHours, 'Resolution')}
          </li>
        ))}
      </ul>
      {data.breached.length > 0 && (
        <>
          <h3 className="mb-1.5 mt-4 text-caption font-semibold text-danger">Open and past a target now</h3>
          <ul className="space-y-1 text-small">
            {data.breached.map((b) => (
              <li key={b.key} className="flex flex-wrap items-center gap-2">
                <KeyLink to={`/projects/${project.id}/tickets/${b.key}`}>{b.key}</KeyLink>
                <span className="min-w-0 flex-1 truncate">{b.title}</span>
                <span className="text-caption text-fg-subtle">{b.kinds.map((k) => `${SLA_LABEL[k.kind]} late by ${spanText(Date.now() - new Date(k.dueAt))}`).join(', ')}{b.assignee ? ` · ${b.assignee.name}` : ' · unassigned'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}

// ---- Audit log

export function AuditLogLink({ project }) {
  const navigate = useNavigate();
  return (
    <Section title="Audit log" description="Who changed this project's setup, and when: members, invites, columns, fields, templates, rules, service levels, sprints, integrations, bulk edits, imports and exports. Kept for a year.">
      <Button onClick={() => navigate(`/projects/${project.id}/settings/audit`)}><History className="size-4" />Open the audit log</Button>
    </Section>
  );
}

const ROLE = { admin: 'an admin', manager: 'a manager', developer: 'a developer', viewer: 'a viewer' };
const quote = (s) => (s ? `“${s}”` : 'one that was since removed');

// One audit entry as a sentence (after the person's name).
export function auditSentence(e) {
  const d = e.details ?? {};
  const t = e.target;
  switch (e.action) {
    case 'project.updated': {
      if (d.name) return `renamed the project to ${quote(d.name)}${d.key ? ` and set its key to ${d.key}` : ''}`;
      if (d.key) return `changed the project key to ${d.key} (every ticket was renamed)`;
      return `changed the project's ${Object.keys(d).join(' and ') || 'details'}`;
    }
    case 'project.created': return `created the project${d.template ? ` from the ${{ kanban: 'Software Kanban', scrum: 'Scrum', bugs: 'Bug tracking', support: 'Support desk', content: 'Content calendar' }[d.template] ?? d.template} template` : ''}`;
    case 'ingest_key.created': return `made the crash capture key "${t ?? ''}"${d.origins?.length ? ` for ${d.origins.join(', ')}` : ''}`;
    case 'ingest_key.revoked': return `revoked the crash capture key "${t ?? ''}"`;
    case 'sourcemaps.uploaded': return `uploaded source maps for ${t ?? 'a release'}${d.files?.length ? ` (${d.files.join(', ')})` : ''}`;
    case 'sourcemaps.deleted': return `deleted the source maps of ${t ?? 'a release'}`;
    case 'deploy.recorded': return `recorded a deploy of ${t ?? 'a release'}${d.shipped ? ` (shipped ${d.shipped} ticket${d.shipped === 1 ? '' : 's'})` : ''}`;
    case 'deploys.settings': return 'changed the deploy settings';
    case 'source.changed': return d.repo ? `linked stack traces to ${d.repo} (${d.branch ?? 'main'})` : 'turned off source links';
    case 'labels.changed': return d.labels?.length ? `set the team's labels to ${d.labels.join(', ')}` : "cleared the team's labels";
    case 'card_layout.changed': return 'changed what board cards show';
    case 'checklist.dismissed': return 'hid the setup checklist';
    case 'checklist.restored': return 'brought the setup checklist back';
    case 'project.archived': return 'archived the project';
    case 'project.unarchived': return 'brought the project back from the archive';
    case 'member.role_changed': return `made ${t ?? 'a former member'} ${ROLE[d.role] ?? d.role}`;
    case 'member.removed': return `removed ${t ?? 'a former member'} from the project${d.unassignedTickets ? ` (${plural(d.unassignedTickets, 'ticket')} unassigned)` : ''}`;
    case 'member.left': return `left the project${d.unassignedTickets ? ` (${plural(d.unassignedTickets, 'ticket')} unassigned)` : ''}`;
    case 'member.joined': return 'joined the project through an invite';
    case 'invite.sent': return `invited ${t} as ${ROLE[d.role] ?? d.role}`;
    case 'invite.revoked': return `cancelled the invite for ${t ?? 'someone'}`;
    case 'columns.changed': return `changed the columns to ${(d.columns ?? []).join(', ')}`;
    case 'fields.changed': return d.fields?.length ? `changed the custom fields to ${d.fields.join(', ')}` : 'removed all custom fields';
    case 'template.created': return `created the template ${quote(t)}`;
    case 'template.updated': return `edited the template ${quote(t)}`;
    case 'template.deleted': return `deleted the template ${quote(t)}`;
    case 'recurring.created': return `set up a recurring ticket from ${quote(t)}`;
    case 'recurring.updated': return d.active === false ? `paused the recurring ticket ${quote(t)}` : d.active === true ? `resumed the recurring ticket ${quote(t)}` : `edited the recurring ticket ${quote(t)}`;
    case 'recurring.deleted': return `deleted the recurring ticket ${quote(t)}`;
    case 'recurring.run': return `ran the recurring ticket ${quote(t)} now${d.ticket ? `, creating ${d.ticket}` : ''}`;
    case 'rule.created': return `created the rule ${quote(t)}${d.enabled === false ? ' (off)' : ''}`;
    case 'rule.updated': return d.enabled === true ? `turned on the rule ${quote(t)}` : d.enabled === false ? `turned off the rule ${quote(t)}` : `edited the rule ${quote(t)}`;
    case 'rule.deleted': return `deleted the rule ${quote(t)}`;
    case 'rule.reordered': return `reordered the rules: ${(d.order ?? []).join(', ')}`;
    case 'sla.changed':
      if (!d.enabled) return 'turned service levels off';
      return `set service levels: ${(d.targets ?? []).map((x) => `${priorityOf(x.priority).label} ${[x.responseHours && `response ${x.responseHours} h`, x.resolveHours && `resolved ${x.resolveHours} h`].filter(Boolean).join(', ')}`).join('; ')}`;
    case 'sprint.created': return `created the sprint ${quote(t)}`;
    case 'sprint.updated': return `edited the sprint ${quote(t)}`;
    case 'sprint.deleted': return `deleted the sprint ${quote(t)}`;
    case 'sprint.started': return `started the sprint ${quote(t)}`;
    case 'sprint.completed': return `completed the sprint ${quote(t)}${d.carryTo === 'backlog' ? ', unfinished work back to the backlog' : d.carryTo === 'new' ? ', unfinished work into a new sprint' : ''}`;
    case 'milestone.created': return `created the milestone ${quote(t)}`;
    case 'milestone.updated': return `edited the milestone ${quote(t)}`;
    case 'milestone.deleted': return `deleted the milestone ${quote(t)}`;
    case 'portal.updated': return d.enabled === true ? 'turned the public bug page on' : d.enabled === false ? 'turned the public bug page off' : 'edited the public bug page';
    case 'portal.link_rotated': return 'made a new public bug page link (the old one stopped working)';
    case 'github.connected': return 'connected GitHub';
    case 'github.disconnected': return 'disconnected GitHub';
    case 'tickets.bulk_changed': {
      const what = d.action === 'delete' ? 'deleted' : d.action === 'restore' ? 'restored' : `changed ${(d.changes ?? []).join(', ') || 'details'} on`;
      return `${what} ${plural(d.done ?? 0, 'ticket')} at once${d.failed ? ` (${d.failed} could not be changed)` : ''}`;
    }
    case 'tickets.imported': return `imported ${plural(d.created ?? 0, 'ticket')}${t ? ` from ${t}` : ''}${d.skipped ? `, skipping ${plural(d.skipped, 'invalid row')}` : ''}`;
    case 'tickets.exported': return `exported ${plural(d.count ?? 0, 'ticket')} to CSV`;
    default: return e.action;
  }
}
