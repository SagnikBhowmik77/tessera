import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Keyboard } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk, useProject } from '../lib/queries.js';
import { PRIORITIES, TYPES, formatDue, priorityOf, roleAtLeast, timeAgo } from '../lib/format.js';
import { addDays as addDayKey, todayKey } from '../lib/days.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { SearchHelp, SearchUnderstood } from '../components/SetupSettings.jsx';
import { Avatar, Badge, Button, EmptyState, Spinner, TypeIcon } from '../components/ui.jsx';
import { ProjectMissing } from '../components/states.jsx';
import { EmptyNote, KeyChip } from '../ds/core.jsx';

// Keyboard-only triage (E4D): one ticket at a time, every decision a key press.
const QUEUES = [
  { key: 'owner', label: 'Needs an owner', q: 'is:open is:unassigned' },
  { key: 'inbox', label: 'Inbox: public reports and app crashes', triage: true },
  { key: 'new', label: 'New this week', q: 'is:open created:<7d' },
  { key: 'custom', label: 'My own search' },
];
const PRIORITY_KEYS = { 1: 'critical', 2: 'high', 3: 'medium', 4: 'low' };
const TYPE_KEYS = { b: 'bug', f: 'feature', t: 'task' };

const HELP = [
  ['j / k', 'next / previous ticket (or the arrow keys)'],
  ['1 2 3 4', 'priority: critical, high, medium, low'],
  ['b f t', 'type: bug, feature, task'],
  ['m / u', 'assign to me / unassign'],
  ['a', 'assign to someone (then a number)'],
  ['s', 'move to a column (then a number)'],
  ['d', 'due date: then 0 today, 1 tomorrow, 3 in 3 days, w in a week, x clear'],
  ['l', 'add a label (type it, or a number for a team label)'],
  ['Enter', 'accept a public report onto the board'],
  ['Delete', 'move the ticket to the bin (with undo)'],
  ['o', 'open the full ticket'],
  ['?', 'show or hide these keys'],
];

const typing = (el) => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
const Key = ({ children }) => <kbd className="rounded-hair border border-line-strong bg-hover px-1.5 py-0.5 font-code text-micro  ">{children}</kbd>;

