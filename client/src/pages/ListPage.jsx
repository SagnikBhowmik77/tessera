import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, FileUp, Inbox, Minus, Search, SlidersHorizontal, Trash2, Users, X } from 'lucide-react';
import { BulkBar, ExportButton, ImportDialog } from '../components/BulkActions.jsx';
import { api } from '../lib/api.js';
import { qk, useProject, useProjectLive, useTickets } from '../lib/queries.js';
import { PRIORITIES, TYPES, dueState, formatDue, roleAtLeast, timeAgo } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader, ProjectSwitcher } from '../components/AppShell.jsx';
import ProjectTabs from '../components/ProjectTabs.jsx';
import { SearchHelp, SearchUnderstood } from '../components/SetupSettings.jsx';
import TicketDrawer from '../components/LazyTicketDrawer.jsx';
import {
  Avatar, Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, KeyChip, Menu, MenuItem, PriorityMark, STATUS_META, Segmented, Select, Skeleton,
  StatusPill, Toggle, TypeMark,
} from '../ds/index.jsx';
import { ProjectMissing } from '../components/states.jsx';

// Filters that make up a view (and a saved view). They live in the address bar, so a
// filtered list can be bookmarked or shared as a link.
const VIEW_KEYS = ['status', 'priority', 'type', 'assignee', 'reporter', 'label', 'open', 'due', 'dueFrom', 'dueTo', 'q', 'sort', 'triage', 'sprint', 'milestone', 'sla'];
const SORTS = [
  ['updated', 'Recently updated'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['priority', 'Priority'],
  ['due', 'Due date'], ['number', 'Number'], ['relevance', 'Best match'],
].map(([value, label]) => ({ value, label }));
const DUE = [
  ['', 'Any due date'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due this week'], ['none', 'No due date'],
].map(([value, label]) => ({ value, label }));
const SLA = [['', 'Any service level'], ['breached', 'Past an SLA target'], ['at_risk', 'SLA due soon']].map(([value, label]) => ({ value, label }));

// A row checkbox (with the "some selected" state the header box needs).
function TickBox({ checked, indeterminate, onChange, label }) {
  return (
    <span className="grid shrink-0 place-items-center">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        ref={(el) => { if (el) el.indeterminate = Boolean(indeterminate); }}
        onChange={onChange}
        className="ds-focus peer col-start-1 row-start-1 m-0 size-4 cursor-pointer appearance-none rounded-hair border border-line-strong bg-field transition-colors duration-(--dur-fast) checked:border-transparent checked:ds-gradient indeterminate:border-transparent indeterminate:bg-fg-muted"
      />
      {indeterminate
        ? <Minus className="pointer-events-none col-start-1 row-start-1 size-3 text-canvas" strokeWidth={3.25} aria-hidden />
        : <Check className="pointer-events-none col-start-1 row-start-1 size-3 text-on-gradient opacity-0 peer-checked:opacity-100" strokeWidth={3.25} aria-hidden />}
    </span>
  );
}

function SaveViewDialog({ open, onClose, project, query, onSaved }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(''); setShared(false); setError(''); } }, [open]);
  const save = async () => {
    setBusy(true);
    try {
      const { filter } = await api(`/projects/${project.id}/filters`, { method: 'POST', body: { name, query, shared } });
      onSaved(filter);
      onClose();
    } catch (e) { setError(e.fieldErrors().name ?? e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save this view"
      description="The filters, search and sort you have now, under a name."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save view</Button></>}
    >
      <div className="space-y-4">
        <Field label="Name" error={error}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My open bugs" maxLength={60} /></Field>
        <Checkbox
          checked={shared}
          onChange={(e) => setShared(e.target.checked)}
          label="Share with the project"
          description={'Everyone sees it. "Me" in a shared view means whoever opens it.'}
        />
      </div>
    </Dialog>
  );
}

// While tickets load: the shape of the rows.
function RowsSkeleton() {
  return (
    <div className="space-y-px px-4 py-2 sm:px-6" aria-busy="true" aria-label="Loading tickets">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 py-2.5">
          <Skeleton className="size-4" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-5 w-24 sm:block" />
        </div>
      ))}
    </div>
  );
}

