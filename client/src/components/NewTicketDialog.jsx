import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { AlertTriangle, ClipboardPaste, PenLine, Repeat, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { PRIORITIES, TYPES } from '../lib/format.js';
import { Badge, Button, Field, Modal, Spinner, TypeIcon } from './ui.jsx';
import AssigneeSelect, { OverloadNote } from './AssigneeSelect.jsx';
import ReportQuality from './ReportQuality.jsx';
import { useTemplates } from './CustomiseSettings.jsx';
import { FixMemory } from './ErrorInsights.jsx';
import { KeyChip, FieldSelect } from '../ds/core.jsx';

const EMPTY = { title: '', description: '', type: 'task', priority: 'medium', assigneeId: '', labels: '', dueDate: '', errorText: '', templateId: '', here: null };

// Debounced POST that only keeps the latest answer.
function useLive(path, body, enabled) {
  const [state, setState] = useState({ data: null, loading: false });
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!enabled) { setState({ data: null, loading: false }); return undefined; }
    const controller = new AbortController();
    const id = setTimeout(() => {
      setState((s) => ({ ...s, loading: true }));
      api(path, { method: 'POST', body: JSON.parse(key), signal: controller.signal })
        .then((data) => setState({ data, loading: false }))
        .catch((err) => { if (err.name !== 'AbortError') setState({ data: null, loading: false }); });
    }, 400);
    return () => { clearTimeout(id); controller.abort(); };
  }, [path, key, enabled]);
  return state;
}

