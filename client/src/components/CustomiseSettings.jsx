import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Pause, Pencil, Play, Plus, Repeat, Trash2, Zap } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { PRIORITIES, TYPES } from '../lib/format.js';
import { shortDay, todayKey } from '../lib/days.js';

const FULL_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
import { Badge, Button, ConfirmDialog, Field, Modal } from './ui.jsx';
import { SettingsSection as Section } from './SettingsSection.jsx';
import { EmptyNote, FieldSelect } from '../ds/core.jsx';

// Settings for E4B: custom fields, ticket templates and recurring tickets (managers).


export const FIELD_TYPE_LABEL = { text: 'Text', number: 'Number', select: 'Dropdown', date: 'Date', checkbox: 'Yes / no', url: 'Link' };

export function CustomFields({ project, refresh }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const reset = () => setRows((project.customFields ?? []).map((f) => ({ ...f, optionsText: f.options.join(', ') })));
  useEffect(reset, [project.customFields]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i, k, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const save = async () => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/fields`, {
        method: 'PUT',
        body: {
          fields: rows.map((f) => ({
            ...(f.key && { key: f.key }),
            name: f.name.trim(),
            type: f.type,
            options: f.type === 'select' ? f.optionsText.split(',').map((o) => o.trim()).filter(Boolean) : [],
          })),
        },
      });
      toast.success('Custom fields saved');
      refresh();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const removed = (project.customFields ?? []).filter((f) => !rows.some((r) => r.key === f.key));
  return (
    <Section title="Custom fields" description="Extra fields on every ticket, such as Customer or Environment. They show in the ticket's details and in CSV export and import. A field's type can't change once saved.">
      {rows.length === 0 && <EmptyNote className="mb-3">No custom fields yet.</EmptyNote>}
      <ul className="space-y-2">
        {rows.map((f, i) => (
          <li key={f.key ?? `new-${i}`} className="flex flex-wrap items-center gap-2">
            <input className="input h-8 min-w-0 flex-1 text-small" value={f.name} onChange={(e) => set(i, 'name', e.target.value)} maxLength={40} placeholder="Field name" aria-label="Field name" />
            <select className="input h-8 w-32 text-caption" value={f.type} disabled={Boolean(f.key)} onChange={(e) => set(i, 'type', e.target.value)} aria-label="Field type">
              {Object.entries(FIELD_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {f.type === 'select' && (
              <input className="input h-8 w-full text-caption sm:w-64" value={f.optionsText} onChange={(e) => set(i, 'optionsText', e.target.value)} placeholder="Options, separated by commas" aria-label="Dropdown options" />
            )}
            <Button size="icon" variant="ghost" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label={`Remove ${f.name || 'field'}`}><Trash2 className="size-4" /></Button>
          </li>
        ))}
      </ul>
      {removed.length > 0 && (
        <p className="mt-2 text-caption text-warning">Saving removes {removed.map((f) => `"${f.name}"`).join(', ')} and clears its values on every ticket.</p>
      )}
      <div className="mt-3 flex justify-between">
        <Button size="sm" disabled={rows.length >= 20} onClick={() => setRows((r) => [...r, { name: '', type: 'text', optionsText: '' }])}><Plus className="size-3.5" />Add field</Button>
        <span className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={reset}>Undo changes</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={rows.some((f) => !f.name.trim()) || JSON.stringify(rows) === JSON.stringify((project.customFields ?? []).map((f) => ({ ...f, optionsText: f.options.join(', ') })))}>Save fields</Button>
        </span>
      </div>
    </Section>
  );
}

export const useTemplates = (projectId) => useQuery({
  queryKey: ['templates', projectId],
  queryFn: () => api(`/projects/${projectId}/templates`).then((d) => d.templates),
  enabled: Boolean(projectId),
});

const BLANK = { name: '', title: '', description: '', type: 'task', priority: 'medium', labels: '', storyPoints: '', subtasks: '' };

function TemplateDialog({ project, template, onClose, onSaved }) {
  const [form, setForm] = useState(template ? {
    ...template, labels: template.labels.join(', '), storyPoints: template.storyPoints ?? '', subtasks: template.subtasks.join('\n'),
  } : BLANK);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = {
      name: form.name.trim(),
      title: form.title.trim(),
      description: form.description,
      type: form.type,
      priority: form.priority,
      labels: form.labels.split(',').map((l) => l.trim()).filter(Boolean),
      storyPoints: form.storyPoints === '' ? null : Number(form.storyPoints),
      subtasks: form.subtasks.split('\n').map((l) => l.trim()).filter(Boolean),
    };
    try {
      await api(`/projects/${project.id}/templates${template ? `/${template.id}` : ''}`, { method: template ? 'PATCH' : 'POST', body });
      toast.success(template ? 'Template saved' : 'Template created');
      onSaved();
      onClose();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={template ? `Edit ${template.name}` : 'New template'} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="template-form" loading={busy}>{template ? 'Save' : 'Create template'}</Button></>}>
      <form id="template-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Template name"><input className="input" value={form.name} onChange={set('name')} maxLength={60} placeholder="New hire setup" required /></Field>
        <Field label="Ticket title"><input className="input" value={form.title} onChange={set('title')} maxLength={200} placeholder="Set up a new teammate" required /></Field>
        <Field label="Type"><FieldSelect className="input" value={form.type} onChange={set('type')}>{TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</FieldSelect></Field>
        <Field label="Priority"><FieldSelect className="input" value={form.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</FieldSelect></Field>
        <Field label="Labels (comma separated)"><input className="input" value={form.labels} onChange={set('labels')} /></Field>
        <Field label="Story points"><input className="input" type="number" min="0" max="100" step="0.5" value={form.storyPoints} onChange={set('storyPoints')} /></Field>
        <Field label="Description (Markdown)" className="sm:col-span-2"><textarea className="input min-h-28 font-code text-caption" value={form.description} onChange={set('description')} maxLength={20000} /></Field>
        <Field label="Sub-tasks (one per line)" hint="Created under every ticket made from this template" className="sm:col-span-2">
          <textarea className="input min-h-24 text-small" value={form.subtasks} onChange={set('subtasks')} placeholder={'Create accounts\nOrder laptop'} />
        </Field>
      </form>
    </Modal>
  );
}

export function Templates({ project }) {
  const qc = useQueryClient();
  const { data: templates } = useTemplates(project.id);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['templates', project.id] });
  return (
    <Section title="Ticket templates" description="Ready-made tickets for work that comes up again and again. Pick one in New ticket; its sub-tasks are created too. Recurring tickets use them.">
      {templates?.length === 0 && <EmptyNote className="mb-3">No templates yet.</EmptyNote>}
      <ul className="divide-y divide-line">
        {(templates ?? []).map((t) => (
          <li key={t.id} className="flex items-center gap-2 py-2 text-small">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{t.name}</span>
              <span className="block truncate text-caption text-fg-subtle">{t.title} · {t.type} · {t.priority}{t.subtasks.length ? ` · ${t.subtasks.length} sub-task${t.subtasks.length === 1 ? '' : 's'}` : ''}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}><Pencil className="size-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}><Trash2 className="size-3.5" /></Button>
          </li>
        ))}
      </ul>
      <Button size="sm" className="mt-3" onClick={() => setEditing('new')}><Plus className="size-3.5" />New template</Button>
      {editing && <TemplateDialog project={project} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmDialog
        open={Boolean(deleting)} title={`Delete ${deleting?.name}?`} onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api(`/projects/${project.id}/templates/${deleting.id}`, { method: 'DELETE' });
            toast.success('Template deleted');
            refresh();
            setDeleting(null);
          } catch (e) { toast.error(e.message); }
        }}
      >
        Tickets already made from it stay as they are.
      </ConfirmDialog>
    </Section>
  );
}

// "Every Monday", "Every 2 weeks on Monday", "Every month on day 31 (or the last day)".
export function scheduleText(s) {
  const weekday = FULL_WEEKDAYS[(new Date(`${s.anchor}T00:00:00Z`).getUTCDay() + 6) % 7];
  const dom = Number(s.anchor.slice(8));
  if (s.every === 'day') return s.interval === 1 ? 'Every day' : `Every ${s.interval} days`;
  if (s.every === 'week') return s.interval === 1 ? `Every ${weekday}` : `Every ${s.interval} weeks on ${weekday}`;
  return `${s.interval === 1 ? 'Every month' : `Every ${s.interval} months`} on day ${dom}${dom > 28 ? ' (or the last day)' : ''}`;
}

function RecurringDialog({ project, templates, onClose, onSaved }) {
  const [form, setForm] = useState({ templateId: templates[0]?.id ?? '', every: 'week', interval: 1, firstDay: todayKey(), assigneeId: '', dueInDays: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const workers = project.members.filter((m) => m.role !== 'viewer');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/projects/${project.id}/recurring`, {
        method: 'POST',
        body: {
          templateId: form.templateId,
          every: form.every,
          interval: Number(form.interval),
          firstDay: form.firstDay,
          assigneeId: form.assigneeId || null,
          dueInDays: form.dueInDays === '' ? null : Number(form.dueInDays),
        },
      });
      toast.success('Recurring ticket set up');
      onSaved();
      onClose();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New recurring ticket"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="recurring-form" loading={busy} disabled={!form.templateId}>Set up</Button></>}>
      <form id="recurring-form" onSubmit={submit} className="space-y-3">
        <Field label="From template">
          <FieldSelect className="input" value={form.templateId} onChange={set('templateId')} required>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</FieldSelect>
        </Field>
        <div className="grid grid-cols-[auto_1fr_1fr] items-end gap-2">
          <span className="pb-2 text-small text-fg-subtle">Every</span>
          <Field label="Number"><input className="input" type="number" min="1" max="12" value={form.interval} onChange={set('interval')} /></Field>
          <Field label="Unit"><FieldSelect className="input" value={form.every} onChange={set('every')}><option value="day">day(s)</option><option value="week">week(s)</option><option value="month">month(s)</option></FieldSelect></Field>
        </div>
        <Field label="First one on" hint={scheduleText({ every: form.every, interval: Number(form.interval) || 1, anchor: form.firstDay || todayKey() })}>
          <input className="input" type="date" value={form.firstDay} min={todayKey()} onChange={set('firstDay')} required />
        </Field>
        <Field label="Assign to">
          <FieldSelect className="input" value={form.assigneeId} onChange={set('assigneeId')}><option value="">Nobody</option>{workers.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}</FieldSelect>
        </Field>
        <Field label="Due (days after the day it is for)" hint="Leave empty for no due date">
          <input className="input" type="number" min="0" max="90" value={form.dueInDays} onChange={set('dueInDays')} />
        </Field>
      </form>
    </Modal>
  );
}

