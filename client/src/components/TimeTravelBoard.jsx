import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGroup, motion } from 'motion/react';
import clsx from 'clsx';
import { History, Pause, Play } from 'lucide-react';
import { api } from '../lib/api.js';
import { Button, Spinner } from './ui.jsx';
import { TicketCard } from '../pages/BoardPage.jsx';
import { STATUS_COLOR, longDay, minusDays, shortDay, todayKey } from './charts.jsx';

const plusDays = (day, n) => minusDays(day, -n);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
const SPRING = { type: 'spring', stiffness: 420, damping: 38, mass: 0.8 };

// The history strip under the scrubber: how many tickets were on the board at the end of each day
// (soft, to-do grey) and how many of those were done (violet), from the project's own cumulative
// flow. Plain SVG: it is a backdrop for the handle, read in full by the board above it.
function HistoryStrip({ days, doneKeys, selected }) {
  const W = 1000; const H = 44;
  const totals = days.map((d) => Object.values(d.counts).reduce((s, n) => s + n, 0));
  const done = days.map((d) => doneKeys.reduce((s, k) => s + (d.counts[k] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const x = (i) => (days.length === 1 ? W / 2 : (i * W) / (days.length - 1));
  const y = (v) => H - (v / max) * (H - 4);
  const area = (vals) => `M0 ${H} ${vals.map((v, i) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} L${W} ${H} Z`;
  const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const at = Math.max(0, days.findIndex((d) => d.day === selected));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
      <path d={area(totals)} fill={STATUS_COLOR.todo} fillOpacity="0.22" />
      <path d={line(totals)} fill="none" stroke={STATUS_COLOR.todo} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <path d={area(done)} fill={STATUS_COLOR.done} fillOpacity="0.32" />
      <path d={line(done)} fill="none" stroke={STATUS_COLOR.done} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <rect x={x(at)} width={W - x(at)} height={H} fill="var(--c-surface)" fillOpacity="0.55" />
    </svg>
  );
}

// The board exactly as it was at a moment in the past, rebuilt from the ticket history:
// columns, titles, priorities, labels, due dates and assignees as they were then. Read-only.
// A scrubber over the project's history picks the day; cards glide between columns as the date
// changes (the same card keeps its identity), arrive and leave with a fade.
export default function TimeTravelBoard({ project }) {
  const today = todayKey();
  const created = project.createdAt.slice(0, 10);
  // The analytics service covers at most a year at a time, so the strip does too.
  const start = created > minusDays(today, 365) ? created : minusDays(today, 365);
  const span = Math.max(0, daysBetween(start, today));
  const [day, setDay] = useState(() => (minusDays(today, 1) < start ? start : minusDays(today, 1)));
  const [time, setTime] = useState('18:00');
  // While scrubbing, the handle moves at once and the board follows a moment later.
  const [shown, setShown] = useState(day);
  useEffect(() => { const id = setTimeout(() => setShown(day), 140); return () => clearTimeout(id); }, [day]);

  // Replay (E9): the board a day at a time, from the chosen day up to today.
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return undefined;
    const id = setInterval(() => {
      setDay((d) => {
        const next = plusDays(d, 1);
        if (next > today) { setPlaying(false); return d; }
        return next;
      });
    }, 1300);
    return () => clearInterval(id);
  }, [playing, today]);

  // India time, so the moment matches the team's calendar. A moment later today than now means now.
  const atOf = (d) => {
    const chosen = `${d}T${time}:00+05:30`;
    return new Date(chosen).getTime() > Date.now() ? new Date(Math.floor(Date.now() / 60000) * 60000).toISOString() : chosen;
  };
  const future = new Date(`${day}T${time}:00+05:30`).getTime() > Date.now();
  const at = atOf(shown);
  const boardAt = (a) => ({ queryKey: ['board-at', project.id, a], queryFn: () => api(`/projects/${project.id}/board-at?at=${encodeURIComponent(a)}`), staleTime: 60_000 });
  const { data, isFetching, error } = useQuery({ ...boardAt(at), placeholderData: (prev) => prev });
  // The days either side are fetched ahead, so stepping with the arrow keys is instant.
  const qc = useQueryClient();
  useEffect(() => {
    for (const d of [minusDays(shown, 1), plusDays(shown, 1)]) if (d >= start && d <= today) qc.prefetchQuery(boardAt(atOf(d)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, time]);

  const { data: history } = useQuery({
    queryKey: ['analytics', project.id, start, today],
    queryFn: () => api(`/projects/${project.id}/analytics?from=${start}&to=${today}`),
    staleTime: 5 * 60_000,
  });
  const doneKeys = useMemo(() => project.statuses.filter((s) => s.category === 'done').map((s) => s.key), [project.statuses]);
  const index = Math.min(span, Math.max(0, daysBetween(start, day)));
  const months = useMemo(() => {
    const out = [];
    for (let i = 0; i <= span; i += 1) {
      const d = plusDays(start, i);
      if (d.endsWith('-01') || i === 0) out.push({ i, label: new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) });
    }
    return out.filter((m, k) => k === 0 || m.i - out[k - 1].i > span / 14);
  }, [start, span]);
  // Cards already on the board glide from where they were (same layout id); only cards that were
  // not on the board a moment ago fade in. Cards that leave simply go, so nothing overlaps mid-move.
  const seen = useRef(new Set());
  const onBoard = useMemo(() => new Set(data?.columns.flatMap((c) => c.tickets.map((t) => t.number)) ?? []), [data]);
  useEffect(() => { seen.current = onBoard; }, [onBoard]);
  const pct = span ? (index / span) * 100 : 50;
  const pick = (d) => { setPlaying(false); setDay(d < start ? start : d > today ? today : d); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-4 mb-3 rounded-card bg-surface p-3 shadow-surface sm:mx-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-small">
          <History className="size-4 text-accent" aria-hidden />
          <p className="font-medium text-fg" aria-live="polite">
            Board as it was on <span className="tabular-nums">{longDay(day)}</span>
          </p>
          <label className="flex items-center gap-1.5 text-caption text-fg-subtle">
            at
            <input type="time" className="input h-8 w-auto text-caption" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} aria-label="Time of day (India)" />
            IST
          </label>
          <span className="flex flex-wrap gap-1">
            {[['Yesterday', 1], ['A week ago', 7], ['30 days ago', 30]].map(([l, n]) => (
              <Button key={l} size="sm" variant="ghost" onClick={() => { pick(minusDays(today, n)); setTime('18:00'); }}>{l}</Button>
            ))}
          </span>
          <Button size="sm" variant={playing ? 'primary' : 'ghost'} icon={playing ? Pause : Play} onClick={() => setPlaying((x) => !x)} disabled={day >= today && !playing}>
            {playing ? 'Stop' : 'Replay to today'}
          </Button>
          <span className="ml-auto flex items-center gap-2 text-caption text-fg-subtle">
            {isFetching && <Spinner className="size-3.5" />}
            {data && <span className="tabular-nums">{data.total} ticket{data.total === 1 ? '' : 's'} on the board then · read-only</span>}
          </span>
        </div>

        <div className="mt-3">
          <div className="relative h-11 overflow-hidden rounded-tile bg-sunken">
            {history ? <HistoryStrip days={history.cfd.days} doneKeys={doneKeys} selected={day} /> : <div className="ds-skeleton absolute inset-0" aria-hidden />}
            <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-(--c-chart-done)" style={{ left: `${pct}%` }} />
            <input
              type="range" min={0} max={span} step={1} value={index} disabled={span === 0}
              onChange={(e) => pick(plusDays(start, Number(e.target.value)))}
              onKeyDown={(e) => {
                if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); pick(plusDays(day, e.key === 'PageUp' ? 7 : -7)); }
              }}
              aria-label="Day to show"
              aria-valuetext={longDay(day)}
              className="ds-scrub absolute inset-0 size-full"
            />
          </div>
          <div className="relative mt-1 h-4 text-micro text-fg-subtle" aria-hidden>
            {months.map((m) => (
              <span key={m.i} className="absolute -translate-x-1/2 tabular-nums first:translate-x-0" style={{ left: `${span ? (m.i / span) * 100 : 0}%` }}>{m.label}</span>
            ))}
            <span className="absolute right-0">Today</span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-fg-subtle">
            <span className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-shard" style={{ background: STATUS_COLOR.todo }} />On the board</span>
            <span className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-shard" style={{ background: STATUS_COLOR.done }} />Of those, done</span>
            <span>Drag, or use ← → for a day and Page Up / Page Down for a week. {shortDay(start)} to today.</span>
          </p>
        </div>
        {future && <p className="mt-2 text-caption text-warning">That time hasn't happened yet, so this is the board now.</p>}
      </div>

      {error && <p className="px-6 text-small text-danger">{error.details?.[0]?.message ?? error.message}</p>}
      {data?.total === 0 && <p className="px-6 py-10 text-center text-small text-fg-subtle">The board was empty at that moment.</p>}
      <LayoutGroup>
        <div className={clsx('scroll-thin flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 transition-opacity duration-(--dur-fast) sm:px-6', shown !== day && 'opacity-80')} aria-busy={isFetching}>
          {data?.total > 0 && data.columns.map((c) => (
            <section key={c.key} className="flex max-h-full w-[290px] shrink-0 flex-col rounded-card bg-sunken" aria-label={`${c.name}, ${c.tickets.length}`}>
              <header className="flex items-center gap-2 px-3 pb-2 pt-3">
                <h2 className="truncate text-small font-semibold">{c.name}</h2>
                <span className="text-micro tabular-nums text-fg-subtle">{c.tickets.length}</span>
                {c.removed && <span className="text-micro text-fg-subtle">(column since removed)</span>}
              </header>
              <div className="scroll-thin flex flex-col gap-2 overflow-y-auto px-2 pb-3">
                {c.tickets.map((t) => (
                  <motion.div
                    key={t.number} layoutId={`tt-${project.id}-${t.number}`} layout="position" transition={SPRING}
                    initial={seen.current.size && !seen.current.has(t.number) ? { opacity: 0, y: -6 } : false}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <TicketCard ticket={t} done={c.category === 'done'} />
                  </motion.div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
