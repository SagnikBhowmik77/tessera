import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Building2, ChevronDown, ChevronRight, FolderKanban, Keyboard, KeyRound, ListTodo, LogOut, Mail, Menu as MenuIcon, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, WifiOff, X } from 'lucide-react';
import { api } from '../lib/api.js';
import CommandPalette from './CommandPalette.jsx';
import KeyPreview from './KeyPreview.jsx';
import ShortcutsDialog, { useShortcutsKey } from './ShortcutsDialog.jsx';
import NotificationsBell, { useNotificationsLive } from './NotificationsBell.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects, useTickets } from '../lib/queries.js';
import { getSocket } from '../lib/socket.js';
import { useTheme } from '../lib/theme.js';
import { useLook, usePreferences } from '../lib/preferences.js';
import { Avatar, IconButton, Kbd, KeyChip, Logo, Menu, MenuItem, MenuSeparator, Mosaic, Spinner } from '../ds/core.jsx';
import { EmptyNote } from '../ds/core.jsx';
import { ErrorBoundary } from './states.jsx';
import { usePreloadTicketDrawer } from './LazyTicketDrawer.jsx';
import { useOnline, useOutbox } from '../lib/offline.js';

// The project tile lives in its own file (public pages use it without this shell).
export { ProjectTile } from './ProjectTile.jsx';
import { ProjectTile } from './ProjectTile.jsx';

// The project name in a page header doubles as a menu to switch project.
// It keeps you on the same tab (Board, List, Analytics, ...) in the project you pick.
// The project's live mosaic: one tile per real ticket, coloured by status (done, then in progress,
// then to do), in every project header. It shares the board's ticket list (same query, same cache),
// so it changes as tickets move on pages that follow live updates; a ticket added since the last
// look sets itself in. An empty project shows the outline of its first tiles instead.
const MOSAIC_CAP = 60;
function ProjectMosaic({ project }) {
  const { data } = useTickets(project.id, { sort: 'rank', limit: '500' });
  const seen = useRef(null);
  const category = new Map(project.statuses.map((s) => [s.key, s.category]));
  const order = { done: 0, in_progress: 1, todo: 2 };
  const all = (data?.tickets ?? []).map((t) => ({ key: t.id, number: t.number, status: category.get(t.status) ?? 'todo' }))
    .sort((a, b) => order[a.status] - order[b.status] || a.number - b.number);
  const total = data?.total ?? all.length;
  const counts = { todo: 0, in_progress: 0, done: 0 };
  for (const t of all) counts[t.status] += 1;
  // Past the cap the mosaic keeps the proportions (and says the real numbers).
  const shown = all.length > MOSAIC_CAP ? ['done', 'in_progress', 'todo'].flatMap((st) => all.filter((t) => t.status === st).slice(0, Math.round((counts[st] / all.length) * MOSAIC_CAP))) : all;
  const before = seen.current;
  const tiles = shown.map((t) => ({ ...t, fresh: Boolean(before) && !before.has(t.key) }));
  useEffect(() => { if (data) seen.current = new Set(all.map((t) => t.key)); });
  if (!data) return <span aria-hidden className="hidden h-6 w-24 sm:block" />;
  const label = total
    ? `${total} ${total === 1 ? 'ticket' : 'tickets'}: ${counts.todo} to do, ${counts.in_progress} in progress, ${counts.done} done`
    : 'No tickets yet';
  return (
    <span className="hidden shrink-0 items-center gap-2.5 sm:flex" title={label}>
      <Mosaic tiles={tiles} empty={total ? 0 : 6} size="sm" columns={total ? Math.ceil(tiles.length / (tiles.length <= 16 ? 2 : 3)) : 3} label={label} />
      <span className="hidden text-caption leading-tight text-fg-subtle lg:block">
        <span className="block font-code text-fg-muted">{total ? `${total} ${total === 1 ? 'ticket' : 'tickets'}` : 'No tickets'}</span>
        {total ? `${counts.done} done` : 'yet'}
      </span>
    </span>
  );
}

