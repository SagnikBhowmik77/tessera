import { useDeferredValue, useId, useMemo, useState } from 'react';
import { CalendarCheck, Info } from 'lucide-react';
// The server's own forecast, unchanged: the Flow tab runs this against a team's real history.
import { MIN_FINISHED, monteCarlo } from '../../../server/src/flow/montecarlo.js';
import DemoFrame, { Segmented } from './DemoFrame.jsx';
import { HISTORIES } from './samples.js';

const DAY = 24 * 3600 * 1000;
const dateIn = (days) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.now() + days * DAY));

function Slider({ id, label, value, min, max, step = 1, onChange, format }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-caption font-medium text-fg-muted">{label}</label>
        <output htmlFor={id} className="text-small font-semibold tabular-nums text-fg">{format(value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={format(value)}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` }}
        className="ds-range mt-1.5 block w-full"
      />
    </div>
  );
}

const LEVELS = [
  ['p50', 'Even odds', 'bg-key'],
  ['p85', 'Likely (85%)', 'bg-key/55'],
  ['p95', 'Almost certain (95%)', 'bg-key/25'],
];

export default function ForecastDemo() {
  const id = useId();
  const [team, setTeam] = useState(HISTORIES[0].id);
  const [left, setLeft] = useState(40);
  const [pace, setPace] = useState(100);
  const history = HISTORIES.find((h) => h.id === team).days;
  const finished = history.reduce((a, b) => a + b, 0);
  const enough = finished >= MIN_FINISHED;
  const wanted = useDeferredValue({ team, left, pace });
  const result = useMemo(() => {
    const days = HISTORIES.find((h) => h.id === wanted.team).days;
    // Like the API: too little history means no simulation at all.
    if (days.reduce((a, b) => a + b, 0) < MIN_FINISHED) return null;
    return monteCarlo({ samples: days, items: wanted.left, factor: wanted.pace / 100 }).whenDone;
  }, [wanted]);
  const peak = Math.max(...history, 1);
  const end = Math.max((result?.p95 ?? 0) * 1.12, 7);

  return (
    <DemoFrame title="When will it be done?" source="server/src/flow/montecarlo.js" sourceNote="the Monte Carlo forecast the Flow tab runs on a team's real last six weeks">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-w-0 space-y-4">
          <Segmented label="Sample team" options={HISTORIES.map((h) => ({ value: h.id, label: h.label }))} value={team} onChange={setTeam} />
          <div>
            {/* Six weeks of finished tickets, a day per bar (the numbers are in the sentence under it). */}
            <div className="flex h-14 items-end gap-px" aria-hidden>
              {history.map((n, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <span key={i} className="min-h-px flex-1 rounded-t-shard bg-fg-faint" style={{ height: `${Math.max(2, (n / peak) * 100)}%`, opacity: n ? 1 : 0.35 }} />
              ))}
            </div>
            <p className="mt-1.5 text-caption text-fg-subtle">
              Last 6 weeks: {finished} ticket{finished === 1 ? '' : 's'} finished, {(finished / history.length).toFixed(1)} a day on average.
            </p>
          </div>
          <Slider id={`${id}-left`} label="Tickets still open" value={left} min={5} max={120} onChange={setLeft} format={(v) => `${v}`} />
          <Slider id={`${id}-pace`} label="What if the pace changes" value={pace} min={50} max={150} step={10} onChange={setPace} format={(v) => (v === 100 ? 'as now' : `${v}%`)} />
        </div>

        <div className="min-w-0" aria-live="polite">
          {enough && result ? (
            <>
              <ul className="grid gap-2 sm:grid-cols-3">
                {LEVELS.map(([k, label]) => (
                  <li key={k} className="rounded-card border border-line bg-raised p-3">
                    <p className="text-caption text-fg-subtle">{label}</p>
                    <p className="mt-1 font-display text-h1 text-fg">{dateIn(result[k])}</p>
                    <p className="text-caption tabular-nums text-fg-muted">in {result[k]} days</p>
                  </li>
                ))}
              </ul>
              {/* The same three dates on one line: the further out, the surer. */}
              <div className="mt-5" aria-hidden>
                <div className="relative h-3 overflow-hidden rounded-full bg-hover">
                  {[...LEVELS].reverse().map(([k, , fill]) => (
                    <span key={k} className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--dur-base) ${fill}`} style={{ width: `${(result[k] / end) * 100}%` }} />
                  ))}
                </div>
                <div className="mt-1.5 flex justify-between text-micro tabular-nums text-fg-subtle"><span>Today</span><span>{Math.round(end)} days</span></div>
              </div>
              <p className="mt-4 flex gap-2 text-caption text-fg-muted">
                <CalendarCheck className="mt-px size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                10,000 simulated futures. Each day of each one replays a real day from the history above, so an uneven team gets a wider spread of dates than a steady one.
              </p>
            </>
          ) : (
            <div className="flex h-full min-h-40 gap-3 rounded-card border border-line bg-raised p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
              <div>
                <p className="text-small font-medium text-fg">No forecast yet</p>
                <p className="mt-1 text-caption text-fg-muted">
                  Only {finished} tickets finished in the last {history.length} days; a forecast needs at least {MIN_FINISHED}. Tessera says so instead of guessing a date.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </DemoFrame>
  );
}
