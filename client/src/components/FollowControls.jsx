import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { AlarmClock, Bell, BellOff } from 'lucide-react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { Button } from './ui.jsx';

// One visit per opening of a ticket. The request is shared for a few seconds so React's
// development double-render doesn't record two visits (the second would see "no changes").
const inflight = new Map();
function recordVisit(projectId, number) {
  const key = `${projectId}:${number}`;
  if (!inflight.has(key)) {
    const p = api(`/projects/${projectId}/tickets/${number}/visit`, { method: 'POST' });
    inflight.set(key, p);
    setTimeout(() => inflight.delete(key), 3000);
  }
  return inflight.get(key);
}

// { previousVisit, changes, more, watching, snoozedUntil } for the ticket that's open, plus a setter.
export function useTicketVisit(projectId, number, enabled) {
  const [visit, setVisit] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setVisit(null);
    recordVisit(projectId, number).then((v) => { if (live) setVisit(v); }).catch(() => {});
    return () => { live = false; };
  }, [projectId, number, enabled]);
  const patch = (changes) => setVisit((v) => (v ? { ...v, ...changes } : v));
  return [visit, patch];
}

export function WatchButton({ base, watching, onChange }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const res = await api(`${base}/watch`, { method: watching ? 'DELETE' : 'PUT' });
      onChange(res.watching);
      toast.success(res.watching ? 'Watching: you will hear about every move and comment' : 'Stopped watching');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const Icon = watching ? BellOff : Bell;
  const label = watching ? 'Stop watching' : 'Watch this ticket';
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} aria-pressed={watching} disabled={busy} onClick={toggle}
      className={clsx(watching && 'text-accent')}>
      <Icon className="size-4" />
    </Button>
  );
}

// Times are in the team's zone (India), like due dates.
const TZ = 'Asia/Kolkata';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const at = (day, hm) => new Date(`${day}T${hm}:00+05:30`);
function presets(now = new Date()) {
  const plusDays = (n) => dayKey(new Date(now.getTime() + n * 864e5));
  const weekday = WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now));
  const toMonday = ((8 - weekday) % 7) || 7;
  const list = [
    { label: 'In 3 hours', until: new Date(now.getTime() + 3 * 3600e3) },
    { label: 'Tomorrow, 9 am', until: at(plusDays(1), '09:00') },
    { label: 'Next Monday, 9 am', until: at(plusDays(toMonday), '09:00') },
  ];
  // "This evening" only while it is still more than an hour away.
  const evening = at(dayKey(now), '18:00');
  if (evening.getTime() - now.getTime() > 3600e3) list.unshift({ label: 'This evening, 6 pm', until: evening });
  return list;
}

export function SnoozeMenu({ base, snoozedUntil, onChange }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const box = useRef(null);
  const qc = useQueryClient();
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const apply = async (until) => {
    try {
      const res = until
        ? await api(`${base}/snooze`, { method: 'PUT', body: { until: until.toISOString() } })
        : await api(`${base}/snooze`, { method: 'DELETE' });
      onChange(res.snoozedUntil);
      qc.invalidateQueries({ queryKey: ['my-work'] });
      setOpen(false);
      toast.success(until ? `Snoozed until ${formatDateTime(until)}. It leaves My work until then.` : 'Snooze cancelled');
    } catch (e) { toast.error(e.message); }
  };
  const label = snoozedUntil ? `Snoozed until ${formatDateTime(snoozedUntil)}` : 'Snooze (remind me later)';
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" size="icon" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={clsx(snoozedUntil && 'text-warning')}>
        <AlarmClock className="size-4" />
      </Button>
      {open && (
        <div className="card absolute right-0 top-full z-30 mt-1 w-64 p-1.5 text-small shadow-overlay">
          <p className="px-2 pb-1.5 pt-1 text-caption text-fg-subtle">
            {snoozedUntil ? <>Snoozed until <b className="text-fg">{formatDateTime(snoozedUntil)}</b></> : 'Hide from My work, then remind me:'}
          </p>
          {presets().map((p) => (
            <button key={p.label} type="button" onClick={() => apply(p.until)}
              className="flex w-full justify-between gap-2 rounded-tile px-2 py-1.5 text-left hover:bg-hover">
              {p.label}<span className="text-caption text-fg-subtle">{formatDateTime(p.until)}</span>
            </button>
          ))}
          <form className="mt-1 flex gap-1.5 border-t border-line px-1 pt-2 "
            onSubmit={(e) => { e.preventDefault(); if (custom) apply(new Date(`${custom}:00+05:30`)); }}>
            <input type="datetime-local" className="input h-8 min-w-0 flex-1 text-caption" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Snooze until (India time)" />
            <Button size="sm" type="submit" disabled={!custom}>Set</Button>
          </form>
          {snoozedUntil && (
            <button type="button" onClick={() => apply(null)} className="mt-1 w-full rounded-tile px-2 py-1.5 text-left text-danger hover:bg-danger/10">
              Cancel snooze
            </button>
          )}
        </div>
      )}
    </div>
  );
}
