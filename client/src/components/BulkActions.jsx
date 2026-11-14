import { useState } from 'react';
import { Link } from 'react-router';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, Download, FileUp, RotateCcw, Trash2, X } from 'lucide-react';
import { api, apiBlob } from '../lib/api.js';
import { PRIORITIES, TYPES } from '../lib/format.js';
import { useSprints } from '../lib/queries.js';
import { todayKey } from '../lib/days.js';
import { Button, ConfirmDialog, Modal, Spinner } from './ui.jsx';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Updated 5 tickets" plus, when some refused, which ones and why.
function report(result, verb) {
  if (result.done) toast.success(`${verb} ${plural(result.done, 'ticket')}`);
  if (result.failed.length) {
    const lines = result.failed.slice(0, 4).map((f) => `${f.key}: ${f.message}`);
    if (result.failed.length > 4) lines.push(`…and ${result.failed.length - 4} more`);
    toast.error(`${plural(result.failed.length, 'ticket')} not changed\n${lines.join('\n')}`, { duration: 8000 });
  }
}

// A <select> that applies its choice at once and goes back to its label.
function Pick({ label, busy, onPick, children }) {
  return (
    <select className="input h-8 w-auto text-caption" value="" disabled={busy} aria-label={label} onChange={(e) => e.target.value && onPick(e.target.value)}>
      <option value="">{label}</option>
      {children}
    </select>
  );
}

