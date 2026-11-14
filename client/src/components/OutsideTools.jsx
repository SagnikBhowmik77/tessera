import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Copy, Globe, Map as MapIcon, Merge, RefreshCw, Users } from 'lucide-react';
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { formatDateTime, timeAgo } from '../lib/format.js';
import { Badge, Button, Field, KeyLink, Modal } from './ui.jsx';
import { ask } from './confirm.jsx';
import { EmptyNote } from '../ds/core.jsx';

// Client-facing (E11), the team's side: who reported a ticket and what they said about the fix,
// merging duplicate reports, the public roadmap and read-only board links.

export const useReporters = (pid, number, enabled) => useQuery({
  queryKey: ['reporters', pid, number],
  queryFn: () => api(`/projects/${pid}/tickets/${number}/reporters`).then((d) => d.reporters),
  enabled,
});

export function ReportersPanel({ pid, number, enabled }) {
  const { data } = useReporters(pid, number, enabled);
  if (!enabled || !data?.length) return null;
  return (
    <section className="border-t border-line pt-6 text-small">
      <h3 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Users className="size-3.5" />Outside reporters ({data.length})</h3>
      <ul className="mt-2 space-y-1.5">
        {data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium">{r.name ?? 'No name given'}</span>
            <span className="text-caption text-fg-subtle">{r.email ?? 'no email: reads replies on their tracking page'}</span>
            {r.mergedFrom && <Badge>from {r.mergedFrom}</Badge>}
            {r.answer?.value === 'fixed' && <Badge tone="teal">Confirmed fixed</Badge>}
            {r.answer?.value === 'broken' && <Badge tone="red">Said still broken</Badge>}
            <span className="w-full text-caption text-fg-subtle">"{r.title}" · reported {timeAgo(r.reportedAt)}{r.lastSeenAt ? ` · last looked ${timeAgo(r.lastSeenAt)}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MergeControl({ project, ticket, onMerged }) {
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  if (ticket.duplicateOf) {
    return <p className="text-small">Merged into <Link to={`/projects/${project.id}/tickets/${ticket.duplicateOf}`} className="font-code underline">{ticket.duplicateOf}</Link>.</p>;
  }
  const merge = async () => {
    setBusy(true);
    try {
      const r = await api(`/projects/${project.id}/tickets/${ticket.number}/merge`, { method: 'POST', body: { into: into.trim() } });
      toast.success(`Merged into ${r.ticket.key}${r.reportersMoved ? `; ${r.reportersMoved} reporter${r.reportersMoved === 1 ? '' : 's'} moved over` : ''}`);
      qc.invalidateQueries({ queryKey: ['tickets', project.id] });
      setOpen(false);
      onMerged?.(r.ticket);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Merge className="size-3.5" />Merge into…</Button>
      <Modal open={open} title={`Merge ${ticket.key} into another ticket`} onClose={() => setOpen(false)}
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!into.trim()} onClick={merge}>Merge</Button></>}>
        <div className="space-y-3 text-small">
          <p>Use this when two tickets describe the same problem. This ticket is closed as a duplicate and points at the other one.</p>
          <p className="text-fg-subtle">Everyone who reported this one moves over: they keep their tracking link, are told by email that the reports were joined, and hear when the other ticket is fixed.</p>
          <Field label="Merge into"><input className="input" value={into} onChange={(e) => setInto(e.target.value)} placeholder={`${project.key}-12`} /></Field>
        </div>
      </Modal>
    </>
  );
}

export function RoadmapToggle({ project, ticket }) {
  const qc = useQueryClient();
  const [on, setOn] = useState(Boolean(ticket.roadmap));
  const flip = async () => {
    try {
      await api(`/projects/${project.id}/tickets/${ticket.number}/roadmap`, { method: 'PUT', body: { onRoadmap: !on } });
      setOn(!on);
      qc.invalidateQueries({ queryKey: ['roadmap', project.id] });
    } catch (e) { toast.error(e.message); }
  };
  return (
    <label className="flex items-center gap-2 text-small">
      <input type="checkbox" className="accent-accent" checked={on} onChange={flip} />
      <MapIcon className="size-3.5 text-fg-subtle" aria-hidden />On the public roadmap
    </label>
  );
}

export function RoadmapSettings({ project, Section }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['roadmap', project.id], queryFn: () => api(`/projects/${project.id}/roadmap`) });
  const [intro, setIntro] = useState(null);
  const put = async (body) => {
    try { const r = await api(`/projects/${project.id}/roadmap`, { method: 'PUT', body }); qc.setQueryData(['roadmap', project.id], (d) => ({ ...d, roadmap: r.roadmap })); toast.success('Roadmap saved'); } catch (e) { toast.error(e.message); }
  };
  if (!data) return null;
  const { roadmap, items } = data;
  return (
    <Section title="Public roadmap" description="A page anyone with the link can open to see what is planned, in progress and recently done, and vote on what they want next. Tick 'On the public roadmap' on a ticket to show it.">
      <label className="flex items-center gap-2.5 text-small">
        <input type="checkbox" className="accent-accent" checked={roadmap.enabled} onChange={(e) => put({ enabled: e.target.checked })} disabled={Boolean(project.archivedAt)} />
        Publish the roadmap
      </label>
      {roadmap.url && (
        <div className="mt-3 flex gap-2">
          <input readOnly className="input h-8 font-code text-micro" value={roadmap.url} aria-label="Roadmap link" />
          <Button size="sm" onClick={() => copyText(roadmap.url, 'Link copied')}><Copy className="size-3.5" />Copy</Button>
          <Button size="sm" onClick={() => window.open(roadmap.url, '_blank', 'noopener')}><Globe className="size-3.5" />Open</Button>
          <Button size="sm" variant="ghost" onClick={async () => (await ask('Make a new link? The old one stops working at once.', { confirmLabel: 'Make new link' })) && put({ rotate: true })}><RefreshCw className="size-3.5" />New link</Button>
        </div>
      )}
      <Field label="Message shown on the page" className="mt-4">
        <textarea className="input" rows={2} maxLength={500} value={intro ?? roadmap.intro} onChange={(e) => setIntro(e.target.value)} placeholder="What we're building next. Vote for what matters to you." />
      </Field>
      {intro !== null && intro !== roadmap.intro && <Button size="sm" variant="primary" className="mt-2" onClick={() => put({ intro })}>Save message</Button>}
      <div className="mt-4 text-small">
        <p className="font-medium">On the roadmap ({items.length})</p>
        {!items.length ? <EmptyNote size="xs">Nothing yet.</EmptyNote> : (
          <ul className="mt-1 space-y-1">
            {items.map((i) => (
              <li key={i.key} className="flex items-center gap-2">
                <KeyLink to={`/projects/${project.id}/tickets/${i.key}`}>{i.key}</KeyLink>
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <Badge>{i.stage.replace('_', ' ')}</Badge>
                <span className="w-16 text-right text-caption tabular-nums text-fg-subtle">{i.votes} vote{i.votes === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

export function ShareLinks({ project, Section }) {
  const qc = useQueryClient();
  const key = ['share-links', project.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api(`/projects/${project.id}/share-links`).then((d) => d.links) });
  const [name, setName] = useState('');
  const [showPeople, setShowPeople] = useState(false);
  const create = async (e) => {
    e.preventDefault();
    try {
      const { link } = await api(`/projects/${project.id}/share-links`, { method: 'POST', body: { name: name.trim(), showPeople } });
      qc.setQueryData(key, (d) => [link, ...(d ?? [])]);
      setName('');
      copyText(link.url, 'Link created and copied');
    } catch (err) { toast.error(err.message); }
  };
  const revoke = async (l) => {
    if (!(await ask(`Turn off "${l.name}"? Anyone using it loses access at once.`, { confirmLabel: 'Turn off' }))) return;
    try {
      const { link } = await api(`/projects/${project.id}/share-links/${l.id}`, { method: 'DELETE' });
      qc.setQueryData(key, (d) => d.map((x) => (x.id === link.id ? link : x)));
    } catch (err) { toast.error(err.message); }
  };
  return (
    <Section title="Read-only board links" description="Show the board to clients or stakeholders without an account. They see ticket titles, columns, labels and dates; never comments, attachments, reporters or the triage inbox. Assignee names only if you tick it. Turn a link off any time.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={create}>
        <Field label="Who is it for?"><input className="input w-56" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Client: Acme" /></Field>
        <label className="mb-2 flex items-center gap-2 text-small"><input type="checkbox" className="accent-accent" checked={showPeople} onChange={(e) => setShowPeople(e.target.checked)} />Show assignee names</label>
        <Button type="submit" variant="primary" disabled={!name.trim() || Boolean(project.archivedAt)} className="mb-0.5">Create link</Button>
      </form>
      <ul className="mt-4 divide-y divide-line text-small ">
        {(data ?? []).map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{l.name}</span>
            {l.showPeople && <Badge>shows names</Badge>}
            {l.revokedAt ? <Badge tone="red">Off since {formatDateTime(l.revokedAt)}</Badge> : <span className="text-caption text-fg-subtle">{l.lastUsedAt ? `opened ${timeAgo(l.lastUsedAt)}` : 'not opened yet'}</span>}
            {!l.revokedAt && (
              <span className="ml-auto flex gap-1">
                <Button size="sm" onClick={() => copyText(l.url, 'Link copied')}><Copy className="size-3.5" />Copy</Button>
                <Button size="sm" variant="ghost" onClick={() => revoke(l)}>Turn off</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
