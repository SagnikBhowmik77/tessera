/* eslint-disable react-refresh/only-export-components */
import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { animate, motion, useInView, useReducedMotion } from 'motion/react';
import clsx from 'clsx';

// Chart pieces shared by Analytics, Flow, the sprint pages, error insights and time travel.
//
// Categorical slots: the Stained Glass hues (violet first, the brand's "done" colour), in a fixed
// order that is never cycled, stepped separately for each surface. Checked with the dataviz
// validator (lightness band, chroma floor, colour-blind separation of neighbours, normal-vision
// floor, contrast) against the card surface of each theme, 2026-11-13:
//   light on #FFFFFF: all pass, worst neighbour ΔE 12.2 (deutan), normal 23.4, all >= 3:1
//   dark  on #111116: all pass, worst neighbour ΔE 11.8 (deutan), normal 23.5, all >= 3:1
// Order: violet, mint, orchid, amber, sky, rose, blue, orange. Columns past the eighth share a neutral.
export const SERIES = {
  light: ['#765fca', '#119a70', '#8e3b94', '#9f6700', '#1490b9', '#ce5276', '#2c5dbd', '#ce5d1e'],
  dark: ['#8470d6', '#119a70', '#9c4ea1', '#c68206', '#15a0ce', '#b64466', '#3e6dc8', '#ca602a'],
};
export const OTHER = { light: '#9896a3', dark: '#5c5c6b' };

// Status categories and ticket types wear the same hues as their badges (chart steps of them,
// see --c-chart-* in tokens.css). Types stack bug, feature, task: red never touches green.
export const STATUS_COLOR = { todo: 'var(--c-chart-todo)', in_progress: 'var(--c-chart-progress)', done: 'var(--c-chart-done)' };
export const TYPE_COLOR = { bug: 'var(--c-chart-bug)', feature: 'var(--c-chart-feature)', task: 'var(--c-chart-task)', epic: 'var(--c-epic)' };
export const TYPE_ORDER = ['bug', 'feature', 'task'];

// Paint for each board column: the first column of a category wears the category colour, a second
// and third get the same colour as a hatched texture (45°, then 135°) so they never lean on a tint
// that would be too close to tell apart; anything further, or a removed column, is neutral.
export function statusPaint(statuses, keys, mode) {
  const used = {};
  return Object.fromEntries(keys.map((k) => {
    const cat = statuses.find((s) => s.key === k)?.category;
    if (!STATUS_COLOR[cat]) return [k, { color: OTHER[mode], texture: null }];
    const n = (used[cat] = (used[cat] ?? -1) + 1);
    if (n > 2) return [k, { color: OTHER[mode], texture: null }];
    return [k, { color: STATUS_COLOR[cat], texture: [null, 45, 135][n] }];
  }));
}

// Gridlines and axis text come from the theme tokens (recessive, never the data colours). The
// grid is a soft dotted rule; the value axis has no line at all, the category axis a hairline.
export const GRID = 'var(--c-line)';
export const grid = { stroke: 'var(--c-line-strong)', strokeDasharray: '1 5', strokeLinecap: 'round', vertical: false };
export const gridV = { ...grid, vertical: true, horizontal: false };
export const axis = { tick: { fill: 'var(--c-fg-subtle)', fontSize: 11 }, tickLine: false, axisLine: false, tickMargin: 8 };
export const baseAxis = { ...axis, axisLine: { stroke: 'var(--c-line-strong)' } };
export const crosshair = { stroke: 'var(--c-line-strong)', strokeWidth: 1, strokeDasharray: '3 3' };
export const barCursor = { fill: 'var(--c-hover)', radius: 6 };
export const activeDot = { r: 4.5, stroke: 'var(--c-surface)', strokeWidth: 2 };

// Entry animation: marks grow from the baseline once, on the motion tokens' easing. Off when the
// person asks for less motion (and Recharts then draws the final frame at once).
export function useChartMotion(delay = 0) {
  const reduced = useReducedMotion();
  return reduced
    ? { isAnimationActive: false }
    : { isAnimationActive: true, animationDuration: 720, animationEasing: 'ease-out', animationBegin: delay };
}

