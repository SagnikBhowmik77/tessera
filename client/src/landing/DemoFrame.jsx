import { useId } from 'react';
import { FlaskConical } from 'lucide-react';

// The frame every landing-page demo sits in. The label is always visible, above the demo, so
// nothing on this page can be mistaken for real usage: it says what is sample data, that it runs
// only in this browser, and which file of Tessera's own code it runs.
export default function DemoFrame({ title, source, sourceNote, children }) {
  const id = useId();
  return (
    <figure aria-labelledby={`${id}-title`} className="overflow-hidden rounded-panel border border-line bg-surface shadow-raised">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sunken px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-key-line bg-key-bg px-2.5 py-0.5 text-micro font-semibold uppercase tracking-wider text-fg">
          <FlaskConical className="size-3" aria-hidden />Interactive demo
        </span>
        <span id={`${id}-title`} className="text-small font-medium text-fg">{title}</span>
        <span className="text-caption text-fg-subtle sm:ml-auto">Sample data. Runs in this browser; nothing is sent or saved.</span>
      </div>
      <div className="p-4 sm:p-5">{children}</div>
      <figcaption className="border-t border-line px-4 py-2.5 text-caption text-fg-subtle">
        Built from <code className="rounded-hair bg-hover px-1 py-px font-mono text-micro text-fg-muted">{source}</code>
        {sourceNote ? <>, {sourceNote}</> : null}
      </figcaption>
    </figure>
  );
}

// A row of choices that behaves like radio buttons (arrow keys move between them).
export function Segmented({ label, options, value, onChange }) {
  const move = (e) => {
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    e.currentTarget.parentElement.querySelector(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-tile border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={move}
          className="ds-focus h-7 rounded-hair px-2.5 text-caption font-medium text-fg-muted transition-colors duration-(--dur-fast) hover:text-fg aria-checked:bg-surface aria-checked:text-fg aria-checked:shadow-surface"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
