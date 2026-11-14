import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, Circle, CircleCheck, CircleHelp, ListChecks, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { Badge, Button } from './ui.jsx';
// The board's parts (search help, what the search understood, the checklist) are on the design
// system already; the settings sections below move over with the settings screen.
import { Badge as DsBadge, Button as DsButton, IconButton, Mosaic } from '../ds/core.jsx';
import { SettingsSection as Section } from './SettingsSection.jsx';

// E4D: the search language help, the team's labels, card layouts, setup templates and the
// setup checklist.


// ---- Search language

const SEARCH_EXAMPLES = [
  ['type:bug', 'bugs (also feature, task, epic; type:bug,feature for either)'],
  ['assignee:me', 'assigned to you; assignee:none, assignee:asha (name or email)'],
  ['priority:>=high', 'high or critical; priority:low,medium'],
  ['status:"in review"', 'by column name or key; status:done for any done column'],
  ['label:payments', 'has the label; -label:wontfix for "not"'],
  ['due:<7d', 'due within 7 days; due:>2w, due:2026-11-30, due:overdue, due:today, due:none'],
  ['created:<30d', 'created in the last 30 days; created:>90d, updated:<1d'],
  ['is:open', 'also is:done, is:unassigned, is:blocked, is:overdue, is:watched, is:reproduced, is:unreproduced'],
  ['sprint:active', 'the running sprint; sprint:none, sprint:"Sprint 4"'],
  ['epic:KEY-12', 'tickets in that epic'],
  ['sla:breached', 'past a service-level target; sla:at_risk'],
];

export function SearchHelp() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span ref={ref} className="relative">
      <IconButton label="Search filters you can type" icon={CircleHelp} size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div role="dialog" aria-label="Search filters" className="ds-drop absolute left-0 top-full z-30 mt-2 w-[min(92vw,30rem)] rounded-card bg-overlay p-4 text-caption shadow-overlay">
          <p className="mb-3 text-fg-muted">Type filters into the search box, mixed with ordinary words. Everything you type must match.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            {SEARCH_EXAMPLES.map(([code, text]) => (
              <div key={code} className="contents">
                <dt><code className="rounded-hair border border-line bg-hover px-1 py-0.5 font-code text-fg">{code}</code></dt>
                <dd className="text-fg-subtle">{text}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-fg-subtle">Example: <code className="font-code text-fg">type:bug assignee:me due:&lt;7d checkout</code></p>
        </div>
      )}
    </span>
  );
}

// What the server understood from the search box, and anything it couldn't use.
export function SearchUnderstood({ search, className }) {
  if (!search?.understood && !search?.problems?.length) return null;
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5 text-caption', className)}>
      {search.understood?.length > 0 && <span className="text-fg-subtle">Showing tickets:</span>}
      {search.understood?.map((u) => <DsBadge key={u}>{u}</DsBadge>)}
      {search.problems?.map((p) => (
        <span key={p} className="inline-flex items-center gap-1 text-warning"><AlertTriangle className="size-3" aria-hidden />Ignored {p}</span>
      ))}
    </div>
  );
}

// ---- The team's labels

