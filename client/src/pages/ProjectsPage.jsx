import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderKanban, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { ROLE_LABEL, timeAgo } from '../lib/format.js';
import { PageHeader, ProjectTile } from '../components/AppShell.jsx';
import { ImportBackup } from '../components/PlatformTools.jsx';
import { Avatar, Badge, Button, EmptyState, Field, Modal, Spinner } from '../components/ui.jsx';
import { TemplatePicker } from '../components/SetupSettings.jsx';

// "Mobile Checkout" -> "MC", "Payments" -> "PAY".
export function suggestKey(name) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || !/^[A-Z]/.test(words[0])) return '';
  const key = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : words[0].slice(0, 3);
  return key.length >= 2 ? key : `${key}X`;
}

function NewProjectDialog({ open, onClose }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', key: '', description: '', template: '' });
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState({});
  const create = useMutation({
    mutationFn: (body) => api('/projects', { method: 'POST', body }),
    onSuccess: ({ project }) => {
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.success(`${project.name} is ready`);
      onClose();
      navigate(`/projects/${project.id}`);
    },
    onError: (err) => setErrors(Object.keys(err.fieldErrors()).length ? err.fieldErrors() : { key: err.message }),
  });
  const set = (field) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [field]: value, ...(field === 'name' && !keyTouched && { key: suggestKey(value) }) }));
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate({ ...form, template: form.template || undefined })}>Create project</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate({ ...form, template: form.template || undefined }); }}>
        <Field label="Name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} placeholder="Mobile app" maxLength={80} /></Field>
        <Field label="Key" error={errors.key} hint="2–6 letters or digits. Tickets are numbered with it, like TES-12.">
          <input
            className="input font-code uppercase"
            value={form.key}
            onChange={(e) => { setKeyTouched(true); set('key')(e); }}
            placeholder="APP"
            maxLength={6}
          />
        </Field>
        <Field label="Description" error={errors.description}>
          <textarea className="input" rows={3} value={form.description} onChange={set('description')} maxLength={2000} placeholder="What is this project about? (optional)" />
        </Field>
        <Field label="Start from" hint="Columns and labels only; no example tickets. You can change everything later.">
          <TemplatePicker value={form.template} onChange={(template) => setForm((f) => ({ ...f, template }))} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export default function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState(false);
  const { data: projects, isLoading } = useQuery({
    queryKey: [...qk.projects, { archived }],
    queryFn: () => api(`/projects?archived=${archived}`).then((d) => d.projects),
  });
  const list = archived ? projects : projects?.filter((p) => !p.archivedAt);

  return (
    <div>
      <PageHeader
        title={<h1 className="font-display text-h1 italic text-fg">Projects</h1>}
        actions={(
          <>
            <Button variant={archived ? 'secondary' : 'ghost'} size="sm" onClick={() => setArchived((a) => !a)}>
              <Archive className="size-3.5" />{archived ? 'Showing archived' : 'Show archived'}
            </Button>
            <ImportBackup />
            <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" />New project</Button>
          </>
        )}
      />
      <div className="p-4 sm:p-6">
        {isLoading && <div className="grid place-items-center py-20"><Spinner className="size-6 text-fg-subtle" /></div>}
        {list?.length === 0 && (
          <EmptyState
            icon={FolderKanban}
            title="Your first project starts here"
            action={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" />Create your first project</Button>}
          >
            A project holds a board, its tickets and the people working on them. You can invite your team once it exists.
          </EmptyState>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list?.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="card group flex flex-col p-5 transition-[translate,box-shadow] duration-(--dur-fast) ease-glass hover:-translate-y-0.5 hover:shadow-lift">
              <div className="flex items-start gap-3">
                <ProjectTile project={p} className="size-10 text-small" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-semibold">{p.name}</h2>
                    {p.archivedAt && <Badge tone="amber">Archived</Badge>}
                  </div>
                  <div className="font-code text-caption text-fg-subtle">{p.key} · {ROLE_LABEL[p.myRole]}</div>
                </div>
              </div>
              {/* The description when there is one (no placeholder text), then how far along the project is. */}
              {p.description && <p className="mt-3 line-clamp-2 text-small text-fg-muted">{p.description}</p>}
              {p.progress && (
                <div className="mt-auto pt-4">
                  <div className="flex items-baseline justify-between text-caption">
                    <span className="text-fg-muted">{p.progress.total ? <><b className="font-medium tabular-nums text-fg">{p.progress.done}</b> of <span className="tabular-nums">{p.progress.total}</span> done</> : 'No tickets yet'}</span>
                    {p.progress.total > 0 && <span className="tabular-nums text-fg-subtle">{Math.round((p.progress.done / p.progress.total) * 100)}%</span>}
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-press" role="img" aria-label={`${p.progress.done} of ${p.progress.total} tickets done`}>
                    <div className="ds-meter h-full rounded-full bg-status-done" style={{ width: `${p.progress.total ? Math.max(2, (p.progress.done / p.progress.total) * 100) : 0}%` }} />
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-center justify-between">
                <div className="flex -space-x-1.5">
                  {p.members.slice(0, 5).map((m) => <Avatar key={m.user.id} user={m.user} size="sm" />)}
                  {p.members.length > 5 && <span className="grid size-5 place-items-center rounded-full bg-press text-micro font-semibold ring-2 ring-surface">+{p.members.length - 5}</span>}
                </div>
                <span className="text-caption text-fg-subtle">Updated {timeAgo(p.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
