import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Bell, CheckCircle2, GitCommitHorizontal, Plus, RotateCcw, TrendingUp, VolumeX } from 'lucide-react';
import { formatDate, formatDateTime } from '../lib/format.js';
import { DataTable, SERIES, Tip, axis, barCursor, baseAxis, grid, shortDay, useChartMotion, useDark } from './charts.jsx';

// The reports-over-time chart for an error ticket, in its own file so the chart library loads only
// when a ticket made from an error is opened (the drawer itself is part of the board's first load).
// Each marker kind has its own icon and label in the list under the chart, so colour is never
// the only way to tell them apart.
const MARKER = {
  created: { color: 'var(--c-fg-subtle)', icon: Plus, dash: '2 3' },
  fixed: { color: 'var(--c-success)', icon: CheckCircle2 },
  regressed: { color: 'var(--c-danger)', icon: RotateCcw },
  reopened: { color: 'var(--c-warning)', icon: RotateCcw },
  linked: { color: 'var(--c-fg-subtle)', icon: GitCommitHorizontal, dash: '2 3' },
  muted: { color: 'var(--c-fg-subtle)', icon: VolumeX, dash: '4 3' },
  unmuted: { color: 'var(--c-fg-subtle)', icon: Bell, dash: '4 3' },
  spiked: { color: 'var(--c-danger)', icon: TrendingUp, dash: '4 3' },
};

export default function Timeline({ timeline }) {
  const mode = useDark() ? 'dark' : 'light';
  const enter = useChartMotion();
  const total = timeline.days.reduce((s, d) => s + d.count, 0);
  const reported = timeline.days.filter((d) => d.count > 0);
  return (
    <div>
      <div className="h-32 text-fg-subtle" role="img" aria-label={`Reports per day: ${total} over ${timeline.days.length} days`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={timeline.days} margin={{ top: 6, right: 6, left: -26, bottom: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="date" tickFormatter={shortDay} minTickGap={28} {...baseAxis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip cursor={barCursor} content={<Tip labelFormat={shortDay} format={(v) => `${v} report${v === 1 ? '' : 's'}`} />} />
            {timeline.markers.map((m, i) => (
              <ReferenceLine key={i} x={m.day} stroke={MARKER[m.kind]?.color} strokeWidth={m.kind === 'fixed' || m.kind === 'regressed' ? 2 : 1} strokeDasharray={MARKER[m.kind]?.dash} />
            ))}
            <Bar dataKey="count" name="Reports" fill={SERIES[mode][0]} radius={[3, 3, 0, 0]} maxBarSize={14} {...enter} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {timeline.truncated && <p className="mt-1 text-micro text-fg-subtle">Showing the last 90 days.</p>}
      {reported.length > 0 && (
        <details className="mt-1 text-caption">
          <summary className="ds-focus w-fit cursor-pointer rounded-tile text-fg-subtle hover:text-fg">Reports per day as a table</summary>
          <div className="ds-scroll mt-1 max-h-48 overflow-auto"><DataTable head={['Day', 'Reports']} rows={reported.map((d) => [shortDay(d.date), d.count])} /></div>
        </details>
      )}
      <ol className="mt-2 space-y-1 text-caption">
        {[...timeline.markers].reverse().map((m, i) => {
          const M = MARKER[m.kind] ?? MARKER.created;
          return (
            <li key={i} className="flex items-center gap-2">
              <M.icon className="size-3.5 shrink-0" style={{ color: M.color }} aria-hidden />
              <span className="w-24 shrink-0 tabular-nums text-fg-subtle">{formatDate(m.at)}</span>
              {m.url ? <a href={m.url} target="_blank" rel="noreferrer" className="truncate underline">{m.label}</a> : <span className="truncate">{m.label}{m.kind === 'muted' && (m.until ? ` until ${formatDateTime(m.until)}` : ' until unmuted')}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