export default function NewTicketDialog({ project, open, status, onClose, onCreated }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState('write');
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(EMPTY); setErrors({}); setMode('write'); } }, [open]);
  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const base = `/projects/${project.id}/tickets`;

  // "This looks like TES-12" while typing a title.
  const similar = useLive(`${base}/similar`, { title: form.title.trim() }, open && mode === 'write' && form.title.trim().length >= 4);
  // What a pasted error will become.
  const parsed = useLive(`${base}/parse-error`, { text: form.errorText, userAgent: navigator.userAgent }, open && mode === 'paste' && form.errorText.trim().length >= 8);
  const preview = parsed.data;
  // Whether the pasted error happened in this browser (so its browser/OS describe the crash).
  // Unless the person says otherwise: yes for browser JavaScript, no for server-side traces.
  const autoHere = preview?.error.language === 'javascript' && !preview.error.frames.some((f) => /^(node:|internal\/)/.test(f.file || ''));
  const here = form.here ?? autoHere;

  const workers = project.members.filter((m) => m.role !== 'viewer');
  const { data: templates } = useTemplates(open ? project.id : null);
  const template = templates?.find((t) => t.id === form.templateId);
  // Picking a template fills the form; everything stays editable.
  const applyTemplate = (id) => {
    const t = templates?.find((x) => x.id === id);
    setForm((f) => (t
      ? { ...f, templateId: id, title: t.title, description: t.description, type: t.type, priority: t.priority, labels: t.labels.join(', ') }
      : { ...f, templateId: '' }));
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    const labels = form.labels.split(',').map((l) => l.trim()).filter(Boolean);
    const common = {
      priority: form.priority,
      status: status ?? undefined,
      assigneeId: form.assigneeId || undefined,
      labels,
      ...(form.dueDate && { dueDate: form.dueDate }),
    };
    const body = mode === 'paste'
      ? { ...common, errorText: form.errorText, ...(here && { userAgent: navigator.userAgent }), ...(form.title.trim() && { title: form.title.trim() }) }
      : { ...common, title: form.title, description: form.description, type: form.type, ...(form.templateId && { templateId: form.templateId }) };
    try {
      const res = await api(base, { method: 'POST', body });
      qc.invalidateQueries({ queryKey: qk.tickets(project.id) });
      qc.invalidateQueries({ queryKey: qk.workload(project.id) });
      if (res.grouped) {
        toast(res.regression
          ? `${res.ticket.key} had been fixed, but this error came back, so it was reopened.`
          : `This error is already ${res.ticket.key}. It has now been reported ${res.ticket.error.occurrences} times.`, { icon: <Repeat className="size-4 shrink-0 text-warning" aria-hidden />, duration: 6000 });
      } else {
        toast.success(res.subtasks ? `Created ${res.ticket.key} with ${res.subtasks} sub-task${res.subtasks === 1 ? '' : 's'}` : `Created ${res.ticket.key}`);
      }
      onClose();
      onCreated?.(res.ticket);
    } catch (err) {
      const fields = err.fieldErrors();
      setErrors(Object.keys(fields).length ? fields : { form: err.message });
    } finally {
      setBusy(false);
    }
  };

  const tab = (key, Icon, label) => (
    <button
      type="button"
      onClick={() => setMode(key)}
      className={clsx('flex flex-1 items-center justify-center gap-2 rounded-tile py-1.5 text-small font-medium transition',
        mode === key ? 'bg-raised text-fg shadow-raised ' : 'text-fg-subtle hover:text-fg')}
    >
      <Icon className="size-4" />{label}
    </button>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`New ticket${status ? ` in ${project.statuses.find((s) => s.key === status)?.name}` : ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{mode === 'paste' ? 'Create bug from error' : 'Create ticket'}</Button></>}
    >
      <div className="mb-4 flex gap-1 rounded-tile bg-hover p-1 ">
        {tab('write', PenLine, 'Write it')}
        {tab('paste', ClipboardPaste, 'Paste an error')}
      </div>

      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {mode === 'paste' ? (
          <>
            <Field label="Error or stack trace" error={errors.errorText} hint="JavaScript, Python, Java, .NET, Go, PHP, Ruby and Rust traces are understood. A single error line works too.">
              <textarea className="input font-code text-caption" rows={8} value={form.errorText} onChange={set('errorText')} placeholder={"TypeError: Cannot read properties of undefined (reading 'total')\n    at checkout (app.js:120:31)"} autoFocus />
            </Field>
            {parsed.loading && <div className="flex items-center gap-2 text-caption text-fg-subtle"><Spinner />Reading the error…</div>}
            {preview && (
              <div className="rounded-tile border border-line bg-hover p-3 text-small  ">
                <div className="flex flex-wrap items-center gap-2">
                  <TypeIcon type="bug" />
                  <span className="font-medium">{preview.suggested.title}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone="brand">{preview.error.language === 'unknown' ? 'Plain error' : preview.error.language}</Badge>
                  {preview.error.frames.length > 0 && <Badge>{preview.error.frames.length} frames · {preview.error.frames.filter((f) => f.inApp).length} in your code</Badge>}
                  {here && preview.error.environment && <Badge tone="teal">{[preview.error.environment.browser, preview.error.environment.os].filter(Boolean).join(' on ')}</Badge>}
                </div>
                {preview.error.environment && (
                  <label className="mt-2 flex items-center gap-2 text-caption text-fg-muted">
                    <input type="checkbox" checked={here} onChange={(e) => setForm((f) => ({ ...f, here: e.target.checked }))} />
                    It happened in this browser ({[preview.error.environment.browser, preview.error.environment.os].filter(Boolean).join(' on ')})
                  </label>
                )}
                {preview.seenBefore && (
                  <p className="mt-3 flex items-start gap-2 rounded-tile bg-warning/10 px-2.5 py-2 text-caption text-warning  ">
                    <Repeat className="mt-0.5 size-3.5 shrink-0" />
                    Seen before as <KeyChip>{preview.seenBefore.key}</KeyChip> ({preview.seenBefore.occurrences}×). Creating will add this report to it instead of a duplicate.
                    {preview.seenBefore.muted && ' It is muted, so it will be counted without reopening it or notifying anyone.'}
                  </p>
                )}
                {preview.fixedBefore?.length > 0 && (
                  <div className="mt-3 rounded-tile bg-surface px-2.5 py-2">
                    <p className="mb-1 text-caption font-medium">How similar crashes were fixed</p>
                    <FixMemory related={preview.fixedBefore} pid={project.id} />
                  </div>
                )}
                {preview.redacted?.length > 0 && (
                  <p className="mt-3 flex items-start gap-2 rounded-tile bg-success/10 px-2.5 py-2 text-caption text-fg  ">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Removed before saving: {preview.redacted.map((r) => `${r.count} ${r.kind}${r.count > 1 ? 's' : ''}`).join(', ')}.
                      They are replaced with <code className="font-code">[redacted]</code> and never stored.
                    </span>
                  </p>
                )}
              </div>
            )}
            <Field label="Title" hint="Leave empty to use the error itself." error={errors.title}>
              <input className="input" value={form.title} onChange={set('title')} placeholder={preview?.suggested.title ?? ''} maxLength={200} />
            </Field>
          </>
        ) : (
          <>
            {templates?.length > 0 && (
              <Field label="Start from a template" hint={template ? `${template.subtasks.length ? `Also creates ${template.subtasks.length} sub-task${template.subtasks.length === 1 ? '' : 's'}` : 'No sub-tasks'}${template.storyPoints !== null ? `, ${template.storyPoints} story points` : ''}.` : undefined}>
                <select className="input" value={form.templateId} onChange={(e) => applyTemplate(e.target.value)} aria-label="Template">
                  <option value="">No template</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Title" error={errors.title}>
              <input className="input" value={form.title} onChange={set('title')} placeholder="What needs doing?" maxLength={200} autoFocus />
            </Field>
            {similar.data?.similar?.length > 0 && (
              <div className="rounded-tile border border-warning/30 bg-warning/10 p-3  ">
                <p className="flex items-center gap-1.5 text-caption font-medium text-warning"><AlertTriangle className="size-3.5" />This might already exist</p>
                <ul className="mt-2 space-y-1.5">
                  {similar.data.similar.slice(0, 3).map((s) => (
                    <li key={s.key} className="flex items-center gap-2 text-small">
                      <TypeIcon type={s.type} />
                      <KeyChip>{s.key}</KeyChip>
                      <span className="truncate">{s.title}</span>
                      <span className="ml-auto shrink-0 text-micro text-fg-subtle" title={`Shared words: ${s.because.join(', ')}`}>{Math.round(s.score * 100)}% match</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Field label="Description" hint="Markdown works: **bold**, `code`, lists, links." error={errors.description}>
              <textarea className="input" rows={5} value={form.description} onChange={set('description')} placeholder="Steps, expected vs actual, links…" />
              {form.type === 'bug' && <ReportQuality text={form.description} onInsert={(add) => setForm((f) => ({ ...f, description: f.description.trimEnd() + add }))} />}
            </Field>
            <Field label="Type">
              <div className="flex gap-2">
                {TYPES.map((t) => (
                  <button key={t.key} type="button" onClick={() => setForm((f) => ({ ...f, type: t.key }))}
                    className={clsx('btn btn-secondary flex-1', form.type === t.key && '!border-key-line !bg-key-bg')}>
                    <TypeIcon type={t.key} />{t.label}
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority">
            <FieldSelect className="input" value={form.priority} onChange={set('priority')}>
              {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </FieldSelect>
          </Field>
          <Field label="Assignee" error={errors.assigneeId}>
            <AssigneeSelect className="input" projectId={project.id} workers={workers} value={form.assigneeId}
              onChange={(v) => setForm((f) => ({ ...f, assigneeId: v }))} />
            <OverloadNote projectId={project.id} workers={workers} assigneeId={form.assigneeId}
              onPick={(v) => setForm((f) => ({ ...f, assigneeId: v }))} />
          </Field>
          <Field label="Labels" hint="Comma separated" error={errors.labels}>
            <input className="input" value={form.labels} onChange={set('labels')} placeholder="checkout, ios" />
          </Field>
          <Field label="Due date" error={errors.dueDate}>
            <input type="date" className="input" value={form.dueDate} onChange={set('dueDate')} />
          </Field>
        </div>
        {errors.form && <p className="rounded-tile bg-danger/10 px-3 py-2 text-small text-danger  " role="alert">{errors.form}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