export function Recurring({ project }) {
  const qc = useQueryClient();
  const { data: templates } = useTemplates(project.id);
  const { data: rows } = useQuery({ queryKey: ['recurring', project.id], queryFn: () => api(`/projects/${project.id}/recurring`).then((d) => d.recurring) });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['recurring', project.id] });
  const act = async (path, method, body, done) => {
    try {
      const res = await api(`/projects/${project.id}/recurring/${path}`, { method, ...(body && { body }) });
      toast.success(typeof done === 'function' ? done(res) : done);
      refresh();
      qc.invalidateQueries({ queryKey: qk.tickets(project.id) });
      return true;
    } catch (e) { toast.error(e.message); return false; }
  };
  return (
    <Section title="Recurring tickets" description="A template turned into a ticket on a schedule, such as a weekly dependency update.">
      <p className="mb-3 rounded-tile bg-hover p-2.5 text-caption text-fg-muted  ">
        Tickets are created while the server is running. On the free hosting plan the server sleeps when nobody uses it, so a ticket can appear
        late, as soon as it wakes. If several runs fell due while it slept, one ticket is made for the latest and the others are counted as missed below.
      </p>
      {rows?.length === 0 && <EmptyNote className="mb-3">No recurring tickets yet.</EmptyNote>}
      <ul className="divide-y divide-line">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-small">
            <Repeat className="size-4 text-fg-subtle" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{r.template?.name ?? 'Deleted template'}</span>
              {!r.active && <Badge tone="amber" className="ml-2">Paused</Badge>}
              <span className="block text-caption text-fg-subtle">
                {scheduleText(r.schedule)}{r.assignee ? ` · to ${r.assignee.name}` : ''}{r.dueInDays !== null ? ` · due ${r.dueInDays} day${r.dueInDays === 1 ? '' : 's'} later` : ''}
                {r.active && ` · next ${shortDay(r.nextRun)}`}
              </span>
              {r.lastRun && (
                <span className="block text-caption text-fg-subtle">
                  Last: {project.key}-{r.lastRun.number} for {shortDay(r.lastRun.day)}{r.lastRun.missed ? ` (${r.lastRun.missed} earlier run${r.lastRun.missed === 1 ? ' was' : 's were'} missed while the server was asleep)` : ''}
                </span>
              )}
              {r.pausedReason && <span className="block text-caption text-warning">{r.pausedReason}</span>}
            </span>
            <Button size="sm" variant="ghost" onClick={() => act(`${r.id}/run`, 'POST', null, (res) => `Created ${res.ticket.key}`)} title="Create one now (the schedule stays the same)"><Zap className="size-3.5" />Create now</Button>
            <Button size="sm" variant="ghost" onClick={() => act(r.id, 'PATCH', { active: !r.active }, r.active ? 'Paused' : 'Resumed')}>
              {r.active ? <><Pause className="size-3.5" />Pause</> : <><Play className="size-3.5" />Resume</>}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} aria-label="Delete recurring ticket"><Trash2 className="size-3.5" /></Button>
          </li>
        ))}
      </ul>
      <Button size="sm" className="mt-3" disabled={!templates?.length} onClick={() => setAdding(true)}><Plus className="size-3.5" />New recurring ticket</Button>
      {templates?.length === 0 && <p className="mt-1 text-caption text-fg-subtle">Create a template first.</p>}
      {adding && <RecurringDialog project={project} templates={templates} onClose={() => setAdding(false)} onSaved={refresh} />}
      <ConfirmDialog
        open={Boolean(deleting)} title="Stop this recurring ticket?" confirmLabel="Delete" onCancel={() => setDeleting(null)}
        onConfirm={async () => { if (await act(deleting.id, 'DELETE', null, 'Recurring ticket deleted')) setDeleting(null); }}
      >
        No more tickets will be made from it. Tickets it already made stay.
      </ConfirmDialog>
    </Section>
  );
}
