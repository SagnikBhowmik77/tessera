import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlarmClock, CalendarClock, ListTodo } from 'lucide-react';
import { api } from '../lib/api.js';
import { dueState, formatDateTime, formatDue, timeAgo } from '../lib/format.js';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, EmptyState, PriorityDot, Spinner, TypeIcon } from '../components/ui.jsx';
import { KeyChip, STATUS_META } from '../ds/core.jsx';

// Grouped like Linear's "My issues": what is in progress first, then what is waiting to start.
const GROUPS = [['in_progress', 'In progress'], ['todo', 'To do'], ['done', 'Done']];

const pretty = (key) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// Everything open that is assigned to me, across all my active projects, soonest due first.
// Snoozed tickets wait in their own tab until they come back.
export default function MyWorkPage() {
  const [view, setView] = useState('active');
  const snoozed = view === 'snoozed';
  const { data, isLoading } = useQuery({
    queryKey: ['my-work', view],
    queryFn: () => api(`/me/tickets?limit=200${snoozed ? '&snoozed=true' : ''}`),
    placeholderData: (prev) => prev,
  });
  const overdue = data?.tickets.filter((t) => dueState(t.dueDate, false) === 'overdue').length ?? 0;
  const tab = (key, label) => (
    <button type="button" onClick={() => setView(key)} aria-pressed={view === key}
      className={clsx('rounded-tile px-2.5 py-1 text-small font-medium', view === key ? 'bg-raised text-fg shadow-raised' : 'text-fg-subtle hover:text-fg')}>
      {label}
    </button>
  );
  return (
    <div>
      <PageHeader
        title={(
          <div>
            <h1 className="font-display text-h1 italic text-fg">My work</h1>
            {data && !snoozed && <p className="text-small text-fg-subtle">{data.total} open ticket{data.total === 1 ? '' : 's'} assigned to you{overdue ? ` · ${overdue} overdue` : ''}</p>}
            {data && snoozed && <p className="text-small text-fg-subtle">Snoozed tickets come back to your list, with a reminder, at the time you picked.</p>}
          </div>
        )}
        actions={(
          <div className="flex gap-1">
            {tab('active', 'Active')}
            {tab('snoozed', `Snoozed${data?.snoozedCount ? ` (${data.snoozedCount})` : ''}`)}
          </div>
        )}
      />
      {isLoading && <div className="grid place-items-center py-16"><Spinner className="size-6 text-fg-subtle" /></div>}
      {data?.total === 0 && !snoozed && (
        <EmptyState icon={ListTodo} title={data.snoozedCount ? 'All caught up for now' : 'Nothing on your plate'}>
          {data.snoozedCount
            ? `${data.snoozedCount} snoozed ticket${data.snoozedCount === 1 ? '' : 's'} will come back here at the time you picked.`
            : 'Open tickets assigned to you in any project show up here, soonest due first.'}
        </EmptyState>
      )}
      {data?.total === 0 && snoozed && (
        <EmptyState icon={AlarmClock} title="Nothing snoozed">
          Snooze a ticket with its alarm-clock button and it waits here, out of your way, until the time you pick.
        </EmptyState>
      )}
      {GROUPS.map(([category, title]) => {
        const rows = data?.tickets.filter((t) => (t.statusCategory ?? 'todo') === category) ?? [];
        if (!rows.length) return null;
        const meta = STATUS_META[category];
        return (
      <section key={category} aria-labelledby={`group-${category}`}>
        <h2 id={`group-${category}`} className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-canvas/90 px-4 py-2 text-caption font-medium text-fg-muted backdrop-blur sm:px-6">
          <meta.Icon className={clsx('size-3.5', meta.tone)} strokeWidth={2.25} aria-hidden />{title}<span className="tabular-nums text-fg-subtle">{rows.length}</span>
        </h2>
      <ul className="divide-y divide-line">
        {rows.map((t) => {
          const due = dueState(t.dueDate, false);
          return (
            <li key={t.id}>
              <Link to={`/projects/${t.project}/tickets/${t.key}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover compact:py-1.5 sm:px-6">
                <TypeIcon type={t.type} />
                <KeyChip>{t.key}</KeyChip>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-medium">{t.title}</span>
                  <span className="block truncate text-caption text-fg-subtle">{t.projectName} · {t.statusName ?? pretty(t.status)}</span>
                </span>
                <PriorityDot priority={t.priority} />
                {t.snoozedUntil && (
                  <Badge tone="amber" className="shrink-0"><AlarmClock className="size-3" />Back {formatDateTime(t.snoozedUntil)}</Badge>
                )}
                {t.dueDate && (
                  <Badge tone={due === 'overdue' ? 'red' : due === 'today' ? 'amber' : 'zinc'} className={clsx('shrink-0')}>
                    <CalendarClock className="size-3" />{due === 'overdue' ? 'Overdue · ' : ''}{formatDue(t.dueDate)}
                  </Badge>
                )}
                <span className="hidden w-24 shrink-0 text-right text-caption text-fg-subtle sm:block">{timeAgo(t.updatedAt)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      </section>
        );
      })}
    </div>
  );
}