export default function ListPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const { data: project, error } = useProject(projectId);
  const onDeleted = useCallback(() => { toast('This project was deleted, so you are back on your projects.'); navigate('/projects'); }, [navigate]);
  useProjectLive(projectId, { onProjectDeleted: onDeleted });

  const view = Object.fromEntries([...sp].filter(([k]) => VIEW_KEYS.includes(k)));
  const bin = sp.get('bin') === '1';
  const page = Number(sp.get('page') || 1);
  const query = { sort: 'updated', limit: '50', page: String(page), ...view, ...(bin && { deleted: 'true' }) };
  const { data, isLoading } = useTickets(projectId, query);
  const { data: labels } = useQuery({ queryKey: ['labels', projectId], queryFn: () => api(`/projects/${projectId}/labels`).then((d) => d.labels), enabled: Boolean(project) });
  const { data: saved } = useQuery({ queryKey: ['filters', projectId], queryFn: () => api(`/projects/${projectId}/filters`).then((d) => d.filters), enabled: Boolean(project) });
  const { data: triageCount } = useQuery({
    queryKey: [...qk.tickets(projectId), 'triage-count'],
    queryFn: () => api(`/projects/${projectId}/tickets?triage=true&limit=1`).then((d) => d.total),
    enabled: Boolean(project),
  });

  const [search, setSearch] = useState(sp.get('q') ?? '');
  const [saving, setSaving] = useState(false);
  // Ticked tickets (by number) for bulk changes. A new filter or page starts a fresh selection.
  const [selected, setSelected] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  // The full set of filters opens under the bar on demand; the ones in use are always shown as chips.
  const [showFilters, setShowFilters] = useState(false);
  const viewKey = sp.toString().replace(/(^|&)ticket=[^&]*/, '');
  useEffect(() => { setSelected(new Set()); }, [viewKey]);
  const tick = (n) => setSelected((s) => { const next = new Set(s); if (next.has(n)) next.delete(n); else next.add(n); return next; });
  const update = (changes) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) { if (v === '' || v === null || v === undefined) next.delete(k); else next.set(k, v); }
    if (!('page' in changes)) next.delete('page');
    setSp(next, { replace: true });
  };
  useEffect(() => {
    const id = setTimeout(() => { if ((sp.get('q') ?? '') !== search.trim()) update({ q: search.trim() }); }, 300);
    return () => clearTimeout(id);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (key, value) => {
    const cur = (sp.get(key) || '').split(',').filter(Boolean);
    update({ [key]: (cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]).join(',') });
  };
  const has = (key, value) => (sp.get(key) || '').split(',').includes(value);
  const applySaved = (f) => setSp(new URLSearchParams(f.query), { replace: true });
  const refresh = () => qc.invalidateQueries({ queryKey: qk.tickets(projectId) });
  const act = async (path, label) => {
    try { await api(path, { method: path.endsWith('/accept') || path.endsWith('/restore') ? 'POST' : 'DELETE' }); toast.success(label); refresh(); } catch (e) { toast.error(e.message); }
  };

  if (error) return <ProjectMissing error={error} />;
  if (!project) return <RowsSkeleton />;

  const statusOf = (key) => project.statuses.find((s) => s.key === key);
  const isDev = roleAtLeast(project.myRole, 'developer') && !project.archivedAt;
  const triage = sp.get('triage') === 'true';
  const filtered = Object.keys(view).some((k) => k !== 'sort');
  const openKey = sp.get('ticket');
  const total = data?.total ?? 0;
  const from = total ? (page - 1) * 50 + 1 : 0;
  const tickets = data?.tickets ?? [];
  const allOnPage = tickets.length > 0 && tickets.every((t) => selected.has(t.number));
  const someOnPage = tickets.some((t) => selected.has(t.number)) && !allOnPage;
  const canSelect = isDev && !triage;
  const assigneeOptions = [
    { value: '', label: 'Anyone' }, { value: 'me', label: 'Me' }, { value: 'none', label: 'Unassigned' },
    ...project.members.filter((m) => m.role !== 'viewer' && m.user.id !== user.id).map((m) => ({ value: m.user.id, label: m.user.name, leading: <Avatar name={m.user.name} id={m.user.id} size="sm" /> })),
  ];
  const labelOptions = [{ value: '', label: 'Any label' }, ...(labels ?? []).map((l) => ({ value: l.label, label: `${l.label} (${l.count})` }))];
  const clearAll = () => { setSearch(''); setSp(new URLSearchParams(), { replace: true }); };
  // The filters in use, as chips with words (status, priority, type, person, due date, service level, label).
  const nameOf = { status: (k) => statusOf(k)?.name ?? k, priority: (k) => PRIORITIES.find((p) => p.key === k)?.label ?? k, type: (k) => TYPES.find((t) => t.key === k)?.label ?? k };
  const inUse = [
    ...['status', 'priority', 'type'].flatMap((key) => (sp.get(key) ?? '').split(',').filter(Boolean).map((v) => ({ key: `${key}:${v}`, label: nameOf[key](v), remove: () => toggle(key, v) }))),
    ...[['assignee', assigneeOptions], ['due', DUE], ['sla', SLA], ['label', labelOptions]]
      .filter(([key]) => sp.get(key))
      .map(([key, opts]) => ({ key, label: opts.find((o) => o.value === sp.get(key))?.label ?? sp.get(key), remove: () => update({ [key]: '' }) })),
  ];

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'List' }]}
        title={<ProjectSwitcher project={project} />}
        actions={(
          <>
            {saved?.length > 0 && (
              <Menu
                label="Saved views"
                align="end"
                width="w-64"
                trigger={(props, open) => (
                  <Button size="sm" variant="ghost" icon={Bookmark} {...props}>
                    Saved views<ChevronDown className={clsx('size-3.5 transition-transform duration-(--dur-fast)', open && 'rotate-180')} aria-hidden />
                  </Button>
                )}
              >
                {saved.map((f) => (
                  <MenuItem key={f.id} icon={f.mine ? Bookmark : Users} onClick={() => applySaved(f)}
                    trailing={f.mine ? null : <span className="truncate text-caption text-fg-subtle">{f.owner?.name ?? 'shared'}</span>}>
                    {f.name}
                  </MenuItem>
                ))}
              </Menu>
            )}
            <Button size="sm" icon={Bookmark} onClick={() => setSaving(true)} disabled={!filtered}>Save view</Button>
            <ExportButton project={project} query={query} />
            {isDev && <Button size="sm" icon={FileUp} onClick={() => setImporting(true)}>Import CSV</Button>}
          </>
        )}
      >
        <ProjectTabs projectId={projectId} />
      </PageHeader>

      <div className="space-y-2.5 border-b border-line px-4 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-72">
            <Input size="sm" icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search, or ${project.key}-12`} aria-label="Search tickets" />
          </div>
          <SearchHelp />
          <Select size="sm" className="w-44" value={sp.get('sort') ?? 'updated'} onChange={(v) => update({ sort: v === 'updated' ? '' : v })} options={SORTS} aria-label="Sort" />
          <Segmented size="sm" label="Open or done" value={sp.get('open') ?? ''} onChange={(v) => update({ open: v })}
            options={[{ value: '', label: 'All' }, { value: 'true', label: 'Open' }, { value: 'false', label: 'Done' }]} />
          <Toggle pressed={triage} icon={Inbox} onChange={() => update({ triage: triage ? '' : 'true', bin: '' })}>Triage{triageCount ? ` · ${triageCount}` : ''}</Toggle>
          <Toggle pressed={bin} icon={Trash2} onChange={() => update({ bin: bin ? '' : '1', triage: '' })}>Bin</Toggle>
          <Button size="sm" icon={SlidersHorizontal} aria-expanded={showFilters} aria-controls="list-filters" onClick={() => setShowFilters((v) => !v)}>
            Filter{inUse.length ? <span className="ml-0.5 rounded-full bg-key-bg px-1.5 text-micro font-semibold tabular-nums text-key">{inUse.length}</span> : null}
          </Button>
          {/* The filters in use, each removable on its own (the full set is behind "Filter"). */}
          {inUse.map((c) => (
            <button key={c.key} type="button" onClick={c.remove} aria-label={`Remove filter: ${c.label}`}
              className="ds-focus flex h-7 items-center gap-1 rounded-full border border-key-line bg-key-bg pl-2.5 pr-1.5 text-caption font-medium text-fg transition-colors duration-(--dur-fast) hover:border-key">
              {c.label}<X className="size-3.5 text-fg-subtle" aria-hidden />
            </button>
          ))}
          {(filtered || bin) && <Button size="sm" variant="ghost" icon={X} onClick={clearAll}>Clear filters</Button>}
        </div>
        {showFilters && (
        <div id="list-filters" className="ds-drop space-y-2.5">
        {/* Chips scroll sideways on a phone; the pickers below wrap, so their menus are never clipped. */}
        <div role="group" aria-label="Filter by status, priority and type" className="ds-scroll -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {project.statuses.map((s) => {
            const meta = STATUS_META[s.category] ?? STATUS_META.todo;
            const on = has('status', s.key);
            return (
              <Toggle key={s.key} pressed={on} onChange={() => toggle('status', s.key)}>
                <meta.Icon className={clsx('size-3.5 shrink-0', !on && meta.tone)} strokeWidth={2.25} aria-hidden />{s.name}
              </Toggle>
            );
          })}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
          {PRIORITIES.map((p) => {
            const on = has('priority', p.key);
            return (
              <Toggle key={p.key} pressed={on} onChange={() => toggle('priority', p.key)}>
                <PriorityMark priority={p.key} className={clsx(on && 'text-canvas [&_svg]:text-canvas')} />{p.label}
              </Toggle>
            );
          })}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
          {TYPES.map((t) => {
            const on = has('type', t.key);
            return (
              <Toggle key={t.key} pressed={on} onChange={() => toggle('type', t.key)}>
                <TypeMark type={t.key} className={clsx('size-3.5', on && 'text-canvas')} />{t.label}
              </Toggle>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select size="sm" className="w-44" value={sp.get('assignee') ?? ''} onChange={(v) => update({ assignee: v })} options={assigneeOptions} aria-label="Assignee" />
          <Select size="sm" className="w-40" value={sp.get('due') ?? ''} onChange={(v) => update({ due: v })} options={DUE} aria-label="Due date" />
          {project.sla?.enabled && <Select size="sm" className="w-44" value={sp.get('sla') ?? ''} onChange={(v) => update({ sla: v })} options={SLA} aria-label="Service level" />}
          {labels?.length > 0 && <Select size="sm" className="w-44" value={sp.get('label') ?? ''} onChange={(v) => update({ label: v })} options={labelOptions} aria-label="Label" />}
        </div>
        </div>
        )}
      </div>

      <div className="flex-1">
        {isLoading && <RowsSkeleton />}
        {data && total === 0 && (
          <EmptyState
            icon={triage ? Inbox : bin ? Trash2 : Search}
            title={triage ? 'Inbox zero' : bin ? 'Nothing in the bin' : filtered ? 'Nothing matches these filters' : 'No tickets yet'}
            action={filtered && !triage && !bin ? <Button icon={X} onClick={clearAll}>Clear filters</Button> : null}
          >
            {triage ? 'Reports sent through the public portal wait here until someone accepts them. None are waiting.' : bin ? 'Deleted tickets land here, and you can restore them from this list.' : filtered ? 'Loosen a filter or two and they will show up.' : 'Create one from the board and it will be listed here.'}
          </EmptyState>
        )}
        {data?.search && <SearchUnderstood search={data.search} className="px-4 pt-3 sm:px-6" />}
        {data?.search && total > 0 && data.search.mode !== 'filters' && (
          <p className="px-4 pt-2 text-caption text-fg-subtle sm:px-6">
            {data.search.mode === 'key' ? 'Jumped to the ticket with that number.' : data.search.mode === 'partial' ? 'No whole-word matches, showing partial matches.' : 'Whole-word matches, best first when sorted by best match.'}
          </p>
        )}
        {total > 0 && (
          <table className="w-full table-fixed border-separate border-spacing-0 text-small">
            <caption className="sr-only">Tickets in {project.name}{filtered ? ', filtered' : ''}: {total}</caption>
            <thead className="sticky top-0 z-10 bg-canvas/90 backdrop-blur-md">
              <tr className="text-left text-micro font-medium uppercase tracking-wider text-fg-subtle">
                {canSelect && (
                  <th scope="col" className="w-10 border-b border-line py-2 pl-4 sm:w-12 sm:pl-6">
                    <TickBox
                      label={`Select all ${tickets.length} on this page`}
                      checked={allOnPage}
                      indeterminate={someOnPage}
                      onChange={(e) => setSelected((s) => { const next = new Set(s); for (const t of tickets) { if (e.target.checked) next.add(t.number); else next.delete(t.number); } return next; })}
                    />
                  </th>
                )}
                <th scope="col" className={clsx('border-b border-line py-2 font-medium', !canSelect && 'pl-4 sm:pl-6')}>Ticket</th>
                <th scope="col" className="hidden w-36 border-b border-line py-2 font-medium sm:table-cell">Status</th>
                <th scope="col" className="hidden w-24 border-b border-line py-2 font-medium sm:table-cell">Priority</th>
                <th scope="col" className="hidden w-20 border-b border-line py-2 font-medium md:table-cell">Due</th>
                <th scope="col" className="hidden w-24 border-b border-line py-2 font-medium lg:table-cell">Updated</th>
                <th scope="col" className="w-12 border-b border-line py-2 pr-4 font-medium sm:w-14 sm:pr-6"><span className="sr-only">Assignee</span></th>
                {(triage || bin) && isDev && <th scope="col" className="w-40 border-b border-line py-2 pr-4 sm:pr-6"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => {
                const status = statusOf(t.status);
                const done = status?.category === 'done';
                const due = dueState(t.dueDate, done);
                const on = selected.has(t.number);
                const cell = 'border-b border-line py-2.5 compact:py-1.5';
                return (
                  <tr key={t.id} className={clsx('transition-colors duration-(--dur-fast)', on ? 'bg-press' : 'hover:bg-hover')}>
                    {canSelect && <td className={clsx(cell, 'pl-4 sm:pl-6')}><TickBox checked={on} onChange={() => tick(t.number)} label={`Select ${t.key}`} /></td>}
                    <td className={clsx(cell, 'pr-3', !canSelect && 'pl-4 sm:pl-6')}>
                      <button type="button" onClick={() => update({ ticket: t.key, page: String(page) })} className="ds-focus flex w-full min-w-0 items-center gap-2.5 rounded-tile text-left">
                        <TypeMark type={t.type} />
                        <KeyChip>{t.key}</KeyChip>
                        <span className={clsx('min-w-0 flex-1 truncate font-medium', done ? 'text-fg-muted' : 'text-fg')}>
                          {done && <CircleCheck className="mr-1 inline size-3.5 -translate-y-px text-status-done" role="img" aria-label="Done" />}
                          {t.title}
                        </span>
                        <span className="hidden shrink-0 gap-1 xl:flex">{t.labels.slice(0, 2).map((l) => <Badge key={l}>{l}</Badge>)}</span>
                      </button>
                    </td>
                    <td className={clsx(cell, 'hidden pr-3 sm:table-cell')}>{status && <StatusPill status={status.category} label={status.name} size="sm" className="max-w-full" />}</td>
                    <td className={clsx(cell, 'hidden sm:table-cell')}><PriorityMark priority={t.priority} withLabel /></td>
                    <td className={clsx(cell, 'hidden text-caption md:table-cell')}>
                      {t.dueDate && (due === 'overdue' || due === 'today'
                        ? <Badge tone={due === 'overdue' ? 'danger' : 'warning'}>{formatDue(t.dueDate)}</Badge>
                        : <span className="text-fg-subtle">{formatDue(t.dueDate)}</span>)}
                    </td>
                    <td className={clsx(cell, 'hidden text-caption text-fg-subtle lg:table-cell')}>{timeAgo(t.updatedAt)}</td>
                    <td className={clsx(cell, 'pr-4 sm:pr-6')}>{t.assignee && <span className="flex justify-end"><Avatar name={t.assignee.name} id={t.assignee.id} size="sm" /></span>}</td>
                    {(triage || bin) && isDev && (
                      <td className={clsx(cell, 'pr-4 sm:pr-6')}>
                        <span className="flex justify-end gap-1">
                          {triage && <Button size="sm" variant="primary" onClick={() => act(`/projects/${projectId}/tickets/${t.number}/accept`, `${t.key} is on the board`)}>Accept</Button>}
                          {triage && <Button size="sm" variant="ghost" onClick={() => act(`/projects/${projectId}/tickets/${t.number}`, `${t.key} rejected (in the bin)`)}>Reject</Button>}
                          {bin && <Button size="sm" onClick={() => act(`/projects/${projectId}/tickets/${t.number}/restore`, `${t.key} restored`)}>Restore</Button>}
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {total > 50 && (
          <nav aria-label="Pages" className="flex items-center justify-between px-4 py-3 text-caption text-fg-subtle sm:px-6">
            <span className="font-code">{from}–{Math.min(page * 50, total)} of {total}</span>
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={page >= (data?.pages ?? 1)} onClick={() => update({ page: String(page + 1) })}>Next<ChevronRight className="size-3.5" aria-hidden /></Button>
            </span>
          </nav>
        )}
      </div>

      {selected.size > 0 && (
        <BulkBar
          project={project} selected={selected} bin={bin} labels={labels}
          onClear={() => setSelected(new Set())}
          onDone={(_result, action) => {
            refresh();
            qc.invalidateQueries({ queryKey: ['labels', projectId] });
            if (action !== 'update') setSelected(new Set());
          }}
        />
      )}
      <ImportDialog project={project} open={importing} onClose={() => setImporting(false)} onImported={() => { refresh(); qc.invalidateQueries({ queryKey: ['labels', projectId] }); }} />
      {openKey && <TicketDrawer project={project} number={Number(openKey.split('-').pop())} userId={user.id} onClose={() => update({ ticket: '', page: String(page) })} />}
      <SaveViewDialog
        open={saving}
        onClose={() => setSaving(false)}
        project={project}
        query={view}
        onSaved={(f) => { qc.invalidateQueries({ queryKey: ['filters', projectId] }); toast.success(`Saved "${f.name}"`); }}
      />
    </div>
  );
}