export default function TriagePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: project, error } = useProject(projectId);
  const [queue, setQueue] = useState('owner');
  const [custom, setCustom] = useState('is:open');
  const [customQ, setCustomQ] = useState('is:open');
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState(null); // 'assign' | 'status' | 'due' | 'label'
  const [labelText, setLabelText] = useState('');
  const [help, setHelp] = useState(false);
  const [advance, setAdvance] = useState(false);
  const [touched, setTouched] = useState(new Set());
  const labelRef = useRef(null);
  const q = QUEUES.find((x) => x.key === queue);
  const params = q.triage ? 'triage=true' : `q=${encodeURIComponent(queue === 'custom' ? customQ : q.q)}`;
  const { data, isFetching } = useQuery({
    queryKey: ['triage', projectId, params],
    queryFn: () => api(`/projects/${projectId}/tickets?${params}&sort=oldest&limit=200`),
    enabled: Boolean(project),
    refetchOnWindowFocus: false,
  });
  // The queue stays put while you work through it (changed tickets don't jump out of it).
  useEffect(() => {
    if (!data) return;
    setItems(data.tickets);
    setIndex(0);
    setTouched(new Set());
  }, [data]);
  const { data: labels } = useQuery({ queryKey: ['labels', projectId], queryFn: () => api(`/projects/${projectId}/labels`).then((d) => d.labels), enabled: Boolean(project) });

  const ticket = items[index];
  const canWork = roleAtLeast(project?.myRole, 'developer');
  const workers = useMemo(() => (project?.members ?? []).filter((m) => m.role !== 'viewer'), [project]);
  const teamLabels = useMemo(() => (labels ?? []).map((l) => l.label).filter((l) => !ticket?.labels.includes(l)).slice(0, 9), [labels, ticket]);

  const replace = useCallback((nextTicket) => {
    setItems((list) => list.map((x) => (x.number === nextTicket.number ? { ...x, ...nextTicket } : x)));
    setTouched((s) => new Set(s).add(nextTicket.number));
    qc.invalidateQueries({ queryKey: qk.tickets(projectId) });
  }, [qc, projectId]);
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0))), [items.length]);

  const change = useCallback(async (body, said) => {
    if (!ticket) return;
    try {
      const res = await api(`/projects/${projectId}/tickets/${ticket.key}`, { method: 'PATCH', body });
      replace(res.ticket);
      toast.success(`${ticket.key}: ${said}`, { id: 'triage' });
      if (advance) next();
    } catch (e) { toast.error(e.message, { id: 'triage' }); }
  }, [ticket, projectId, replace, advance, next]);

  const accept = useCallback(async () => {
    if (!ticket?.triage) return;
    try {
      const res = await api(`/projects/${projectId}/tickets/${ticket.key}/accept`, { method: 'POST' });
      replace(res.ticket);
      toast.success(`${ticket.key} is on the board`, { id: 'triage' });
      if (advance) next();
    } catch (e) { toast.error(e.message, { id: 'triage' }); }
  }, [ticket, projectId, replace, advance, next]);

  const remove = useCallback(async () => {
    if (!ticket) return;
    const gone = ticket;
    try {
      await api(`/projects/${projectId}/tickets/${gone.key}`, { method: 'DELETE' });
      setItems((list) => list.filter((x) => x.number !== gone.number));
      setIndex((i) => Math.max(0, Math.min(i, items.length - 2)));
      qc.invalidateQueries({ queryKey: qk.tickets(projectId) });
      toast((tt) => (
        <span className="flex items-center gap-2"><KeyChip>{gone.key}</KeyChip> moved to the bin
          <Button size="sm" onClick={async () => {
            toast.dismiss(tt.id);
            try {
              const res = await api(`/projects/${projectId}/tickets/${gone.key}/restore`, { method: 'POST' });
              setItems((list) => [...list, res.ticket].sort((x, y) => x.number - y.number));
              toast.success(`${gone.key} restored`);
            } catch (e) { toast.error(e.message); }
          }}>Undo</Button>
        </span>
      ), { duration: 6000 });
    } catch (e) { toast.error(e.message, { id: 'triage' }); }
  }, [ticket, projectId, items.length, qc]);

  const addLabels = useCallback((list) => {
    const extra = [...new Set(list.map((l) => l.trim().toLowerCase()).filter((l) => l && !ticket.labels.includes(l)))];
    setMode(null);
    setLabelText('');
    if (extra.length) change({ labels: [...ticket.labels, ...extra] }, `labelled ${extra.join(', ')}`);
  }, [ticket, change]);

  useEffect(() => { if (mode === 'label') labelRef.current?.focus(); }, [mode]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = e.key;
      if (k === '?') { setHelp((h) => !h); e.preventDefault(); return; }
      if (k === 'Escape') { setMode(null); setHelp(false); return; }
      if (!ticket) return;
      const done = () => e.preventDefault();
      if (mode === 'assign') {
        const m = workers[Number(k) - 1];
        if (m) { done(); setMode(null); change({ assigneeId: m.user.id }, `assigned to ${m.user.name}`); }
        return;
      }
      if (mode === 'status') {
        const s = project.statuses[Number(k) - 1];
        if (s) { done(); setMode(null); change({ status: s.key }, `moved to ${s.name}`); }
        return;
      }
      if (mode === 'due') {
        const days = { 0: 0, 1: 1, 3: 3, w: 7 }[k];
        if (days !== undefined) { done(); setMode(null); const day = addDayKey(todayKey(), days); change({ dueDate: day }, `due ${formatDue(day)}`); }
        if (k === 'x') { done(); setMode(null); change({ dueDate: null }, 'no due date'); }
        return;
      }
      if (mode === 'label') return;
      if (['j', 'ArrowDown', 'ArrowRight'].includes(k)) { done(); next(); return; }
      if (['k', 'ArrowUp', 'ArrowLeft'].includes(k)) { done(); setIndex((i) => Math.max(0, i - 1)); return; }
      if (k === 'o') { done(); navigate(`/projects/${projectId}/tickets/${ticket.key}`); return; }
      if (!canWork) return;
      if (PRIORITY_KEYS[k]) { done(); change({ priority: PRIORITY_KEYS[k] }, `priority ${priorityOf(PRIORITY_KEYS[k]).label}`); return; }
      if (TYPE_KEYS[k]) { done(); change({ type: TYPE_KEYS[k] }, `now a ${TYPE_KEYS[k]}`); return; }
      if (k === 'm') { done(); change({ assigneeId: user.id }, 'assigned to you'); return; }
      if (k === 'u') { done(); change({ assigneeId: null }, 'unassigned'); return; }
      if (k === 'a') { done(); setMode('assign'); return; }
      if (k === 's') { done(); setMode('status'); return; }
      if (k === 'd') { done(); setMode('due'); return; }
      if (k === 'l') { done(); setMode('label'); return; }
      if (k === 'Enter') { done(); accept(); return; }
      if (k === 'Delete' || k === 'Backspace') { done(); remove(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ticket, mode, workers, project, change, accept, remove, next, canWork, user, navigate, projectId]);

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <div className="grid h-full place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  const status = project.statuses.find((s) => s.key === ticket?.status);

  return (
    <div>
      <PageHeader crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Triage' }]} title={<ProjectSwitcher project={project} />}>
        <ProjectTabs projectId={projectId} />
      </PageHeader>
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input h-8 w-auto text-small" value={queue} onChange={(e) => setQueue(e.target.value)} aria-label="Which tickets">
            {QUEUES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
          {queue === 'custom' && (
            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setCustomQ(custom.trim()); }}>
              <input className="input h-8 w-64 text-small" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="type:bug is:open" aria-label="Search for the triage queue" />
              <Button size="sm" type="submit">Use</Button>
              <SearchHelp />
            </form>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-caption text-fg-subtle">
            <input type="checkbox" className="size-4 accent-accent" checked={advance} onChange={(e) => setAdvance(e.target.checked)} />Go to the next ticket after each change
          </label>
          <Button size="sm" variant="ghost" onClick={() => setHelp((h) => !h)} aria-pressed={help}><Keyboard className="size-4" />Keys</Button>
        </div>
        {queue === 'custom' && <SearchUnderstood search={data?.search} />}
        {!canWork && <p className="text-small text-fg-subtle">Viewers can look through the queue but not change tickets.</p>}

        {help && (
          <section className="card p-4" aria-label="Keyboard keys">
            <dl className="grid gap-x-4 gap-y-1.5 text-small sm:grid-cols-[auto_1fr]">
              {HELP.map(([k, t]) => <div key={k} className="contents"><dt><Key>{k}</Key></dt><dd className="text-fg-muted">{t}</dd></div>)}
            </dl>
          </section>
        )}

        {isFetching && !items.length && <div className="grid place-items-center py-16"><Spinner className="size-5 text-fg-subtle" /></div>}
        {data && !items.length && <EmptyState title={q.triage ? 'All triaged' : 'Nothing in this queue'}>{q.triage ? 'No public reports or app crashes are waiting. Enjoy the quiet.' : 'No tickets match this queue right now.'}</EmptyState>}

        {ticket && (
          <>
            <div className="flex items-center gap-2 text-small text-fg-subtle">
              <Button size="icon" variant="ghost" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label="Previous ticket"><ChevronLeft className="size-4" /></Button>
              <span className="tabular-nums">{index + 1} of {items.length}</span>
              <Button size="icon" variant="ghost" onClick={next} disabled={index >= items.length - 1} aria-label="Next ticket"><ChevronRight className="size-4" /></Button>
              <span className="ml-2">{touched.size} changed so far</span>
              <span className="ml-auto text-caption">Press <Key>?</Key> for keys</span>
            </div>
            <article className="card p-5" aria-label={`${ticket.key} ${ticket.title}`}>
              <div className="flex items-center gap-2 text-caption text-fg-subtle">
                <TypeIcon type={ticket.type} /><KeyChip>{ticket.key}</KeyChip>
                {ticket.triage && <Badge tone="amber">{ticket.source === 'sdk' ? 'App crash' : 'Public report'}, not on the board yet</Badge>}
                <span>· created {timeAgo(ticket.createdAt)}</span>
              </div>
              <h1 className="mt-1.5 text-h2 font-semibold text-fg">{ticket.title}</h1>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-small sm:grid-cols-5">
                <div><dt className="text-caption text-fg-subtle">Type</dt><dd>{TYPES.find((x) => x.key === ticket.type)?.label}</dd></div>
                <div><dt className="text-caption text-fg-subtle">Priority</dt><dd className={priorityOf(ticket.priority).text}>{priorityOf(ticket.priority).label}</dd></div>
                <div><dt className="text-caption text-fg-subtle">Column</dt><dd>{status?.name ?? ticket.status}</dd></div>
                <div><dt className="text-caption text-fg-subtle">Assignee</dt><dd className="flex items-center gap-1.5">{ticket.assignee ? <><Avatar user={ticket.assignee} size="sm" />{ticket.assignee.name}</> : 'Nobody'}</dd></div>
                <div><dt className="text-caption text-fg-subtle">Due</dt><dd>{ticket.dueDate ? formatDue(ticket.dueDate) : 'No date'}</dd></div>
              </dl>
              <div className="mt-2 flex flex-wrap gap-1">{ticket.labels.map((l) => <Badge key={l}>{l}</Badge>)}</div>
              <div className="mt-4 max-h-72 overflow-y-auto border-t border-line pt-3 text-small ">
                {ticket.description ? <Markdown text={ticket.description} /> : <EmptyNote size="xs">No description.</EmptyNote>}
              </div>
            </article>

            {mode && (
              <section className="card border-key-line p-4" aria-live="polite">
                {mode === 'assign' && (
                  <>
                    <p className="mb-2 text-small font-medium">Assign to… (press a number, Esc to cancel)</p>
                    <ol className="grid gap-1 text-small sm:grid-cols-3">{workers.slice(0, 9).map((m, i) => <li key={m.user.id}><Key>{i + 1}</Key> {m.user.name}</li>)}</ol>
                  </>
                )}
                {mode === 'status' && (
                  <>
                    <p className="mb-2 text-small font-medium">Move to… (press a number, Esc to cancel)</p>
                    <ol className="grid gap-1 text-small sm:grid-cols-3">{project.statuses.slice(0, 9).map((s, i) => <li key={s.key}><Key>{i + 1}</Key> {s.name}</li>)}</ol>
                  </>
                )}
                {mode === 'due' && (
                  <p className="text-small"><span className="font-medium">Due…</span> <Key>0</Key> today · <Key>1</Key> tomorrow · <Key>3</Key> in 3 days · <Key>w</Key> in a week · <Key>x</Key> no date · <Key>Esc</Key> cancel</p>
                )}
                {mode === 'label' && (
                  <form onSubmit={(e) => { e.preventDefault(); addLabels(labelText.split(',')); }}>
                    <p className="mb-2 text-small font-medium">Add labels (comma separated, Enter to add, Esc to cancel)</p>
                    <input
                      ref={labelRef} className="input h-9 text-small" value={labelText} aria-label="Labels to add"
                      onChange={(e) => setLabelText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setMode(null); setLabelText(''); }
                        if (!labelText && /^[1-9]$/.test(e.key) && teamLabels[Number(e.key) - 1]) { e.preventDefault(); addLabels([teamLabels[Number(e.key) - 1]]); }
                      }}
                    />
                    {teamLabels.length > 0 && <p className="mt-2 flex flex-wrap gap-2 text-caption text-fg-subtle">{teamLabels.map((l, i) => <span key={l}><Key>{i + 1}</Key> {l}</span>)}</p>}
                  </form>
                )}
              </section>
            )}
            {!mode && canWork && (
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-fg-subtle">
                {PRIORITIES.map((p, i) => <span key={p.key}><Key>{i + 1}</Key> {p.label}</span>)}
                <span><Key>m</Key> me</span><span><Key>a</Key> assign</span><span><Key>s</Key> column</span><span><Key>d</Key> due</span><span><Key>l</Key> label</span>
                {ticket.triage && <span><Key>Enter</Key> accept</span>}<span><Key>Del</Key> bin</span><span><Key>j</Key>/<Key>k</Key> next/previous</span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
