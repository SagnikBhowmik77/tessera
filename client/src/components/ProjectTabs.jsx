import { Fragment } from 'react';
import { Link, useLocation } from 'react-router';
import clsx from 'clsx';
import {
  Activity, CalendarDays, ChartNoAxesColumn, ChevronDown, Columns3, GanttChart, Inbox, LayoutList, Rocket, ScrollText, Settings, Timer, Users,
} from 'lucide-react';
import { Menu, MenuItem } from '../ds/core.jsx';

// A project's views in groups: how you look at work | how you plan it | the rest (in "More") |
// settings on the far right. Views inside "More" show their own name there while you are on them.
const PRIMARY = [
  { path: '', label: 'Board', icon: Columns3, group: 'views', match: (rest) => rest === '' || rest.startsWith('tickets/') },
  { path: 'list', label: 'List', icon: LayoutList, group: 'views', match: (rest) => rest.startsWith('list') },
  { path: 'calendar', label: 'Calendar', icon: CalendarDays, group: 'views', match: (rest) => rest.startsWith('calendar') },
  { path: 'timeline', label: 'Timeline', icon: GanttChart, group: 'views', match: (rest) => rest.startsWith('timeline') },
  { path: 'sprints', label: 'Sprints', icon: Timer, group: 'plan', match: (rest) => rest.startsWith('sprints') },
  { path: 'analytics', label: 'Analytics', icon: ChartNoAxesColumn, group: 'plan', match: (rest) => rest.startsWith('analytics') },
];
const MORE = [
  { path: 'triage', label: 'Triage', icon: Inbox, match: (rest) => rest.startsWith('triage') },
  { path: 'flow', label: 'Flow', icon: Activity, match: (rest) => rest.startsWith('flow') },
  { path: 'deploys', label: 'Deploys', icon: Rocket, match: (rest) => rest.startsWith('deploys') },
  { path: 'together', label: 'Together', icon: Users, match: (rest) => rest.startsWith('together') },
  { path: 'releases', label: 'Release notes', icon: ScrollText, match: (rest) => rest.startsWith('releases') },
];
const SETTINGS = { path: 'settings', label: 'Settings', icon: Settings, match: (rest) => rest.startsWith('settings') };

const tabClass = (active) => clsx(
  'ds-focus relative mb-1 inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-tile px-2.5 text-small font-medium transition-colors duration-(--dur-fast)',
  active ? 'text-fg' : 'text-fg-subtle hover:bg-hover hover:text-fg',
);
const Underline = () => <span aria-hidden className="absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-fg" />;
const Divider = () => <span aria-hidden className="mx-1.5 mb-1 h-4 w-px shrink-0 self-center bg-line-strong" />;

export default function ProjectTabs({ projectId }) {
  const { pathname } = useLocation();
  const rest = pathname.replace(`/projects/${projectId}`, '').replace(/^\//, '');
  const to = (t) => `/projects/${projectId}${t.path ? `/${t.path}` : ''}`;
  const inMore = MORE.find((t) => t.match(rest));

  // compact: icon only on phones (the label stays the link's name).
  const tab = (t, compact = false) => {
    const active = t.match(rest);
    return (
      <Link to={to(t)} aria-current={active ? 'page' : undefined} aria-label={compact ? t.label : undefined} className={tabClass(active)}>
        <t.icon className="size-4 shrink-0" aria-hidden />
        <span className={compact ? 'hidden sm:inline' : undefined}>{t.label}</span>
        {active && <Underline />}
      </Link>
    );
  };

  return (
    <nav aria-label="Project views" className="-mb-px flex items-end">
      {/* Only the main views scroll sideways on a phone; More and Settings stay put. */}
      <div className="ds-scroll -ml-1 flex min-w-0 items-end overflow-x-auto px-1 pt-1">
        {PRIMARY.map((t, i) => (
          <Fragment key={t.label}>
            {i > 0 && t.group !== PRIMARY[i - 1].group && <Divider />}
            {tab(t)}
          </Fragment>
        ))}
      </div>
      <Divider />
      <Menu
        label="More views"
        trigger={(props, open) => (
          <button type="button" {...props} aria-current={inMore ? 'page' : undefined} className={tabClass(Boolean(inMore))}>
            {inMore && <inMore.icon className="size-4 shrink-0" aria-hidden />}
            {inMore ? inMore.label : 'More'}
            <ChevronDown className={clsx('size-3.5 shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-180')} aria-hidden />
            {inMore && <Underline />}
          </button>
        )}
      >
        {MORE.map((t) => <MenuItem key={t.label} as={Link} to={to(t)} icon={t.icon} current={t.match(rest)}>{t.label}</MenuItem>)}
      </Menu>
      <span className="min-w-2 flex-1" />
      {tab(SETTINGS, !SETTINGS.match(rest))}
    </nav>
  );
}