export function ProjectSwitcher({ project, children }) {
  const { data: projects } = useProjects();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tab = /^\/projects\/[a-f0-9]{24}\/(list|calendar|timeline|sprints|analytics|triage|flow|deploys|together|releases|settings)/.exec(pathname)?.[1];
  const go = (p) => { if (p.id !== project.id) navigate(`/projects/${p.id}${tab ? `/${tab}` : ''}`); };
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3">
      <Menu
        label="Switch project"
        width="w-72"
        className="flex min-w-0"
        trigger={(props, open) => (
          <button
            type="button"
            {...props}
            aria-label={`Project: ${project.name}. Switch project`}
            className="ds-focus -ml-1.5 flex min-w-0 items-center gap-3 rounded-card px-1.5 py-1 transition-colors duration-(--dur-fast) hover:bg-hover"
          >
            <ProjectTile project={project} className="size-8 text-caption" />
            <h1 className="truncate font-display text-h1 italic text-fg">{project.name}</h1>
            <ChevronDown className={clsx('size-4 shrink-0 text-fg-subtle transition-transform duration-(--dur-fast)', open && 'rotate-180')} aria-hidden />
          </button>
        )}
      >
        {projects?.map((p) => (
          <MenuItem
            key={p.id}
            checked={p.id === project.id}
            onClick={() => go(p)}
            leading={<ProjectTile project={p} className="size-5 text-[0.5625rem]" />}
            trailing={<KeyChip>{p.key}</KeyChip>}
          >
            {p.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={FolderKanban} onClick={() => navigate('/projects')}>All projects</MenuItem>
      </Menu>
      {children}
      <ProjectMosaic project={project} />
    </div>
  );
}

// A quiet line above every page: unconfirmed email (with a resend button), and a one-time note
// after signing in with a backup code saying how many are left.
// Shown while the connection is gone: what still works and what waits. Comments written now are
// kept and sent when it is back (lib/offline.js); everything else needs the connection.
function OfflineNotice() {
  const online = useOnline();
  const waiting = useOutbox().length;
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2.5 border-b border-warning/30 bg-warning/10 px-4 py-2 text-small text-fg sm:px-6">
      <WifiOff className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0">
        You're offline. Comments you write are kept and sent when you're back{waiting ? ` (${waiting} waiting)` : ''}; other changes need the connection.
      </span>
    </div>
  );
}

function AccountNotices() {
  const { user } = useAuth();
  const [sent, setSent] = useState(false);
  // Closing the note keeps it closed for a week on this device (it was back on every visit).
  const memo = `tessera.verifyNote.${user.id}`;
  const [hidden, setHidden] = useState(() => { try { return Number(localStorage.getItem(memo)) > Date.now(); } catch { return false; } });
  const hide = () => { setHidden(true); try { localStorage.setItem(memo, String(Date.now() + 7 * 86_400_000)); } catch { /* storage blocked */ } };
  useEffect(() => {
    let left = null;
    try { left = sessionStorage.getItem('tessera.backupNotice'); sessionStorage.removeItem('tessera.backupNotice'); } catch { /* storage blocked */ }
    if (left !== null) {
      toast(Number(left) <= 3
        ? `You signed in with a backup code. Only ${left} left: make new ones on your Account page.`
        : `You signed in with a backup code. ${left} left.`, { icon: <KeyRound className="size-4 shrink-0 text-warning" aria-hidden />, duration: 8000 });
    }
  }, []);
  if (user.emailVerifiedAt || hidden) return null;
  const resend = async () => {
    try { await api('/auth/verify/resend', { method: 'POST' }); setSent(true); } catch (e) { toast.error(e.message); }
  };
  return (
    <div role="status" className="flex items-center gap-2.5 border-b border-line px-4 py-1 text-caption text-fg-subtle sm:px-6">
      <Mail className="size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">
        Confirm <b className="font-medium text-fg">{user.email}</b> to get email notifications.{' '}
        {sent
          ? <span className="font-medium text-fg">Sent again; check your inbox.</span>
          : <button type="button" className="ds-focus rounded-hair font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg" onClick={resend}>Send the link again</button>}
      </span>
      <IconButton label="Hide this note for a week" icon={X} size="sm" onClick={hide} />
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const navClass = (collapsed) => ({ isActive }) => clsx(
  'ds-focus flex items-center gap-2.5 rounded-tile py-1.5 text-small transition-colors duration-(--dur-fast) compact:py-1',
  collapsed ? 'justify-center px-0' : 'px-2.5',
  isActive ? 'bg-raised font-medium text-fg shadow-raised' : 'text-fg-muted hover:bg-hover hover:text-fg',
);

// The sidebar. Collapsed (a preference saved with the account) it is a rail of icons: every name
// is still there for screen readers and as a tooltip, and "[" or the button at the bottom opens it.
function Sidebar({ onNavigate, collapsed = false, onCollapse, onTheme }) {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme(onTheme);
  const { data: projects } = useProjects();
  const label = (text) => <span className={collapsed ? 'sr-only' : 'truncate'}>{text}</span>;
  const tip = (text) => (collapsed ? text : undefined);
  return (
    <div className="flex h-full flex-col">
      <div className={clsx('flex items-center pt-4', collapsed ? 'flex-col gap-2 px-2 pb-3' : 'justify-between pb-4 pl-4 pr-2.5')}>
        <Link to="/projects" onClick={onNavigate} className="ds-focus rounded-tile" aria-label="Tessera, all projects">
          <Logo wordmark={!collapsed} size={26} />
        </Link>
        <span className="hidden lg:block"><NotificationsBell /></span>
      </div>
      <div className={collapsed ? 'px-2' : 'px-2.5'}>
        <button
          type="button"
          onClick={() => { onNavigate?.(); window.dispatchEvent(new Event('tessera:palette')); }}
          title={tip(`Search or jump to… (${isMac ? '⌘K' : 'Ctrl K'})`)}
          className={clsx(
            'ds-focus mb-3 flex h-9 w-full items-center gap-2.5 rounded-tile border border-line-strong bg-field text-small text-fg-subtle transition-colors duration-(--dur-fast) hover:border-fg-faint hover:text-fg-muted compact:h-8',
            collapsed ? 'justify-center px-0' : 'px-2.5',
          )}
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className={collapsed ? 'sr-only' : 'flex-1 text-left'}>Search or jump to…</span>
          {!collapsed && <Kbd className="pointer-coarse:hidden">{isMac ? '⌘K' : 'Ctrl K'}</Kbd>}
        </button>
      </div>
      <nav aria-label="Main" className={clsx('space-y-0.5', collapsed ? 'px-2' : 'px-2.5')}>
        <NavLink to="/my-work" onClick={onNavigate} className={navClass(collapsed)} title={tip('My work')}><ListTodo className="size-4 shrink-0 text-fg-subtle" aria-hidden />{label('My work')}</NavLink>
        <NavLink to="/projects" end onClick={onNavigate} className={navClass(collapsed)} title={tip('Projects')}><FolderKanban className="size-4 shrink-0 text-fg-subtle" aria-hidden />{label('Projects')}</NavLink>
        <NavLink to="/workspaces" onClick={onNavigate} className={navClass(collapsed)} title={tip('Workspaces')}><Building2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />{label('Workspaces')}</NavLink>
      </nav>
      <h2 id="your-projects" className={collapsed ? 'sr-only' : 'mt-6 px-4 text-micro font-medium uppercase tracking-wider text-fg-subtle compact:mt-4'}>Your projects</h2>
      {collapsed && <hr className="mx-3 mt-3 border-line" aria-hidden />}
      <nav aria-labelledby="your-projects" className={clsx('ds-scroll mt-2 flex-1 space-y-0.5 overflow-y-auto pb-2', collapsed ? 'px-2' : 'px-2.5')}>
        {projects?.length === 0 && !collapsed && <EmptyNote size="xs" className="px-2.5 py-1">None yet. Create one from Projects.</EmptyNote>}
        {projects?.map((p) => (
          <NavLink key={p.id} to={`/projects/${p.id}`} onClick={onNavigate} className={navClass(collapsed)} title={tip(p.name)}>
            <ProjectTile project={p} className="size-5 text-[0.5625rem]" />
            {label(p.name)}
          </NavLink>
        ))}
      </nav>
      <div className={clsx('border-t border-line', collapsed ? 'px-2 py-2.5' : 'p-2.5')}>
        <div className={clsx('flex items-center gap-1', collapsed && 'flex-col')}>
          <Link to="/account" onClick={onNavigate} className={clsx('ds-focus flex min-w-0 items-center gap-2.5 rounded-tile py-1 transition-colors duration-(--dur-fast) hover:bg-hover', collapsed ? 'justify-center px-1' : 'flex-1 px-1.5')} title="Your account">
            <Avatar name={user.name} id={user.id} />
            <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1'}>
              <span className="block truncate text-small font-medium text-fg">{user.name}</span>
              <span className="block truncate text-caption text-fg-subtle">{user.email}</span>
            </span>
          </Link>
          <IconButton label="Keyboard shortcuts" shortcut="?" icon={Keyboard} size="sm" onClick={() => window.dispatchEvent(new Event('tessera:shortcuts'))} />
          <IconButton label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} icon={theme === 'dark' ? Sun : Moon} size="sm" onClick={toggle} />
          <IconButton label="Sign out" icon={LogOut} size="sm" onClick={logout} />
          {onCollapse && <IconButton label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} shortcut="[" icon={collapsed ? PanelLeftOpen : PanelLeftClose} size="sm" onClick={onCollapse} />}
        </div>
      </div>
    </div>
  );
}


// The sidebar as a drawer on phones and tablets: Escape closes it, focus stays inside while it is
// open and goes back to the menu button after.
function Drawer({ onClose, onTheme }) {
  const panel = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    panel.current?.querySelector('a, button')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll('a[href], button:not([disabled])')];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); if (before instanceof HTMLElement) before.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div aria-hidden className="ds-fade absolute inset-0 bg-canvas/70 backdrop-blur-sm" onClick={onClose} />
      <aside ref={panel} role="dialog" aria-modal="true" aria-label="Menu" className="ds-drawer absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-sunken shadow-overlay">
        <div className="absolute right-2 top-3.5"><IconButton label="Close menu" shortcut="Esc" icon={X} size="sm" onClick={onClose} /></div>
        <Sidebar onNavigate={onClose} onTheme={onTheme} />
      </aside>
    </div>
  );
}