// The bar under the list while tickets are ticked: change status, priority, type, assignee,
// labels, sprint or due date for all of them, or delete / restore them.
export function BulkBar({ project, selected, bin, labels, onDone, onClear }) {
  const pid = project.id;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: sprintData } = useSprints(pid);
  const openSprints = (sprintData?.sprints ?? []).filter((s) => s.state !== 'closed');
  const workers = project.members.filter((m) => m.role !== 'viewer');

  const run = async (body, verb) => {
    setBusy(true);
    try {
      const result = await api(`/projects/${pid}/tickets/bulk`, { method: 'POST', body: { tickets: [...selected], ...body } });
      report(result, verb);
      onDone(result, body.action ?? 'update');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const change = (changes) => run({ changes }, 'Updated');

  return (
    <div className="sticky bottom-0 z-20 border-t border-line bg-overlay/95 px-4 py-2.5 backdrop-blur sm:px-6  " role="region" aria-label="Bulk actions">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small font-semibold">{plural(selected.size, 'ticket')} selected</span>
        {busy && <Spinner className="text-fg-subtle" />}
        {bin ? (
          <Button size="sm" disabled={busy} onClick={() => run({ action: 'restore' }, 'Restored')}><RotateCcw className="size-3.5" />Restore</Button>
        ) : (
          <>
            <Pick label="Status…" busy={busy} onPick={(status) => change({ status })}>{project.statuses.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</Pick>
            <Pick label="Priority…" busy={busy} onPick={(priority) => change({ priority })}>{PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Pick>
            <Pick label="Type…" busy={busy} onPick={(type) => change({ type })}>{TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Pick>
            <Pick label="Assignee…" busy={busy} onPick={(v) => change({ assigneeId: v === 'none' ? null : v })}>
              <option value="none">Unassigned</option>
              {workers.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
            </Pick>
            {openSprints.length > 0 && (
              <Pick label="Sprint…" busy={busy} onPick={(v) => change({ sprint: v === 'none' ? null : v })}>
                <option value="none">Backlog (no sprint)</option>
                {openSprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Pick>
            )}
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get('label')?.toString().trim().toLowerCase();
                if (v) { change({ addLabels: [v] }); e.currentTarget.reset(); }
              }}
            >
              <input name="label" className="input h-8 w-28 text-caption" placeholder="Add label ↵" maxLength={30} list="bulk-labels" aria-label="Add a label" disabled={busy} />
              <datalist id="bulk-labels">{(labels ?? []).map((l) => <option key={l.label} value={l.label} />)}</datalist>
            </form>
            {labels?.length > 0 && (
              <Pick label="Remove label…" busy={busy} onPick={(v) => change({ removeLabels: [v] })}>{labels.map((l) => <option key={l.label} value={l.label}>{l.label}</option>)}</Pick>
            )}
            <label className="flex items-center gap-1 text-caption text-fg-subtle">
              Due
              <input type="date" className="input h-8 w-auto text-caption" value="" disabled={busy} aria-label="Set due date" onChange={(e) => e.target.value && change({ dueDate: e.target.value })} />
            </label>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change({ dueDate: null })}>Clear due</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 className="size-3.5" />Delete</Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}><X className="size-3.5" />Clear selection</Button>
      </div>
      <ConfirmDialog
        open={confirmDelete} title={`Delete ${plural(selected.size, 'ticket')}?`} busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => { await run({ action: 'delete' }, 'Moved to the bin:'); setConfirmDelete(false); }}
      >
        They go to the bin, where they can be restored.
      </ConfirmDialog>
    </div>
  );
}

// Downloads the list, with its current filters (all pages), as a CSV file.
export function ExportButton({ project, query }) {
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams(Object.entries(query).filter(([k]) => !['page', 'limit'].includes(k)));
      saveFile(await apiBlob(`/projects/${project.id}/tickets/export?${params}`), `${project.key}-tickets-${todayKey()}.csv`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" onClick={exportCsv} loading={busy} title="Download these tickets (every page) as a CSV file"><Download className="size-3.5" />Export CSV</Button>;
}

const TEMPLATE = 'Title,Type,Status,Priority,Assignee email,Labels,Story points,Start date,Due date,Epic,Sprint,Milestone,Description\r\n';

// Import from CSV: choose a file, see every row checked (nothing is saved yet), then import.
export function ImportDialog({ project, open, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setFile(null); setPreview(null); setResult(null); onClose(); };
  const send = (f, query) => {
    const form = new FormData();
    form.append('file', f);
    return api(`/projects/${project.id}/tickets/import?${query}`, { method: 'POST', form });
  };
  const check = async (f) => {
    setFile(f);
    setPreview(null);
    setBusy(true);
    try { setPreview((await send(f, 'dryRun=true')).preview); } catch (e) { toast.error(e.message); setFile(null); } finally { setBusy(false); }
  };
  const runImport = async () => {
    setBusy(true);
    try {
      const r = await send(file, `skipInvalid=${preview.invalid > 0}`);
      setResult(r);
      onImported(r);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const footer = result ? <Button variant="primary" onClick={close}>Done</Button> : (
    <>
      <Button onClick={close}>Cancel</Button>
      {preview && (
        <Button variant="primary" loading={busy} disabled={!preview.valid} onClick={runImport}>
          {preview.invalid ? `Import ${preview.valid}, skip ${preview.invalid}` : `Import ${plural(preview.valid, 'ticket')}`}
        </Button>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={close} title="Import tickets from CSV" wide footer={footer}>
      {result ? (
        <div className="space-y-3 text-small">
          <p className="flex items-center gap-2 font-medium text-success"><CheckCircle2 className="size-4" />{plural(result.created.length, 'ticket')} imported{result.skipped ? `, ${result.skipped} skipped` : ''}.</p>
          {result.created.length > 0 && (
            <p className="text-fg-muted">
              {result.created[0].key}{result.created.length > 1 ? ` to ${result.created.at(-1).key}` : ''}.{' '}
              <Link to={`/projects/${project.id}/list?sort=newest`} onClick={close} className="font-medium text-accent hover:underline ">See them in the list</Link>
            </p>
          )}
          {result.failed.length > 0 && (
            <div className="rounded-tile bg-danger/10 p-3 text-danger">
              <p className="font-medium">{plural(result.failed.length, 'row')} could not be created:</p>
              <ul className="mt-1 list-disc pl-5">{result.failed.map((f) => <li key={f.line}>Line {f.line} ({f.title}): {f.message}</li>)}</ul>
            </div>
          )}
          <p className="text-caption text-fg-subtle">Imported tickets don't send a notification each. Their history says they came from an import.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="btn btn-secondary btn-sm cursor-pointer">
              <FileUp className="size-3.5" />{file ? 'Choose another file' : 'Choose a CSV file'}
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) check(f); }} />
            </label>
            {file && <span className="truncate text-small text-fg-muted">{file.name}</span>}
            {busy && <Spinner className="text-fg-subtle" />}
            <button type="button" onClick={() => saveFile(new Blob([`﻿${TEMPLATE}`], { type: 'text/csv' }), 'tessera-import-template.csv')}
              className="ml-auto text-caption font-medium text-accent hover:underline ">
              Download an empty template
            </button>
          </div>
          {!preview && (
            <div className="space-y-1 text-caption text-fg-subtle">
              <p>A header row, then one ticket per row: up to 500 rows and 1 MB. Only <b>Title</b> is required.</p>
              <p>Also read: Type, Status (column name), Priority, Assignee (email or name of a member), Labels (comma or semicolon separated), Story points, Start date and Due date (2026-11-30 or 30/11/2026), Epic (key or title), Sprint, Milestone, Description. A file exported from Tessera imports as it is.</p>
            </div>
          )}
          {preview && (
            <>
              <p className="text-small">
                <b>{preview.valid}</b> ready{preview.invalid > 0 && <>, <b className="text-danger">{preview.invalid}</b> with problems (skipped)</>}. Nothing is saved until you import.
              </p>
              <p className="text-caption text-fg-subtle">
                Reading: {preview.columns.used.join(', ')}.
                {preview.columns.ignored.length > 0 && <> Ignoring: {preview.columns.ignored.join(', ')}.</>}
              </p>
              <div className="scroll-thin max-h-80 overflow-auto rounded-tile border border-line">
                <table className="w-full text-left text-caption">
                  <thead className="sticky top-0 bg-hover text-fg-subtle ">
                    <tr><th className="px-2 py-1.5">Line</th><th className="px-2">Title</th><th className="px-2">Type</th><th className="px-2">Column</th><th className="px-2">Assignee</th><th className="px-2">Due</th><th className="px-2">Problems</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.line} className={r.errors.length ? 'bg-danger/8' : 'border-t border-line'}>
                        <td className="px-2 py-1 tabular-nums text-fg-subtle">{r.line}</td>
                        <td className="max-w-48 truncate px-2">{r.title || <i className="text-fg-subtle">empty</i>}</td>
                        <td className="px-2">{r.type}</td>
                        <td className="px-2">{project.statuses.find((s) => s.key === r.status)?.name ?? 'First column'}</td>
                        <td className="max-w-32 truncate px-2">{r.assignee?.name ?? ''}</td>
                        <td className="px-2">{r.dueDate ?? ''}</td>
                        <td className="px-2 text-danger">
                          {r.errors.length > 0 && <span className="flex gap-1"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{r.errors.join('; ')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
