/* eslint-disable react-refresh/only-export-components */
// Tessera design system, part 2: the parts animated with the motion library (switches,
// segmented controls, tabs: things that slide with layout animation). Kept apart so the motion code only loads with screens that use them.
import { useId, useRef } from 'react';
import clsx from 'clsx';
import { MotionConfig, motion } from 'motion/react';

const spring = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 };
const quick = { duration: 0.14, ease: [0.22, 1, 0.36, 1] };

// Wrap the app (or a page) once: motion then honours "reduce motion" everywhere.
export function DSProvider({ children }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export function Switch({ checked, onChange, label, description, disabled, className }) {
  const id = useId();
  return (
    <div className={clsx('flex items-center justify-between gap-4', className)}>
      <span className="min-w-0">
        <label htmlFor={id} className="block text-small font-medium text-fg">{label}</label>
        {description && <span className="block text-caption text-fg-subtle">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={clsx(
          'ds-focus inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors duration-(--dur-base) disabled:opacity-45',
          checked ? 'justify-end border-transparent ds-gradient' : 'justify-start border-line-strong bg-press',
        )}
      >
        <motion.span layout transition={spring} className={clsx('size-3.5 rounded-full', checked ? 'bg-on-gradient' : 'bg-fg-muted')} />
      </button>
    </div>
  );
}

// One choice out of a few, all visible (a radio group with arrow keys).
export function Segmented({ options, value, onChange, label, size = 'md', className }) {
  const group = useId();
  const refs = useRef([]);
  const index = options.findIndex((o) => o.value === value);
  const onKeyDown = (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const next = (Math.max(index, 0) + dir + options.length) % options.length;
    onChange?.(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={clsx('inline-flex items-center gap-0.5 rounded-card border border-line bg-hover p-0.5', className)}>
      {options.map((o, i) => {
        const on = i === index;
        const OptionIcon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (index < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange?.(o.value)}
            className={clsx(
              'ds-focus relative inline-flex items-center rounded-tile font-medium transition-colors duration-(--dur-fast)',
              size === 'sm' ? 'h-6 px-2 text-caption' : 'h-8 px-3 text-small',
              on ? 'text-fg' : 'text-fg-subtle hover:text-fg',
            )}
          >
            {on && <motion.span layoutId={`seg-${group}`} transition={spring} className="absolute inset-0 rounded-tile bg-raised shadow-raised" />}
            <span className="relative inline-flex items-center gap-1.5">
              {OptionIcon && <OptionIcon className="size-3.5" aria-hidden />}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Tabs in groups, with a divider between groups: [{ value, label, icon?, group?, count? }].
export function Tabs({ tabs, value, onChange, label, className }) {
  const id = useId();
  const refs = useRef([]);
  const index = tabs.findIndex((t) => t.value === value);
  const onKeyDown = (e) => {
    let next;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange?.(tabs[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={clsx('ds-scroll flex items-center gap-0.5 overflow-x-auto border-b border-line px-1 pt-1', className)}>
      {tabs.map((t, i) => {
        const on = i === index;
        const TabIcon = t.icon;
        return (
          <span key={t.value} className="contents">
            {i > 0 && t.group !== tabs[i - 1].group && <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-line-strong" />}
            <button
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              id={`${id}-${t.value}`}
              aria-selected={on}
              aria-controls={t.panel}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange?.(t.value)}
              className={clsx(
                'ds-focus relative mb-1 inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-tile px-2.5 text-small font-medium transition-colors duration-(--dur-fast)',
                on ? 'text-fg' : 'text-fg-subtle hover:bg-hover hover:text-fg',
              )}
            >
              {TabIcon && <TabIcon className="size-4" aria-hidden />}
              {t.label}
              {t.count != null && <span className="rounded-full bg-hover px-1.5 text-micro text-fg-subtle">{t.count}</span>}
              {on && <motion.span layoutId={`tab-${id}`} transition={spring} className="absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-fg" />}
            </button>
          </span>
        );
      })}
    </div>
  );
}
