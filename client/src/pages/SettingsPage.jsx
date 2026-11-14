import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Archive, ArrowDown, ArrowUp, Copy, Lock, GitBranch, Globe, Plus, RefreshCw, Trash2, UserPlus, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { qk, useProject } from '../lib/queries.js';
import { ROLE_LABEL, roleAtLeast, timeAgo } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { CustomFields, Recurring, Templates } from '../components/CustomiseSettings.jsx';
import { AuditLogLink, Rules, ServiceLevels } from '../components/AutomationSettings.jsx';
import { CardLayoutSettings, ChecklistSettings, LabelsSettings } from '../components/SetupSettings.jsx';
import { CrashCaptureSettings, SourceMapSettings, SourceSettings, WidgetSettings } from '../components/BugTools.jsx';
import { RoadmapSettings, ShareLinks } from '../components/OutsideTools.jsx';
import { GitlabSettings, OutboundSettings } from '../components/IntegrationTools.jsx';
import { BackupSettings, ProjectWorkspace, StorageSettings } from '../components/PlatformTools.jsx';
import { GithubDeepSettings } from '../components/GithubTools.jsx';
import { Avatar, Badge, Button, EmptyState, Field, Modal } from '../components/ui.jsx';
import { Skeleton, useDoneFlash } from '../ds/core.jsx';
import { SettingsGroup, SettingsIndex, SettingsSection as Section } from '../components/SettingsSection.jsx';
import { ask } from '../components/confirm.jsx';
import { ProjectMissing } from '../components/states.jsx';
import PortalBrand from '../components/PortalBrand.jsx';

const copy = (text, what) => copyText(text, `${what} copied`);


// The tick state lives in the page: this block remounts when the saved project comes back.
function General({ project, isManager, isAdmin, refresh, savedFlash }) {
  const [form, setForm] = useState({ name: project.name, key: project.key, description: project.description });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, flash] = savedFlash;
  const save = async () => {
    setBusy(true);
    setErrors({});
    const body = { name: form.name, description: form.description, ...(form.key.toUpperCase() !== project.key && { key: form.key }) };
    try { await api(`/projects/${project.id}`, { method: 'PATCH', body }); flash(); refresh(); } catch (e) { setErrors(Object.keys(e.fieldErrors()).length ? e.fieldErrors() : { name: e.message }); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Section title="General" description="Changing the key renames every ticket (SC-12 becomes NEW-12). Old links still work by number.">
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} disabled={!isManager || project.archivedAt} maxLength={80} /></Field>
        <Field label="Key" error={errors.key} hint={isAdmin ? undefined : 'Admins only'}><input className="input font-code uppercase" value={form.key} onChange={set('key')} disabled={!isAdmin || project.archivedAt} maxLength={6} /></Field>
      </div>
      <Field label="Description" className="mt-4" error={errors.description}><textarea className="input" rows={3} value={form.description} onChange={set('description')} disabled={!isManager || project.archivedAt} maxLength={2000} /></Field>
      {isManager && !project.archivedAt && <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} done={saved} disabled={!saved && !(form.name !== project.name || form.key.toUpperCase() !== project.key || (form.description ?? '') !== (project.description ?? ''))} onClick={save}>{saved ? 'Saved' : 'Save changes'}</Button></div>}
    </Section>
  );
}

