import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Palmtree, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { addDays, daysBetween, shortDay, todayKey } from '../lib/days.js';
import { Button, Field, Spinner } from './ui.jsx';

// Your own leave (time off): add a range with an optional note, remove one. Teammates in every
// project you share see it on the calendar, the timeline and next to your name in assignee pickers.
export default function MyLeave() {
  const qc = useQueryClient();
  const today = todayKey();
  const { data: leave, isLoading } = useQuery({ queryKey: qk.myLeave, queryFn: () => api('/me/leave').then((d) => d.leave) });
  const [from, setFrom] = useState(addDays(today, 1));
  const [to, setTo] = useState(addDays(today, 1));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.myLeave });
    qc.invalidateQueries({ queryKey: ['leave'] });
  };
  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/me/leave', { method: 'POST', body: { from, to, ...(note.trim() && { note: note.trim() }) } });
      toast.success('Leave added');
      setNote('');
      refresh();
    } catch (err) { toast.error(err.message); } finally { setBusy(false); }
  };
  const remove = async (l) => {
    try { await api(`/me/leave/${l.id}`, { method: 'DELETE' }); toast.success('Leave removed'); refresh(); } catch (err) { toast.error(err.message); }
  };
  const upcoming = (leave ?? []).filter((l) => l.to >= today);
  const past = (leave ?? []).filter((l) => l.to < today).reverse();
  const days = from && to && to >= from ? daysBetween(from, to) + 1 : 0;
  return (
    <div className="space-y-4">
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
        <Field label="First day"><input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} required /></Field>
        <Field label="Last day"><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></Field>
        <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} placeholder="Diwali, conference…" /></Field>
        <Button variant="primary" type="submit" loading={busy} disabled={!days}>Add {days > 1 ? `${days} days` : '1 day'}</Button>
      </form>
      <p className="text-caption text-fg-subtle">Everyone in your projects sees the dates and the note.</p>
      {isLoading ? <Spinner className="text-fg-subtle" /> : upcoming.length === 0 && past.length === 0 ? (
        <p className="flex items-center gap-2 text-small text-fg-subtle"><Palmtree className="size-4" />No leave planned.</p>
      ) : (
        <ul className="divide-y divide-line rounded-tile border border-line  ">
          {[...upcoming, ...past].map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-3 py-2 text-small">
              <Palmtree className="size-4 shrink-0 text-success " />
              <span className="font-medium">{l.from === l.to ? shortDay(l.from) : `${shortDay(l.from)} – ${shortDay(l.to)}`}</span>
              <span className="text-caption text-fg-subtle">{l.days} day{l.days === 1 ? '' : 's'}{l.to < today ? ' · past' : l.from <= today ? ' · now' : ''}</span>
              {l.note && <span className="min-w-0 flex-1 truncate text-fg-muted">{l.note}</span>}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => remove(l)} aria-label={`Remove leave from ${shortDay(l.from)}`}><Trash2 className="size-3.5" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