export default function AppShell() {
  usePreloadTicketDrawer();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const location = useLocation();
  // The live connection opens once signed in (it is shared by every page).
  useEffect(() => { getSocket(); }, []);
  useNotificationsLive();
  // The account's look (theme, accent, density) and the sidebar's state, saved with the account.
  const [prefs, updatePrefs] = usePreferences();
  useLook(prefs);
  const saveTheme = useCallback((t) => { updatePrefs({ theme: t }); }, [updatePrefs]);
  const { toggle } = useTheme(saveTheme);
  const collapsed = prefs.sidebarCollapsed;
  const toggleSidebar = useCallback(() => { updatePrefs({ sidebarCollapsed: !collapsed }); }, [updatePrefs, collapsed]);
  // "[" opens or closes the sidebar (not while typing).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      toggleSidebar();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
  // "?" anywhere, or the keyboard button in the sidebar.
  const [keys, setKeys] = useState(false);
  useShortcutsKey(setKeys);
  useEffect(() => { const show = () => setKeys(true); window.addEventListener('tessera:shortcuts', show); return () => window.removeEventListener('tessera:shortcuts', show); }, []);
  useEffect(() => { setOpen(false); }, [location.pathname]);

  return (
    <div className="ds-canvas flex h-dvh overflow-hidden">
      <a href="#main" className="ds-focus sr-only rounded-tile bg-overlay px-3 py-2 text-small text-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50">Skip to content</a>
      <aside className={clsx('hidden shrink-0 border-r border-line bg-sunken transition-[width] duration-(--dur-base) ease-(--motion-out) lg:block', collapsed ? 'w-16' : 'w-64')} aria-label="Sidebar">
        <Sidebar collapsed={collapsed} onCollapse={toggleSidebar} onTheme={saveTheme} />
      </aside>
      {open && <Drawer onClose={close} onTheme={saveTheme} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-sunken px-2 py-2 lg:hidden">
          <IconButton label="Open menu" icon={MenuIcon} onClick={() => setOpen(true)} />
          <Link to="/projects" className="ds-focus rounded-tile" aria-label="Tessera, all projects"><Logo wordmark size={22} /></Link>
          <span className="ml-auto"><NotificationsBell align="right" /></span>
        </div>
        <OfflineNotice />
        <AccountNotices />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {/* Its own loading boundary: while a page's code arrives, the sidebar, header and banners are
              already painted (otherwise the whole app waits for the slowest page, e.g. the charts). */}
          <ErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<div className="grid min-h-60 place-items-center" role="status" aria-label="Loading"><Spinner className="size-6 text-fg-subtle" /></div>}><Outlet /></Suspense>
          </ErrorBoundary>
        </main>
        <CommandPalette onToggleTheme={toggle} />
        <KeyPreview />
        <ShortcutsDialog open={keys} onClose={() => setKeys(false)} />
      </div>
    </div>
  );
}

// Page title row with breadcrumbs and actions; tabs (or anything else) go below as children.
// One row: the way back (links to the pages above this one), the title, the actions; tabs go
// below as children. The project itself and the current page aren't repeated in the trail: the
// title (the project switcher) and the tabs already say them.
const isProjectRoot = (to) => /^\/projects\/[^/]+$/.test(to ?? '');
export function PageHeader({ crumbs = [], title, actions, children }) {
  const back = crumbs.filter((c) => c.to && !isProjectRoot(c.to));
  return (
    <header className="border-b border-line px-4 pt-3 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pb-2.5">
        <div className="flex min-w-0 max-w-full items-center gap-2.5">
          {back.length > 0 && (
            <nav aria-label="Breadcrumb" className="hidden shrink-0 sm:block">
              <ol className="flex items-center gap-1 text-caption text-fg-subtle">
                {back.map((c) => (
                  <li key={c.label} className="flex items-center gap-1">
                    <Link to={c.to} className="ds-focus rounded-hair transition-colors duration-(--dur-fast) hover:text-fg">{c.label}</Link>
                    <ChevronRight className="size-3 shrink-0 text-fg-faint" aria-hidden />
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {title}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