function Members({ project, me, refresh }) {
  const navigate = useNavigate();
  const isManager = roleAtLeast(project.myRole, 'manager');
  const isAdmin = project.myRole === 'admin';
  const roles = isAdmin ? ['admin', 'manager', 'developer', 'viewer'] : ['developer', 'viewer'];
  const change = async (userId, role) => {
    try { await api(`/projects/${project.id}/members/${userId}`, { method: 'PATCH', body: { role } }); refresh(); } catch (e) { toast.error(e.message); refresh(); }
  };
  const remove = async (m) => {
    const leaving = m.user.id === me;
    if (!(await ask(leaving ? `Leave ${project.name}? You lose access to its board at once.` : `Remove ${m.user.name}? Their tickets in ${project.name} become unassigned.`, { confirmLabel: leaving ? 'Leave' : 'Remove' }))) return;
    try {
      await api(`/projects/${project.id}/members/${m.user.id}`, { method: 'DELETE' });
      if (leaving) { toast.success(`You left ${project.name}`); navigate('/projects'); } else { toast.success(`${m.user.name} removed`); refresh(); }
    } catch (e) { toast.error(e.message); }
  };
  const canManage = (m) => isAdmin || (isManager && ['developer', 'viewer'].includes(m.role));
  return (
    <Section title="Members" description="Admins manage everyone. Managers manage developers and viewers. Every project keeps at least one admin.">
      <ul className="divide-y divide-line">
        {project.members.map((m) => (
          <li key={m.user.id} className="flex items-center gap-3 py-2.5">
            <Avatar user={m.user} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-small font-medium">{m.user.name}{m.user.id === me && <span className="ml-1.5 text-caption text-fg-subtle">(you)</span>}</span>
              <span className="block truncate text-caption text-fg-subtle">{m.user.email}</span>
            </span>
            {canManage(m) && m.user.id !== me && !project.archivedAt ? (
              <select className="input h-8 w-32 text-caption" value={m.role} onChange={(e) => change(m.user.id, e.target.value)} aria-label={`Role of ${m.user.name}`}>
                {[...new Set([m.role, ...roles])].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            ) : <Badge tone={m.role === 'admin' ? 'brand' : 'zinc'}>{ROLE_LABEL[m.role]}</Badge>}
            {(m.user.id === me || canManage(m)) && (
              <Button size="icon" variant="ghost" onClick={() => remove(m)} aria-label={m.user.id === me ? 'Leave project' : `Remove ${m.user.name}`}><X className="size-4" /></Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Invites({ project }) {
  const qc = useQueryClient();
  const isAdmin = project.myRole === 'admin';
  const { data } = useQuery({ queryKey: ['invites', project.id], queryFn: () => api(`/projects/${project.id}/invites`).then((d) => d.invites) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(''); setSent(null);
    try {
      const res = await api(`/projects/${project.id}/invites`, { method: 'POST', body: { email, role } });
      setSent(res); setEmail('');
      qc.invalidateQueries({ queryKey: ['invites', project.id] });
    } catch (e) { setError(e.fieldErrors().email ?? e.message); } finally { setBusy(false); }
  };
  const revoke = async (id) => {
    try { await api(`/projects/${project.id}/invites/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['invites', project.id] }); } catch (e) { toast.error(e.message); }
  };
  return (
    <Section title="Invite people" description="They get an email with a link that works for 7 days, and only for an account with that email.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input className="input min-w-0 flex-1" type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
        <select className="input w-36" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          {(isAdmin ? ['admin', 'manager', 'developer', 'viewer'] : ['developer', 'viewer']).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <Button type="submit" variant="primary" loading={busy} disabled={!email}><UserPlus className="size-4" />Invite</Button>
      </form>
      {error && <p className="mt-2 text-caption text-danger">{error}</p>}
      {sent && (
        <div className="mt-3 rounded-tile border border-line p-3 text-caption ">
          <p>{sent.email.sent ? `Invite emailed to ${sent.invite.email}.` : `The email could not be sent (${sent.email.reason === 'not_configured' ? 'email is not set up on this server' : 'the mail server refused it'}). Share the link yourself:`}</p>
          <div className="mt-2 flex gap-2">
            <input readOnly className="input h-8 font-code text-micro" value={sent.acceptUrl} aria-label="Invite link" />
            <Button size="sm" onClick={() => copy(sent.acceptUrl, 'Invite link')}><Copy className="size-3.5" />Copy</Button>
          </div>
        </div>
      )}
      {data?.length > 0 && (
        <ul className="mt-4 divide-y divide-line text-small ">
          {data.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate">{i.email}</span>
              <Badge>{ROLE_LABEL[i.role]}</Badge>
              <span className="hidden text-caption text-fg-subtle sm:block">sent {timeAgo(i.createdAt)}</span>
              <Button size="sm" variant="ghost" onClick={() => revoke(i.id)}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Columns({ project, refresh }) {
  const [cols, setCols] = useState(project.statuses.map((s) => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const [saved, flash] = useDoneFlash();
  useEffect(() => { setCols(project.statuses.map((s) => ({ ...s }))); }, [project.statuses]);
  const set = (i, k, v) => setCols((c) => c.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const move = (i, d) => setCols((c) => { const n = [...c]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  const save = async () => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/statuses`, {
        method: 'PUT',
        body: { statuses: cols.map(({ key, name, category, wipLimit }) => ({ ...(key && { key }), name, category, wipLimit: wipLimit ? Number(wipLimit) : null })) },
      });
      flash();
      refresh();
    } catch (e) {
      const details = Array.isArray(e.details) && e.details[0]?.count ? ` (${e.details.map((d) => `${d.name}: ${d.count}`).join(', ')})` : '';
      toast.error(e.message + details);
    } finally { setBusy(false); }
  };
  return (
    <Section title="Board columns" description="Rename, reorder, add or remove columns, and set WIP limits (most cards a column may hold). A column can only be removed once it's empty.">
      <ul className="space-y-2">
        {cols.map((c, i) => (
          // Phone: name and remove on one line, "counts as" and the limit under the name.
          <li key={c.key ?? `new-${i}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-tile bg-sunken/60 p-1.5 sm:flex sm:bg-transparent sm:p-0">
            <span className="flex flex-col">
              <button type="button" className="ds-focus grid h-4 w-6 place-items-center rounded-hair text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${c.name} up`}><ArrowUp className="size-3.5" /></button>
              <button type="button" className="ds-focus grid h-4 w-6 place-items-center rounded-hair text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-30" disabled={i === cols.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${c.name} down`}><ArrowDown className="size-3.5" /></button>
            </span>
            <input className="input h-8 min-w-0 flex-1 text-small" value={c.name} onChange={(e) => set(i, 'name', e.target.value)} maxLength={40} aria-label={`Name of column ${i + 1}`} />
            <Button size="icon" variant="ghost" className="sm:order-last" disabled={cols.length <= 2} onClick={() => setCols((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${c.name}`}><Trash2 className="size-4" /></Button>
            <div className="col-span-2 col-start-2 grid grid-cols-2 gap-2 sm:contents">
              <select className="input h-8 text-caption sm:w-32" value={c.category} onChange={(e) => set(i, 'category', e.target.value)} aria-label={`${c.name} counts as`}>
                <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
              </select>
              <input className="input h-8 text-caption sm:w-24" type="number" min="1" max="999" placeholder="No limit" value={c.wipLimit ?? ''} onChange={(e) => set(i, 'wipLimit', e.target.value || null)} aria-label={`WIP limit of ${c.name}`} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-between">
        <Button size="sm" onClick={() => setCols((c) => [...c.slice(0, -1), { name: 'New column', category: 'in_progress', wipLimit: null }, c.at(-1)])} disabled={cols.length >= 12}><Plus className="size-3.5" />Add column</Button>
        <Button variant="primary" loading={busy} done={saved} disabled={!saved && JSON.stringify(cols) === JSON.stringify(project.statuses)} onClick={save}>{saved ? 'Saved' : 'Save columns'}</Button>
      </div>
    </Section>
  );
}

function Portal({ project }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['portal', project.id], queryFn: () => api(`/projects/${project.id}/portal`).then((d) => d.portal) });
  const [intro, setIntro] = useState(null);
  const put = async (body) => {
    try { const r = await api(`/projects/${project.id}/portal`, { method: 'PUT', body }); qc.setQueryData(['portal', project.id], r.portal); toast.success('Portal saved'); } catch (e) { toast.error(e.message); }
  };
  const rotate = async () => {
    if (!(await ask('Make a new link? The old one stops working at once.', { confirmLabel: 'Make new link' }))) return;
    const r = await api(`/projects/${project.id}/portal/rotate`, { method: 'POST' });
    qc.setQueryData(['portal', project.id], r.portal);
  };
  if (!data) return null;
  return (
    <Section title="Public bug-report page" description="A link anyone can use to report a problem without an account. Reports land in the triage inbox, and reporters get an email when it's fixed.">
      <label className="flex items-center gap-2.5 text-small">
        <input type="checkbox" className="accent-accent" checked={data.enabled} onChange={(e) => put({ enabled: e.target.checked })} disabled={Boolean(project.archivedAt)} />
        Accept reports from the public
      </label>
      {data.url && data.enabled && (
        <div className="mt-3 flex gap-2">
          <input readOnly className="input h-8 font-code text-micro" value={data.url} aria-label="Public link" />
          <Button size="sm" onClick={() => copy(data.url, 'Link')}><Copy className="size-3.5" />Copy</Button>
          <Button size="sm" onClick={() => window.open(data.url, '_blank', 'noopener')}><Globe className="size-3.5" />Open</Button>
          <Button size="sm" variant="ghost" onClick={rotate}><RefreshCw className="size-3.5" />New link</Button>
        </div>
      )}
      <Field label="Message shown on the page" className="mt-4">
        <textarea className="input" rows={2} maxLength={500} value={intro ?? data.intro} onChange={(e) => setIntro(e.target.value)} placeholder="Found a bug in our app? Tell us what happened." />
      </Field>
      <div className="mt-2 flex items-center justify-between text-caption text-fg-subtle">
        <span>{data.turnstile ? 'Bot check (Cloudflare Turnstile) is on.' : 'Spam protection: a hidden bot trap and 10 reports per hour per network.'}</span>
        {intro !== null && intro !== data.intro && <Button size="sm" variant="primary" onClick={() => put({ intro })}>Save message</Button>}
      </div>
      <PortalBrand project={project} portal={data} disabled={Boolean(project.archivedAt)} />
      <WidgetSettings portal={data} put={put} disabled={Boolean(project.archivedAt)} />
    </Section>
  );
}

function GitHub({ project }) {
  const qc = useQueryClient();
  const isAdmin = project.myRole === 'admin';
  const { data } = useQuery({ queryKey: ['github', project.id], queryFn: () => api(`/projects/${project.id}/integrations/github`).then((d) => d.github) });
  const run = async (method) => {
    if (method === 'DELETE' && !(await ask('Disconnect GitHub? Deliveries will be refused until you connect again.'))) return;
    try { const r = await api(`/projects/${project.id}/integrations/github`, { method }); qc.setQueryData(['github', project.id], r.github); } catch (e) { toast.error(e.message); }
  };
  if (!data) return null;
  return (
    <Section title="GitHub" description={`Commits and pull requests that mention ${project.key}-12 link to that ticket. "fixes ${project.key}-12" closes it when merged or pushed to the main branch.`}>
      {!data.connected ? (
        isAdmin ? <Button variant="primary" onClick={() => run('PUT')}><GitBranch className="size-4" />Connect GitHub</Button>
          : <p className="text-small text-fg-subtle">Not connected. An admin can connect it.</p>
      ) : (
        <div className="space-y-3 text-small">
          <p className="flex items-center gap-2"><Badge tone="teal">Connected</Badge><span className="text-caption text-fg-subtle">since {timeAgo(data.connectedAt)}</span></p>
          {isAdmin ? (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-caption text-fg-muted">
                <li>In your repository on GitHub: Settings → Webhooks → Add webhook.</li>
                <li>Paste the payload URL and secret below. Content type: application/json.</li>
                <li>Choose "Let me select individual events": Pushes and Pull requests.</li>
              </ol>
              {[['Payload URL', data.url], ['Secret', data.secret]].map(([l, v]) => v && (
                <div key={l} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-caption text-fg-subtle">{l}</span>
                  <input readOnly className="input h-8 font-code text-micro" value={v} aria-label={l} />
                  <Button size="sm" onClick={() => copy(v, l)}><Copy className="size-3.5" /></Button>
                </div>
              ))}
              {data.url?.startsWith('http://localhost') && <p className="text-caption text-warning">GitHub cannot reach localhost. This starts working once the API is deployed.</p>}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => run('PUT')}><RefreshCw className="size-3.5" />New secret</Button>
                <Button size="sm" variant="ghost" onClick={() => run('DELETE')}>Disconnect</Button>
              </div>
            </>
          ) : <p className="text-caption text-fg-subtle">Only admins can see the secret.</p>}
        </div>
      )}
    </Section>
  );
}

function DangerZone({ project, refresh }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [confirmKey, setConfirmKey] = useState('');
  const [error, setError] = useState('');
  const archive = async () => {
    try { await api(`/projects/${project.id}/${project.archivedAt ? 'unarchive' : 'archive'}`, { method: 'POST' }); refresh(); toast.success(project.archivedAt ? 'Project restored' : 'Project archived'); } catch (e) { toast.error(e.message); }
  };
  const remove = async () => {
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE', body: { confirmKey } });
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success(`${project.name} deleted`);
      navigate('/projects');
    } catch (e) { setError(e.message); }
  };
  return (
    <Section title="Archive or delete" tone="danger" description="Archiving makes the project read-only and hides it from the list. Deleting removes every ticket, comment, file and its history, for good.">
      <div className="flex flex-wrap gap-2">
        <Button onClick={archive}>{project.archivedAt ? 'Unarchive project' : 'Archive project'}</Button>
        <Button variant="danger" onClick={() => setDeleting(true)}><Trash2 className="size-4" />Delete project</Button>
      </div>
      <Modal open={deleting} onClose={() => setDeleting(false)} title={`Delete ${project.name}?`}
        footer={<><Button onClick={() => setDeleting(false)}>Cancel</Button><Button variant="danger" disabled={confirmKey.toUpperCase() !== project.key} onClick={remove}>Delete for good</Button></>}>
        <p className="text-small text-fg-muted">This deletes {project.ticketCounter} tickets with their comments, files and history. It cannot be undone.</p>
        <Field label={`Type ${project.key} to confirm`} className="mt-4" error={error}>
          <input className="input font-code uppercase" value={confirmKey} onChange={(e) => setConfirmKey(e.target.value)} />
        </Field>
      </Modal>
    </Section>
  );
}

// While the project loads: the shape of the page, not a spinner.
function SettingsSkeleton() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6" aria-busy="true" aria-label="Loading settings">
      <Skeleton className="mb-5 h-6 w-48" />
      <div className="lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-8">
        <div className="hidden space-y-2 lg:block">{['w-3/4', 'w-1/2', 'w-4/5', 'w-3/5', 'w-1/2'].map((w, i) => <Skeleton key={i} className={`h-5 ${w}`} />)}</div>
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="rounded-card bg-surface p-5 shadow-surface"><Skeleton className="h-4 w-32" /><Skeleton className="mt-3 h-3 w-2/3" /><Skeleton className="mt-5 h-9 w-full" /></div>)}</div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: project, error } = useProject(projectId);
  const generalSaved = useDoneFlash();
  const refresh = () => { qc.invalidateQueries({ queryKey: qk.project(projectId) }); qc.invalidateQueries({ queryKey: qk.projects }); };
  if (error) return <ProjectMissing error={error} />;
  if (!project) return <SettingsSkeleton />;
  const isManager = roleAtLeast(project.myRole, 'manager');
  const isAdmin = project.myRole === 'admin';
  const editable = isManager && !project.archivedAt;
  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Settings' }]}
        title={<ProjectSwitcher project={project}>{project.archivedAt && <Badge tone="amber">Archived</Badge>}</ProjectSwitcher>}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <SettingsIndex label="Project settings">
          {!isManager && (
            <p className="flex items-start gap-2.5 rounded-card border border-line px-4 py-3 text-small text-fg-muted">
              <Lock className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
              You are {ROLE_LABEL[project.myRole] === 'Viewer' ? 'a viewer' : 'a developer'} here. Managers and admins can change columns, invites, the public page and integrations.
            </p>
          )}
          {project.archivedAt && (
            <p role="status" className="flex items-start gap-2.5 rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-small text-fg">
              <Archive className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              This project is archived, so it is read-only. {isAdmin ? 'Unarchive it under Danger zone to change it again.' : 'An admin can unarchive it.'}
            </p>
          )}
          <SettingsGroup title="Project">
            <General key={project.updatedAt} project={project} isManager={isManager} isAdmin={isAdmin} refresh={refresh} savedFlash={generalSaved} />
            <Members project={project} me={user.id} refresh={refresh} />
            {editable && <Invites project={project} />}
            <ProjectWorkspace project={project} Section={Section} />
          </SettingsGroup>
          <SettingsGroup title="Board and tickets">
            {editable && <Columns project={project} refresh={refresh} />}
            {editable && <LabelsSettings project={project} refresh={refresh} />}
            {editable && <CustomFields project={project} refresh={refresh} />}
            {editable && <CardLayoutSettings project={project} refresh={refresh} />}
            {editable && <Templates project={project} />}
            {editable && <Recurring project={project} />}
            {editable && <ChecklistSettings project={project} />}
          </SettingsGroup>
          <SettingsGroup title="Automation">
            {editable && <Rules project={project} />}
            {editable && <ServiceLevels project={project} refresh={refresh} />}
            {isManager && <AuditLogLink project={project} />}
          </SettingsGroup>
          <SettingsGroup title="Sharing">
            {isManager && <Portal project={project} />}
            {isManager && <RoadmapSettings project={project} Section={Section} />}
            {isManager && <ShareLinks project={project} Section={Section} />}
          </SettingsGroup>
          <SettingsGroup title="Integrations">
            {isManager && <GitHub project={project} />}
            {editable && <GithubDeepSettings project={project} Section={Section} />}
            {isManager && <GitlabSettings project={project} Section={Section} />}
            {isManager && <OutboundSettings project={project} Section={Section} />}
          </SettingsGroup>
          <SettingsGroup title="Crash reports">
            {editable && <CrashCaptureSettings project={project} />}
            {editable && <SourceMapSettings project={project} />}
            {editable && <SourceSettings project={project} refresh={refresh} />}
          </SettingsGroup>
          <SettingsGroup title="Data">
            {isManager && <StorageSettings project={project} Section={Section} />}
            {isAdmin && <BackupSettings project={project} Section={Section} />}
          </SettingsGroup>
          {isAdmin && (
            <SettingsGroup title="Danger zone">
              <DangerZone project={project} refresh={refresh} />
            </SettingsGroup>
          )}
        </SettingsIndex>
      </div>
    </div>
  );
}
