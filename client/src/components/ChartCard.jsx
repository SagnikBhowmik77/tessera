import { useState } from 'react';
import clsx from 'clsx';
import { BarChart3, Table2 } from 'lucide-react';
import { Button } from '../ds/core.jsx';

// The card and table every chart sits in. Their own file, without the chart library or the motion
// library, so a page that only shows a card (the service-level meters) doesn't download either.
// A chart in a card, with a switch to the same numbers as a table (always available, so the
// chart is never the only way to read them).
export function ChartCard({ title, subtitle, children, table, actions, className }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={clsx('min-w-0 rounded-card bg-surface p-4 shadow-surface sm:p-5', className)} aria-label={title}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-h3 font-semibold text-fg">{title}</h2>
          {subtitle && <p className="mt-0.5 text-caption text-fg-subtle">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {table && (
            <Button size="sm" variant="ghost" icon={asTable ? BarChart3 : Table2} onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
              {asTable ? 'Chart' : 'Table'}
            </Button>
          )}
        </div>
      </div>
      {/* The table scrolls on its own, so it can take focus and be scrolled from the keyboard. */}
      {asTable ? <div className="ds-scroll ds-focus max-h-72 overflow-auto rounded-tile" tabIndex={0} role="region" aria-label={`${title}, as a table`}>{table}</div> : children}
    </section>
  );
}

// The numbers behind a chart. Numeric columns line up (tabular figures).
export function DataTable({ head, rows }) {
  return (
    <table className="w-full text-caption">
      <thead className="sticky top-0 bg-surface text-left text-fg-subtle">
        <tr>{head.map((h) => <th key={h} scope="col" className="border-b border-line py-1.5 pr-3 font-medium">{h}</th>)}</tr>
      </thead>
      <tbody className="tabular-nums text-fg-muted">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-line py-1.5 pr-3">{c}</td>)}</tr>)}
      </tbody>
    </table>
  );
}
