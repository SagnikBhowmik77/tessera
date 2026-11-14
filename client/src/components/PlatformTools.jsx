import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, BellRing, Download, HardDrive, Upload } from 'lucide-react';
import { api, apiBlob } from '../lib/api.js';
import { fileSize, formatDateTime, timeAgo } from '../lib/format.js';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/pwa.js';
import { Badge, Button, Field, KeyLink, Modal } from './ui.jsx';

// Platform (E14): push on this device, a project's workspace, backup, storage, and importing.

export function PushSettings({ Section }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['push'], queryFn: () => api('/me/push') });
  const [here, setHere] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { currentSubscription().then((s) => setHere(s?.endpoint ?? null)).catch(() => setHere(null)); }, [data]);
  if (!data) return null;
  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); qc.invalidateQueries({ queryKey: ['push'] }); if (ok) toast.success(ok); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const supported = pushSupported();
  return (
    <Section title="Push notifications" description="Notifications on this device when Tessera is closed, including the installed app. Not sent while you have Tessera open, or during your quiet hours.">
      <div className="space-y-3 text-small">
        {!data.key ? <p className="text-caption text-fg-subtle">Push notifications are not set up on this server.</p>
          : !supported ? <p className="text-caption text-fg-subtle">This browser does not support push notifications.</p>
            : here ? (
              <div className="flex flex-wrap gap-2">
                <Badge tone="teal"><BellRing className="size-3" />On for this device</Badge>
                <Button size="sm" loading={busy} onClick={() => run(() => api('/me/push/test', { method: 'POST' }), 'Test sent')}>Send a test</Button>
                <Button size="sm" variant="ghost" loading={busy} onClick={() => run(disablePush, 'Turned off for this device')}>Turn off here</Button>
              </div>
            ) : <Button size="sm" variant="primary" loading={busy} onClick={() => run(() => enablePush(data.key), 'Push notifications are on')}><BellRing className="size-3.5" />Turn on for this device</Button>}
        {data.subscriptions.length > 0 && (
          <ul className="divide-y divide-line text-caption ">
            {data.subscriptions.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-1.5">
                <span>{s.browser}</span>
                <span className="text-fg-subtle">since {formatDateTime(s.createdAt)}{s.lastSuccessAt ? `, last delivered ${timeAgo(s.lastSuccessAt)}` : ''}</span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => run(() => api('/me/push', { method: 'DELETE', body: { id: s.id } }))}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

export function ProjectWorkspace({ project, Section }) {
  const qc = useQueryClient();
  const { data: list } = useQuery({ queryKey: ['workspaces'], queryFn: () => api('/workspaces').then((d) => d.workspaces) });
  const [role, setRole] = useState('developer');
  if (!list) return null;
  const isAdmin = project.myRole === 'admin';
  const current = list.find((w) => w.id === project.workspace);
  const refresh = () => ['project', 'projects', 'workspaces'].forEach((k) => qc.invalidateQueries({ queryKey: k === 'project' ? ['project', project.id] : [k] }));
  const move = async (workspaceId) => {
    try { await api(`/projects/${project.id}/workspace`, { method: 'PUT', body: { workspaceId: workspaceId || null } }); refresh(); toast.success('Saved'); } catch (e) { toast.error(e.message); }
  };
  const addAll = async () => {
    try {
      const r = await api(`/projects/${project.id}/members/from-workspace`, { method: 'POST', body: { role } });
      refresh();
      toast.success(r.added ? `Added ${r.added} ${r.added === 1 ? 'person' : 'people'}` : 'Everyone is already in the project');
    } catch (e) { toast.error(e.message); }
  };
  const mine = list.filter((w) => ['owner', 'admin'].includes(w.myRole));
  return (
    <Section title="Workspace" description="Group this project with your team's other projects, and add the whole team in one step.">
      <div className="space-y-3 text-small">
        {isAdmin ? (
          <label className="flex flex-wrap items-center gap-2">In
            <select className="input h-8 w-auto" value={project.workspace ?? ''} onChange={(e) => move(e.target.value)}>
              <option value="">no workspace</option>
              {mine.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              {current && !mine.includes(current) && <option value={current.id}>{current.name}</option>}
            </select>
            <Link to="/workspaces" className="text-caption underline">Manage workspaces</Link>
          </label>
        ) : <p>{current ? `In ${current.name}` : 'Not in a workspace'}.</p>}
        {project.workspace && (
          <div className="flex flex-wrap items-center gap-2">
            Add everyone from the workspace as
            <select className="input h-8 w-auto" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role for added people">{['viewer', 'developer', 'manager', ...(isAdmin ? ['admin'] : [])].map((r) => <option key={r}>{r}</option>)}</select>
            <Button size="sm" onClick={addAll}>Add</Button>
          </div>
        )}
      </div>
    </Section>
  );
}

export function BackupSettings({ project, Section }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const blob = await apiBlob(`/projects/${project.id}/export`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: `${project.key}-backup-${new Date().toISOString().slice(0, 10)}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Backup" description="Download the whole project as one JSON file: settings, people (by email), sprints, milestones, tickets and comments. It can be imported as a new project from the Projects page.">
      <div className="space-y-2 text-small">
        <Button loading={busy} onClick={download}><Download className="size-3.5" />Download backup</Button>
        <p className="text-caption text-fg-subtle">Not included: secrets and links (portal, GitHub, GitLab, crash keys, webhooks, share links), outside reporters' contact details and replies to them, and the files themselves (they are listed by name and size).</p>
      </div>
    </Section>
  );
}

function UsageBar({ s }) {
  const tone = s.level === 'critical' ? 'bg-danger' : s.level === 'warning' ? 'bg-warning' : 'bg-accent';
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-press" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, s.percent)} aria-label="File storage used">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, s.percent)}%` }} />
      </div>
      <p className="mt-1 text-caption text-fg-subtle">{fileSize(s.used.attachments)} of {fileSize(s.quota)} for files ({s.percent}%). Source maps {fileSize(s.used.sourceMaps)}, test runs {fileSize(s.used.testRuns)}.</p>
    </div>
  );
}

function FileRow({ f, projectId, picked, onPick }) {
  return (
    <li className="flex items-center gap-2 py-1 text-caption">
      {onPick && <input type="checkbox" className="accent-accent" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Select ${f.name}`} />}
      <span className="min-w-0 flex-1 truncate">{f.name}</span>
      {f.ticket && <KeyLink to={`/projects/${projectId}/tickets/${f.ticket.key}`}>{f.ticket.key}</KeyLink>}
      <span className="w-16 text-right tabular-nums text-fg-subtle">{fileSize(f.size)}</span>
    </li>
  );
}

export function StorageSettings({ project, Section }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const { data } = useQuery({ queryKey: ['storage', project.id, days], queryFn: () => api(`/projects/${project.id}/storage?days=${days}`) });
  const [picked, setPicked] = useState([]);
  const [confirm, setConfirm] = useState(false);
  if (!data) return null;
  const clear = async () => {
    try {
      const r = await api(`/projects/${project.id}/storage/cleanup`, { method: 'POST', body: { attachmentIds: picked } });
      toast.success(`Removed ${r.removed} file${r.removed === 1 ? '' : 's'}, ${fileSize(r.freed)} freed`);
      setPicked([]);
      qc.invalidateQueries({ queryKey: ['storage', project.id] });
      qc.invalidateQueries({ queryKey: ['storage-summary', project.id] });
    } catch (e) { toast.error(e.message); } finally { setConfirm(false); }
  };
  return (
    <Section title="Storage" description="Screenshots, recordings and logs count against this project's allowance on the shared free database.">
      <div className="space-y-4 text-small">
        <UsageBar s={data} />
        {data.level !== 'ok' && <p className="flex items-center gap-1.5 text-caption text-warning"><AlertTriangle className="size-3.5" aria-hidden />{data.level === 'critical' ? 'Almost full: new uploads will soon be refused.' : 'Over 80% used.'} Clear files below.</p>}
        <div>
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <span className="font-medium">Probably no longer needed:</span>
            <span className="text-fg-subtle">files on tickets finished or deleted more than</span>
            <select className="input h-7 w-auto py-0 text-caption" value={days} onChange={(e) => { setDays(Number(e.target.value)); setPicked([]); }} aria-label="Days">{[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
            <span className="text-fg-subtle">ago: {data.cleanup.count} ({fileSize(data.cleanup.bytes)})</span>
          </div>
          {data.cleanup.files.length > 0 && (
            <>
              <ul className="mt-1 divide-y divide-line">
                {data.cleanup.files.map((f) => <FileRow key={f.id} f={f} projectId={project.id} picked={picked.includes(f.id)} onPick={(on) => setPicked((p) => (on ? [...p, f.id] : p.filter((x) => x !== f.id)))} />)}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPicked(data.cleanup.files.map((f) => f.id))}>Select all</Button>
                <Button size="sm" disabled={!picked.length} onClick={() => setConfirm(true)}>Delete {picked.length || ''} selected</Button>
              </div>
            </>
          )}
        </div>
        {data.largest.length > 0 && (
          <details>
            <summary className="cursor-pointer text-caption font-medium">Largest files ({data.files} in all)</summary>
            <ul className="mt-1 divide-y divide-line">{data.largest.map((f) => <FileRow key={f.id} f={f} projectId={project.id} />)}</ul>
          </details>
        )}
      </div>
      <Modal open={confirm} title="Delete these files?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" onClick={clear}>Delete {picked.length}</Button></>}>
        <p className="text-small">{picked.length} file{picked.length === 1 ? '' : 's'} will be deleted for good. Each ticket's history records it. This can't be undone.</p>
      </Modal>
    </Section>
  );
}

// On the board, for managers, when the allowance is nearly used.
export function StorageBanner({ project }) {
  const manager = ['admin', 'manager'].includes(project.myRole);
  const { data } = useQuery({ queryKey: ['storage-summary', project.id], queryFn: () => api(`/projects/${project.id}/storage/summary`), enabled: manager, staleTime: 5 * 60_000 });
  if (!manager || !data || data.level === 'ok') return null;
  return (
    <div role="status" className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-tile border border-warning/40 bg-warning/10 px-3 py-2 text-small text-warning sm:mx-6   ">
      <HardDrive className="size-4 shrink-0" aria-hidden />
      File storage is {data.percent}% full{data.level === 'critical' ? '; new uploads will soon be refused' : ''}.
      <Link to={`/projects/${project.id}/settings`} className="ml-auto font-medium underline">Clear old files</Link>
    </div>
  );
}

export function ImportBackup() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (key.trim()) form.append('key', key.trim());
      if (name.trim()) form.append('name', name.trim());
      const r = await api('/projects/import', { method: 'POST', form });
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`Imported ${r.imported.tickets} tickets${r.leftOut.people.length ? `; ${r.leftOut.people.length} people have no account here and were left out` : ''}`);
      setOpen(false);
      navigate(`/projects/${r.project.id}`);
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Upload className="size-3.5" />Import backup</Button>
      <Modal open={open} title="Import a backup as a new project" onClose={() => setOpen(false)}
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!file} onClick={run}>Import</Button></>}>
        <form className="space-y-3 text-small" onSubmit={run}>
          <Field label="Backup file (.json from Settings → Backup)"><input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files[0] ?? null)} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Key (if the old one is taken)"><input className="input uppercase" value={key} onChange={(e) => setKey(e.target.value)} maxLength={6} placeholder="SHOP2" /></Field>
            <Field label="Name (optional)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          </div>
          <p className="text-caption text-fg-subtle">People are matched by email to existing accounts and keep their role; you become admin. Files are not part of a backup.</p>
        </form>
      </Modal>
    </>
  );
}
