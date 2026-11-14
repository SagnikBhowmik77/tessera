import clsx from 'clsx';
import { Check } from 'lucide-react';
import { ACCENTS } from '../lib/accents.js';
import { useDark } from './charts.jsx';

// The curated accent colours as a row of swatches (real radio buttons, arrow keys move between
// them). Every colour here is checked for WCAG AA in both themes (see lib/accents.js). "No accent"
// keeps Tessera's own colours. Used for a team's report page and for a person's own app.
export default function AccentPicker({ value, onChange, label = 'Accent colour', noneLabel = 'Tessera (no accent)', disabled }) {
  const dark = useDark();
  const options = [[null, { name: noneLabel }], ...Object.entries(ACCENTS)];
  const move = (e, i) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const to = (i + step + options.length) % options.length;
    onChange(options[to][0]);
    e.currentTarget.parentElement.children[to]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map(([key, a], i) => {
        const on = (value ?? null) === key;
        return (
          <button
            key={key ?? 'none'}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={a.name}
            title={a.name}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => !on && onChange(key)}
            onKeyDown={(e) => move(e, i)}
            className={clsx('ds-focus relative grid size-9 place-items-center rounded-full transition-transform duration-(--dur-fast) hover:scale-105 disabled:opacity-50', on && 'ring-2 ring-fg ring-offset-2 ring-offset-surface')}
          >
            {/* "No accent" always shows the brand's own gradient (the page's gradient may already be an accent). */}
            <span aria-hidden className="size-7 rounded-full" style={{ background: key ? (dark ? a.dark : a.light) : 'linear-gradient(135deg, var(--brand-amber) 0%, var(--brand-rose) 48%, var(--brand-violet) 100%)' }} />
            {on && <Check className={clsx('absolute size-3.5', dark ? 'text-canvas' : 'text-white')} strokeWidth={3} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
