import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import { CornerDownLeft, FolderKanban, ListTodo, Moon, Search } from 'lucide-react';
import { api } from '../lib/api.js';
import { useProjects } from '../lib/queries.js';
import { KeyChip, Kbd, Spinner, TypeMark } from '../ds/core.jsx';

// Ctrl/Cmd+K: jump to a page, a project, or a ticket in the project you're in.
export default function CommandPalette({ onToggleTheme }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [tickets, setTickets] = useState([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: projects } = useProjects();
  const projectId = /^\/projects\/([a-f0-9]{24})/.exec(pathname)?.[1];

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('tessera:palette', onOpen);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('tessera:palette', onOpen); };
  }, []);
  // Cleared on close, so nothing typed straight after opening is wiped.
  useEffect(() => { if (!open) { setQ(''); setActive(0); } }, [open]);
  useEffect(() => {
    if (!open || !projectId || q.trim().length < 2) { setTickets([]); setSearching(false); return undefined; }
    const ctrl = new AbortController();
    setSearching(true);
    const id = setTimeout(() => {
      api(`/projects/${projectId}/tickets?${new URLSearchParams({ q: q.trim(), sort: 'relevance', limit: '6' })}`, { signal: ctrl.signal })
        .then((d) => setTickets(d.tickets))
        .catch(() => { if (!ctrl.signal.aborted) setTickets([]); })
        .finally(() => { if (!ctrl.signal.aborted) setSearching(false); });
    }, 200);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [q, open, projectId]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s) => !needle || s.toLowerCase().includes(needle);
    return [
      ...tickets.map((t) => ({ id: t.id, label: t.title, hint: t.key, ticket: true, icon: <TypeMark type={t.type} />, run: () => navigate(`/projects/${projectId}/tickets/${t.key}`) })),
      ...[
        { id: 'my-work', label: 'My work', icon: <ListTodo className="size-4" />, run: () => navigate('/my-work') },
        { id: 'projects', label: 'All projects', icon: <FolderKanban className="size-4" />, run: () => navigate('/projects') },
        { id: 'theme', label: 'Switch light / dark', icon: <Moon className="size-4" />, run: onToggleTheme },
      ].filter((i) => match(i.label)),
      ...(projects ?? []).filter((p) => match(`${p.name} ${p.key}`)).flatMap((p) => [
        { id: `p-${p.id}`, label: p.name, hint: 'Board', icon: <FolderKanban className="size-4" />, run: () => navigate(`/projects/${p.id}`) },
        ...(needle ? [
          { id: `a-${p.id}`, label: `${p.name}: Analytics`, hint: 'Analytics', icon: <FolderKanban className="size-4" />, run: () => navigate(`/projects/${p.id}/analytics`) },
          { id: `s-${p.id}`, label: `${p.name}: Settings`, hint: 'Settings', icon: <FolderKanban className="size-4" />, run: () => navigate(`/projects/${p.id}/settings`) },
        ] : []),
      ]),
    ].slice(0, 12);
  }, [q, tickets, projects, projectId, navigate, onToggleTheme]);
  useEffect(() => { setActive(0); }, [items.length]);

  if (!open) return null;
  const run = (item) => { setOpen(false); item?.run(); };
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
      <div aria-hidden className="ds-fade absolute inset-0 bg-canvas/70 backdrop-blur-sm" onMouseDown={() => setOpen(false)} />
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="ds-panel relative w-full max-w-lg overflow-hidden rounded-panel bg-overlay shadow-overlay">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
            aria-label="Search"
            className="h-13 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle"
            placeholder={projectId ? 'Search tickets, projects and pages…' : 'Search projects and pages…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === 'Enter') run(items[active]);
            }}
          />
          {searching && <Spinner className="text-fg-subtle" />}
          <Kbd>Esc</Kbd>
        </div>
        <ul id="palette-list" role="listbox" aria-label="Results" className="ds-scroll max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && <li className="px-4 py-8 text-center text-small text-fg-muted">{searching ? 'Searching…' : 'Nothing matches that. Try a ticket key, or fewer words.'}</li>}
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => run(item)}
              className={clsx('flex cursor-default items-center gap-3 rounded-tile px-3 py-2 text-small', i === active ? 'bg-hover text-fg' : 'text-fg-muted')}
            >
              <span className="shrink-0 text-fg-subtle">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.ticket ? <KeyChip>{item.hint}</KeyChip> : item.hint && <span className="text-caption text-fg-subtle">{item.hint}</span>}
              <CornerDownLeft className={clsx('size-3.5 shrink-0 text-fg-subtle', i !== active && 'invisible')} aria-hidden />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
