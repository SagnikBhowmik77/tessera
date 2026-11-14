import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { AlarmClock, Bell, CheckCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { getSocket } from '../lib/socket.js';
import { qk } from '../lib/queries.js';
import { timeAgo } from '../lib/format.js';
import { Avatar, Button } from '../ds/core.jsx';

export function notificationText(n) {
  const who = n.actor?.name ?? 'Someone';
  switch (n.type) {
    case 'mention': return `${who} mentioned you on ${n.ticketKey}`;
    case 'assigned': return `${who} assigned ${n.ticketKey} to you`;
    case 'comment': return `${who} commented on ${n.ticketKey}`;
    case 'resolved': return `${n.ticketKey} you reported is done`;
    case 'regression': return `${n.ticketKey} came back: the same error was reported again`;
    case 'portal_report': return `New report ${n.ticketKey} from the public portal`;
    case 'status_changed': return `${who} moved ${n.ticketKey}${n.excerpt ? `: ${n.excerpt}` : ''}`;
    case 'reminder': return `Reminder: ${n.ticketKey} is back from snooze`;
    case 'crash_new': return `New crash ${n.ticketKey} from your app${n.excerpt ? ` (${n.excerpt})` : ''}`;
    case 'crash_spike': return `${n.ticketKey} is spiking: ${n.excerpt}`;
    case 'reporter_message': return `The reporter of ${n.ticketKey} wrote: ${n.excerpt}`;
    case 'reporter_answer': return `${n.ticketKey}: ${n.excerpt}`;
    case 'sla_breached': return `${n.ticketKey} is late: ${n.excerpt ?? 'a service-level target was missed'}`;
    default: return n.ticketKey;
  }
}

const useNotifications = () => useQuery({ queryKey: qk.notifications, queryFn: () => api('/notifications?limit=30') });

// Live notifications for the whole app: refresh the inbox and show a small toast.
// Called once (in the app shell) so two bells never mean two toasts.
export function useNotificationsLive() {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const onNew = (n) => {
      qc.invalidateQueries({ queryKey: qk.notifications });
      // A snoozed ticket that came back belongs on My work again.
      if (n.type === 'reminder') qc.invalidateQueries({ queryKey: ['my-work'] });
      const Icon = n.type === 'reminder' ? AlarmClock : Bell;
      toast(notificationText(n), { icon: <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden /> });
    };
    const onCount = ({ unread }) => qc.setQueryData(qk.notifications, (d) => (d ? { ...d, unread } : d));
    socket.on('notification', onNew);
    socket.on('notification:count', onCount);
    return () => { socket.off('notification', onNew); socket.off('notification:count', onCount); };
  }, [qc]);
}

export default function NotificationsBell({ align = 'left' }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const unread = data?.unread ?? 0;
  const markRead = async (ids) => {
    const res = await api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} });
    qc.setQueryData(qk.notifications, (d) => d && {
      unread: res.unread,
      notifications: d.notifications.map((n) => (!ids || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)),
    });
  };
  const openOne = (n) => {
    setOpen(false);
    if (!n.readAt) markRead([n.id]).catch(() => {});
    navigate(`/projects/${n.project}/tickets/${n.ticketKey}`);
  };
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="relative">
      <Button variant="ghost" square onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} aria-expanded={open}>
        <Bell className="size-4 shrink-0" aria-hidden />
        {unread > 0 && (
          // The count is drawn by CSS: the button's name already says it ("3 unread"), and as text it
          // would make the visible label differ from the name (WCAG 2.5.3).
          <span aria-hidden data-count={unread > 99 ? '99+' : unread} className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 font-code text-[0.5625rem] font-semibold text-canvas ring-2 ring-sunken before:content-[attr(data-count)]" />
        )}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={clsx('ds-drop absolute top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-card bg-overlay shadow-overlay', align === 'left' ? 'left-0' : 'right-0')}>
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-small font-semibold text-fg">Notifications</span>
              {unread > 0 && <Button size="sm" variant="ghost" icon={CheckCheck} onClick={() => markRead()}>Mark all read</Button>}
            </div>
            <ul className="ds-scroll max-h-96 overflow-y-auto">
              {data?.notifications.length === 0 && <li className="px-4 py-10 text-center text-small text-fg-muted">You're all caught up.</li>}
              {data?.notifications.map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => openOne(n)} className={clsx('ds-focus flex w-full gap-3 px-4 py-3 text-left ds-focus-inset transition-colors duration-(--dur-fast) hover:bg-hover', !n.readAt && 'bg-accent-soft')}>
                    {n.actor ? <Avatar name={n.actor.name} id={n.actor.id} size="sm" /> : <span className="grid size-5 shrink-0 place-items-center rounded-full bg-press text-fg-subtle"><Bell className="size-3" aria-hidden /></span>}
                    <span className="min-w-0 flex-1">
                      <span className="block text-small text-fg">{notificationText(n)}</span>
                      <span className="block truncate text-caption text-fg-muted">{n.ticketTitle}</span>
                      {n.excerpt && !['status_changed', 'reminder', 'sla_breached', 'crash_spike', 'crash_new', 'reporter_message', 'reporter_answer'].includes(n.type) && <span className="mt-0.5 line-clamp-2 block text-caption text-fg-muted">"{n.excerpt}"</span>}
                      <span className="mt-0.5 block text-micro text-fg-subtle">{timeAgo(n.createdAt)}</span>
                    </span>
                    {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" role="img" aria-label="Unread" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
