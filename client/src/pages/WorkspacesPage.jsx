import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Building2, Plus } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, Button, EmptyState, Spinner } from '../components/ui.jsx';
import { ask } from '../components/confirm.jsx';

// Workspaces (E14): teams and companies that group projects and people.

function Workspace({ id, me }) {
  const qc = useQueryClient();
  const { data: ws } = useQuery({ queryKey: ['workspace', id], queryFn: () => api(`/workspaces/${id}`).then((d) => d.workspace) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  if (!ws) return <Spinner className="text-fg-subtle" />;
  const admin = ['owner', 'admin'].includes(ws.myRole);
  const call = async (path, method, body) => {
    try {
      const r = await api(`/workspaces/${id}${path}`, { method, body });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      if (r?.workspace) qc.setQueryData(['workspace', id], r.workspace); else qc.invalidateQueries({ queryKey: ['workspace', id] });
      return true;
    } catch (e) { toast.error(e.message); return false; }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-4">
        <h3 className="text-small font-semibold">People ({ws.members.length})</h3>
        <ul className="mt-2 divide-y divide-line text-small ">
          {ws.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="font-medium">{m.name}</span><span className="text-caption text-fg-subtle">{m.email}</span>
              <span className="ml-auto flex items-center gap-1">
                {admin && m.id !== me ? (
                  <select className="input h-7 w-auto py-0 text-caption" value={m.role} onChange={(e) => call(`/members/${m.id}`, 'PATCH', { role: e.target.value })} aria-label={`Role of ${m.name}`}>
                    {['member', 'admin', ...(ws.myRole === 'owner' || m.role === 'owner' ? ['owner'] : [])].map((r) => <option key={r}>{r}</option>)}
                  </select>
                ) : <Badge>{m.role}</Badge>}
                {(admin || m.id === me) && <Button size="sm" variant="ghost" onClick={async () => (await ask(m.id === me ? 'Leave this workspace?' : `Remove ${m.name}?`)) && call(`/members/${m.id}`, 'DELETE')}>{m.id === me ? 'Leave' : 'Remove'}</Button>}
              </span>
            </li>
          ))}
        </ul>
        {admin && (
          <form className="mt-3 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); if (await call('/members', 'POST', { email: email.trim(), role })) setEmail(''); }}>
            <input className="input h-8 w-56" type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <select className="input h-8 w-auto" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option>member</option><option>admin</option>{ws.myRole === 'owner' && <option>owner</option>}</select>
            <Button size="sm" type="submit" disabled={!email.trim()}>Add</Button>
          </form>
        )}
      </section>
      <section className="card p-4">
        <h3 className="text-small font-semibold">Projects ({ws.projects.length})</h3>
        {!ws.projects.length && <p className="mt-2 text-caption text-fg-subtle">Project admins can put a project here from its Settings.</p>}
        <ul className="mt-2 divide-y divide-line text-small ">
          {ws.projects.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-1.5">
              <span className="font-code text-caption text-fg-subtle">{p.key}</span>
              {p.myRole ? <Link to={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link> : <span>{p.name}</span>}
              <span className="ml-auto text-caption text-fg-subtle">{p.myRole ?? 'not a member'} · {p.members} people</span>
            </li>
          ))}
        </ul>
        {ws.myRole === 'owner' && (
          <Button size="sm" variant="ghost" className="mt-3" onClick={async () => {
            if (!(await ask(`Delete ${ws.name}? Its projects stay; they just stop being grouped.`))) return;
            try { await api(`/workspaces/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['workspaces'] }); } catch (e) { toast.error(e.message); }
          }}>Delete workspace</Button>
        )}
      </section>
    </div>
  );
}

export default function WorkspacesPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['workspaces'], queryFn: () => api('/workspaces').then((d) => d.workspaces) });
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    try { const r = await api('/workspaces', { method: 'POST', body: { name: name.trim() } }); setName(''); setOpenId(r.workspace.id); qc.invalidateQueries({ queryKey: ['workspaces'] }); } catch (err) { toast.error(err.message); }
  };
  const selected = data?.some((w) => w.id === openId) ? openId : data?.[0]?.id;
  return (
    <div>
      <PageHeader title={<h1 className="font-display text-h1 italic text-fg">Workspaces</h1>} />
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        <form className="flex flex-wrap gap-2" onSubmit={create}>
          <input className="input h-9 w-64" placeholder="Team or company name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="New workspace name" />
          <Button type="submit" variant="primary" disabled={!name.trim()}><Plus className="size-4" />New workspace</Button>
        </form>
        {isLoading ? <Spinner className="text-fg-subtle" /> : !data?.length ? (
          <EmptyState icon={Building2} title="No workspaces yet">A workspace groups your team's projects and people, so adding the whole team to a new project is one step.</EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="tablist">
              {data.map((w) => (
                <button key={w.id} type="button" role="tab" aria-selected={w.id === selected} onClick={() => setOpenId(w.id)}
                  className={`rounded-tile border px-3 py-1.5 text-small ${w.id === selected ? 'border-key-line bg-key-bg' : 'border-line'}`}>
                  {w.name} <span className="text-caption text-fg-subtle">{w.members} people · {w.projects} projects · {w.myRole}</span>
                </button>
              ))}
            </div>
            {selected && <Workspace key={selected} id={selected} me={user?.id} />}
          </>
        )}
      </div>
    </div>
  );
}