export function LabelsSettings({ project, refresh }) {
  const [text, setText] = useState((project.suggestedLabels ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  useEffect(() => setText((project.suggestedLabels ?? []).join(', ')), [project.suggestedLabels]);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/labels`, { method: 'PUT', body: { labels: text.split(',').map((l) => l.trim()).filter(Boolean) } });
      toast.success('Labels saved');
      refresh();
    } catch (e) { toast.error(e.details?.[0]?.message ?? e.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Labels" description="Your team's labels, offered when someone labels a ticket and in the label filter, even before any ticket uses them. Labels already on tickets stay as they are.">
      <textarea className="input min-h-16 text-small" value={text} onChange={(e) => setText(e.target.value)} placeholder="frontend, backend, billing" aria-label="Team labels, comma separated" />
      <div className="mt-2 flex justify-end"><Button variant="primary" loading={busy} disabled={text === (project.suggestedLabels ?? []).join(', ')} onClick={save}>Save labels</Button></div>
    </Section>
  );
}

// The team's labels a ticket doesn't have yet, one click to add (ticket drawer).
export function LabelSuggestions({ projectId, current, onAdd }) {
  const { data } = useQuery({ queryKey: ['labels', projectId], queryFn: () => api(`/projects/${projectId}/labels`).then((d) => d.labels) });
  const offer = (data ?? []).map((l) => l.label).filter((l) => !current.includes(l)).slice(0, 8);
  if (!offer.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" aria-label="Add a team label">
      {offer.map((l) => (
        <button key={l} type="button" onClick={() => onAdd(l)} className="rounded-tile border border-dashed border-line-strong px-1.5 py-0.5 text-micro text-fg-subtle hover:border-accent hover:text-accent  ">+ {l}</button>
      ))}
    </div>
  );
}

// ---- Card layout

export const CARD_PARTS = [
  ['key', 'Ticket key'], ['type', 'Type icon'], ['priority', 'Priority'], ['labels', 'Labels'], ['due', 'Due date'],
  ['assignee', 'Assignee'], ['points', 'Story points'], ['subtasks', 'Sub-task progress'], ['epic', 'Epic'],
  ['sla', 'SLA warning'], ['blocked', 'Blocked'], ['age', 'Ageing warning'], ['errors', 'Error repeats'], ['links', 'GitHub links'],
];

export function CardLayoutSettings({ project, refresh }) {
  const [fields, setFields] = useState(project.cardFields ?? []);
  const [busy, setBusy] = useState(false);
  useEffect(() => setFields(project.cardFields ?? []), [project.cardFields]);
  const toggle = (k) => setFields((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));
  const customOn = fields.filter((f) => f.startsWith('field:')).length;
  const save = async () => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/card-layout`, { method: 'PUT', body: { fields } });
      toast.success('Card layout saved');
      refresh();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const box = (k, label, disabled) => (
    <label key={k} className={clsx('flex items-center gap-2 text-small', disabled && 'opacity-50')}>
      <input type="checkbox" className="size-4 accent-accent" checked={fields.includes(k)} disabled={disabled} onChange={() => toggle(k)} />{label}
    </label>
  );
  return (
    <Section title="Board cards" description="What every card on the board shows, for everyone in the project. The title is always shown.">
      <div className="grid gap-1.5 sm:grid-cols-2">{CARD_PARTS.map(([k, l]) => box(k, l))}</div>
      {(project.customFields ?? []).length > 0 && (
        <>
          <p className="mb-1.5 mt-3 text-caption font-medium text-fg-subtle">Custom fields (up to 3)</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {project.customFields.map((f) => box(`field:${f.key}`, f.name, !fields.includes(`field:${f.key}`) && customOn >= 3))}
          </div>
        </>
      )}
      <div className="mt-3 flex justify-end"><Button variant="primary" loading={busy} disabled={JSON.stringify([...fields].sort()) === JSON.stringify([...(project.cardFields ?? [])].sort())} onClick={save}>Save card layout</Button></div>
    </Section>
  );
}

// ---- Setup templates (new project dialog)

const BLANK = { key: '', name: 'Blank', description: 'The three basic columns. Change them any time.', columns: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Done' }], labels: [] };

export function TemplatePicker({ value, onChange }) {
  const { data: templates } = useQuery({ queryKey: ['setup-templates'], queryFn: () => api('/projects/setup-templates').then((d) => d.templates), staleTime: Infinity });
  return (
    <div role="radiogroup" aria-label="Start from" className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
      {[BLANK, ...(templates ?? [])].map((t) => (
        <button key={t.key || 'blank'} type="button" role="radio" aria-checked={value === t.key} onClick={() => onChange(t.key)}
          className={clsx('rounded-tile border p-2.5 text-left', value === t.key ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong ')}>
          <span className="block text-small font-medium">{t.name}</span>
          <span className="block text-micro text-fg-subtle">{t.description}</span>
          <span className="mt-1 block text-micro text-fg-muted">{t.columns.map((c) => c.name).join(' → ')}</span>
          {t.labels.length > 0 && <span className="block text-micro text-fg-subtle">Labels: {t.labels.join(', ')}</span>}
        </button>
      ))}
    </div>
  );
}

// ---- Setup checklist (board, managers)

// One quiet line on the board (with a tile per step); the steps open on demand.
export function SetupChecklist({ project }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: loaded } = useQuery({ queryKey: ['setup', project.id], queryFn: () => api(`/projects/${project.id}/setup`) });
  // It sits above the board, so arriving late would push the whole board down (a layout shift).
  // While it loads it holds its space with an invisible copy of its collapsed bar, unless this
  // browser already knows it is hidden for this project.
  const memo = `tessera.setup.${project.id}`;
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(memo, loaded.dismissedAt ? 'hidden' : 'shown'); } catch { /* storage blocked */ }
  }, [loaded, memo]);
  let hiddenBefore = false;
  try { hiddenBefore = localStorage.getItem(memo) === 'hidden'; } catch { /* storage blocked */ }
  if (!loaded) {
    if (hiddenBefore) return null;
    return (
      <section aria-hidden className="invisible mx-4 mb-3 rounded-card border border-line sm:mx-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pl-3 pr-1.5">
          <ListChecks className="size-4 shrink-0" />
          <p className="min-w-0 flex-1 text-small"><span className="font-medium">Set up this project</span><span> · 0 of 1 done</span></p>
          <DsButton size="sm" variant="ghost" tabIndex={-1}>Show steps<ChevronDown className="size-3.5" /></DsButton>
          <IconButton label="Hide the setup checklist" icon={X} size="sm" tabIndex={-1} />
        </div>
      </section>
    );
  }
  const data = loaded;
  if (data.dismissedAt) return null;
  const dismiss = async () => {
    try {
      await api(`/projects/${project.id}/setup/dismiss`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['setup', project.id] });
      toast.success('Checklist hidden. You can bring it back from Settings.');
    } catch (e) { toast.error(e.message); }
  };
  const complete = data.done === data.total;
  const to = (s) => (s.to === 'settings' ? `/projects/${project.id}/settings` : `/projects/${project.id}`);
  const listId = `setup-steps-${project.id}`;
  return (
    <section className="mx-4 mb-3 rounded-card border border-line bg-surface sm:mx-6" aria-label="Setup checklist">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pl-3 pr-1.5">
        <ListChecks className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <p className="min-w-0 flex-1 text-small">
          <span className="font-medium text-fg">{complete ? 'All set up' : 'Set up this project'}</span>
          <span className="text-fg-subtle"> · {complete ? 'every step is done' : `${data.done} of ${data.total} done`}</span>
        </p>
        <Mosaic
          tiles={data.steps.map((s) => ({ status: s.done ? 'done' : 'todo', key: s.key }))}
          columns={data.total}
          size="sm"
          label={`${data.done} of ${data.total} setup steps done`}
          className="hidden sm:grid"
        />
        {!complete && (
          <DsButton size="sm" variant="ghost" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide steps' : 'Show steps'}
            <ChevronDown className={clsx('size-3.5 transition-transform duration-(--dur-fast)', open && 'rotate-180')} aria-hidden />
          </DsButton>
        )}
        <IconButton label="Hide the setup checklist" icon={X} size="sm" onClick={dismiss} />
      </div>
      {open && !complete && (
        <ol id={listId} className="grid gap-x-6 gap-y-2.5 border-t border-line px-4 py-3 sm:grid-cols-2">
          {data.steps.map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-small">
              {s.done
                ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-status-done" role="img" aria-label="Done" />
                : <Circle className="mt-0.5 size-4 shrink-0 text-fg-faint" role="img" aria-label="Not done yet" />}
              <span className="min-w-0">
                {s.done
                  ? <span className="text-fg-subtle">{s.title}</span>
                  : <Link to={to(s)} className="ds-focus rounded-hair font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">{s.title}</Link>}
                {!s.done && <span className="block text-caption text-fg-subtle">{s.hint}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// Settings: bring a hidden checklist back.
export function ChecklistSettings({ project }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['setup', project.id], queryFn: () => api(`/projects/${project.id}/setup`) });
  if (!data?.dismissedAt) return null;
  const restore = async () => {
    try {
      await api(`/projects/${project.id}/setup/dismiss`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['setup', project.id] });
      toast.success('The setup checklist is back on the board');
    } catch (e) { toast.error(e.message); }
  };
  return (
    <Section title="Setup checklist" description={`Hidden from the board. ${data.done} of ${data.total} steps are done.`}>
      <Button onClick={restore}><ListChecks className="size-4" />Show it on the board again</Button>
    </Section>
  );
}