// The <defs> a chart needs: a soft vertical gradient for each area, and hatching for textured
// series. Ids are scoped by `uid` so two charts on a page never share one.
export function chartDefs(uid, entries) {
  return (
    <defs>
      {entries.map(({ id, color, texture }) => (texture ? (
        <pattern key={id} id={`${uid}-${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform={`rotate(${texture})`}>
          <rect width="6" height="6" fill={color} fillOpacity="0.16" />
          <line x1="1" y1="0" x2="1" y2="6" stroke={color} strokeWidth="2" />
        </pattern>
      ) : (
        <linearGradient key={id} id={`${uid}-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.42" />
          <stop offset="100%" stopColor={color} stopOpacity="0.1" />
        </linearGradient>
      )))}
    </defs>
  );
}
export const fillRef = (uid, id) => `url(#${uid}-${id})`;
export const useChartId = () => `c${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

export function useDark() {
  return useSyncExternalStore(
    (cb) => { const o = new MutationObserver(cb); o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); return () => o.disconnect(); },
    () => document.documentElement.classList.contains('dark'),
  );
}

export const shortDay = (day) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
export const longDay = (day) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
export const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const minusDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

// A duration given in days and hours (the server rounds both to one decimal, so 0.1 h = 6 min).
// Week-scale work in days, same-day work in hours, quick work in minutes. A 0.0 means under
// 3 minutes, which is what it says, rather than "0 h".
export function spell(days, hours) {
  if (days === null || days === undefined) return '—';
  if (days >= 1) return `${days} d`;
  if (hours >= 1) return `${hours} h`;
  const minutes = Math.round(hours * 60);
  return minutes > 0 ? `${minutes} min` : '< 3 min';
}
export const duration = (s) => spell(s?.medianDays, s?.medianHours);
export const p85 = (s) => spell(s?.p85Days, s?.p85Hours);

// The same median as a number to count up to, in the unit `spell` would choose, so the last frame
// of the count is exactly the text above. Null when there is nothing to count (no data, < 3 min).
export function durationCount(s) {
  const days = s?.medianDays; const hours = s?.medianHours;
  if (days === null || days === undefined) return null;
  if (days >= 1) return { value: days, format: (n) => `${Math.round(n * 10) / 10} d` };
  if (hours >= 1) return { value: hours, format: (n) => `${Math.round(n * 10) / 10} h` };
  const minutes = Math.round(hours * 60);
  return minutes > 0 ? { value: minutes, format: (n) => `${Math.round(n)} min` } : null;
}

// The tooltip card: glass, a swatch beside each name (identity), values in text colours with
// tabular figures, and an optional total. `colorOf` overrides a swatch when the mark's own fill is
// a gradient or texture.
export function Tip({ active, payload, label, format = (v) => v, labelFormat = (l) => l, colorOf, total }) {
  if (!active || !payload?.length) return null;
  const sum = total ? payload.reduce((s, p) => s + (Number(p.value) || 0), 0) : null;
  return (
    <div className="ds-chart-tip min-w-40 px-3 py-2 text-caption">
      <div className="mb-1 font-medium text-fg">{labelFormat(label)}</div>
      {[...payload].reverse().map((p) => {
        const c = colorOf?.(p.dataKey, p) ?? (String(p.color).startsWith('url') ? p.stroke : p.color);
        return (
          <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: c }} />
            <span className="text-fg-muted">{p.name}</span>
            <span className="ml-auto pl-4 font-medium tabular-nums text-fg">{format(p.value, p)}</span>
          </div>
        );
      })}
      {total && <div className="mt-1 flex border-t border-line pt-1 text-fg-muted">{total}<span className="ml-auto pl-4 font-medium tabular-nums text-fg">{format(sum)}</span></div>}
    </div>
  );
}

// A swatch: solid, or hatched to match a textured series.
const swatchStyle = (color, texture) => (texture
  ? { background: `repeating-linear-gradient(${texture}deg, ${color} 0 2px, color-mix(in oklab, ${color} 16%, transparent) 2px 6px)` }
  : { background: color });

// A legend for two or more series: a swatch beside each name, names in text colours.
export function Legend({ items, className }) {
  return (
    <ul className={clsx('mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-caption text-fg-muted', className)}>
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5">
          <span aria-hidden className={clsx('w-3 rounded-shard', i.dashed ? 'h-0.5' : 'h-2')} style={swatchStyle(i.color, i.texture)} />{i.name}
        </li>
      ))}
    </ul>
  );
}

// ChartCard and DataTable live in ChartCard.jsx (no chart or motion code there).
export { ChartCard, DataTable } from './ChartCard.jsx';

// A dot with a 2px ring in the surface colour, so dots stay legible where they overlap.
export function RingDot({ cx, cy, fill, r = 4.5 }) {
  if (cx === undefined || cy === undefined) return null;
  return <circle cx={cx} cy={cy} r={r} fill={fill} stroke="var(--c-surface)" strokeWidth={2} />;
}

// A small line beside a number: its recent shape, drawn in once. Only real values; fewer than two
// and there is no line to draw, so nothing renders. The label says what it shows in words.
export function Sparkline({ values, color = 'var(--c-chart-done)', label, className }) {
  const uid = useChartId();
  const reduced = useReducedMotion();
  if (!values || values.length < 2) return null;
  const W = 100; const H = 32; const P = 3;
  const max = Math.max(...values); const min = Math.min(0, ...values);
  const x = (i) => P + (i * (W - 2 * P)) / (values.length - 1);
  const y = (v) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(2)} ${H} L${x(0).toFixed(2)} ${H} Z`;
  const last = values.length - 1;
  const draw = reduced ? {} : { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] } };
  const fade = reduced ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.5, delay: 0.45 } };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={clsx('h-8 w-24 overflow-visible', className)}>
      <defs>
        <linearGradient id={`${uid}-s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill={`url(#${uid}-s)`} {...fade} />
      <motion.path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" {...draw} />
      <motion.circle cx={x(last)} cy={y(values[last])} r="2.6" fill={color} stroke="var(--c-surface)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" {...fade} />
    </svg>
  );
}

// A number that counts up to its value the first time it is seen (and from the old value to the
// new one when it changes). The real value is always in the page for screen readers; the counting
// copy is hidden from them. With reduced motion it simply shows the value.
export function CountUp({ value, format = (n) => String(Math.round(n)), className }) {
  const ref = useRef(null);
  const from = useRef(0);
  const reduced = useReducedMotion();
  const seen = useInView(ref, { once: true });
  const fmt = useRef(format);
  useLayoutEffect(() => { fmt.current = format; });
  useLayoutEffect(() => {
    if (ref.current && !seen) ref.current.textContent = fmt.current(reduced ? value : from.current);
  }, [seen, reduced, value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !seen) return undefined;
    const start = from.current;
    from.current = value;
    if (reduced || start === value) { el.textContent = fmt.current(value); return undefined; }
    const c = animate(start, value, { duration: 0.9, ease: [0.22, 1, 0.36, 1], onUpdate: (n) => { el.textContent = fmt.current(n); } });
    return () => { c.stop(); el.textContent = fmt.current(value); };
  }, [value, seen, reduced]);
  return (
    <span className={clsx('tabular-nums', className)}>
      <span ref={ref} aria-hidden />
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
