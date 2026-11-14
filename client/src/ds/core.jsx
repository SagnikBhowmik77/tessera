/* eslint-disable react-refresh/only-export-components */
// Tessera design system "Stained Glass", part 1: everything that needs no motion library
// (so screens made only of these stay light). The animated parts are in motion.jsx.
// Colours, radius, shadows and timing come from the tokens (ds/tokens.css + the @theme in
// index.css), never from one-off values. Every control works by keyboard, shows the shared focus
// outline, and never uses colour as the only signal. Motion follows the reduced-motion setting.
import { cloneElement, createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import {
  Bug, CalendarDays, Check, ChevronDown, Circle, CircleAlert, CircleCheck, CircleDashed, Info, Layers, Loader2, Sparkles, SquareCheck, X,
} from 'lucide-react';

export function Spinner({ className, label }) {
  return <Loader2 className={clsx('size-4 animate-spin', className)} aria-hidden={label ? undefined : true} aria-label={label} />;
}

export function Kbd({ children, onGradient, className }) {
  return (
    <kbd className={clsx(
      'inline-flex h-5 min-w-5 items-center justify-center rounded-hair border px-1 font-code text-micro font-medium',
      onGradient ? 'border-on-gradient/20 bg-on-gradient/10 text-on-gradient' : 'border-line-strong bg-hover text-fg-subtle',
      className,
    )}
    >
      {children}
    </kbd>
  );
}

/* ------------------------------------------------------------------ Buttons */

const BUTTON_SIZE = {
  sm: 'h-7 gap-1.5 rounded-tile px-2.5 text-caption',
  md: 'h-9 gap-2 rounded-tile px-3.5 text-small',
  lg: 'h-11 gap-2 rounded-card px-5 text-body',
};
// Icon-only buttons: square, no padding (kept separate so the padding never fights the width).
const BUTTON_SQUARE = {
  sm: 'size-7 rounded-tile',
  md: 'size-9 rounded-tile',
  lg: 'size-11 rounded-card',
};
const BUTTON_VARIANT = {
  primary: 'ds-btn-primary ds-gradient text-on-gradient shadow-raised hover:brightness-110 active:brightness-95',
  secondary: 'bg-raised text-fg shadow-raised hover:shadow-lift',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg active:bg-press',
  danger: 'bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/25',
};

// The button look, for things that must be links (<a>, router Link) rather than buttons.
export function buttonClasses({ variant = 'secondary', size = 'md', square = false, className } = {}) {
  return clsx(
    'ds-focus relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium',
    'transition-[color,background-color,box-shadow,filter,scale] duration-(--dur-fast) ease-glass active:scale-97 disabled:pointer-events-none disabled:opacity-45',
    square ? BUTTON_SQUARE[size] : BUTTON_SIZE[size], BUTTON_VARIANT[variant], className,
  );
}

// loading shows a spinner; done swaps it for a tick (and says "Done" to screen readers).
// CSS only (no motion library), so screens that are only buttons and fields stay light.
export function Button({ variant = 'secondary', size = 'md', square = false, loading = false, done = false, icon: Icon, kbd, className, children, type = 'button', disabled, ...props }) {
  const busy = loading && !done;
  const slot = busy ? 'busy' : done ? 'done' : Icon ? 'icon' : null;
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClasses({ variant, size, square, className })}
      {...props}
    >
      {slot && (
        <span className="grid size-4 place-items-center" aria-hidden>
          <span key={slot} className={clsx('grid place-items-center', slot !== 'icon' && 'ds-pop')}>
            {slot === 'busy' ? <Loader2 className="size-4 animate-spin" />
              : slot === 'done' ? <Check className="size-4" strokeWidth={2.75} />
                : <Icon className="size-4" />}
          </span>
        </span>
      )}
      {children}
      {kbd && <Kbd onGradient={variant === 'primary'} className="-mr-1 ml-0.5 pointer-coarse:hidden">{kbd}</Kbd>}
      <span className="sr-only" aria-live="polite">{done ? 'Done' : ''}</span>
    </button>
  );
}

// An icon-only button always has a name, and shows it (plus its shortcut) as a tooltip.
// className goes on the outer box (the one that is laid out), so ml-auto, absolute, etc. work.
export function IconButton({ label, shortcut, icon: Icon, size = 'md', variant = 'ghost', className, ...props }) {
  return (
    <Tooltip content={label} shortcut={shortcut} describe={false} className={className}>
      <Button variant={variant} size={size} square aria-label={label} {...props}>
        <Icon className="size-4 shrink-0" aria-hidden />
      </Button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ Tooltip */

// Opens on hover (after a short wait) and on keyboard focus; Escape hides it.
export function Tooltip({ content, shortcut, side = 'top', describe = true, className, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef(0);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const show = (delay) => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), delay); };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };
  return (
    <span
      className={clsx('relative inline-flex', className)}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') show(350); }}
      onPointerLeave={hide}
      onFocus={(e) => { if (e.target.matches(':focus-visible')) show(0); }}
      onBlur={hide}
      onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}
    >
      {cloneElement(children, describe ? { 'aria-describedby': open ? id : undefined } : {})}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={clsx(
            'ds-rise pointer-events-none absolute left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-tile bg-overlay px-2 py-1 text-caption font-medium text-fg shadow-overlay',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {content}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ Form fields */

const FieldCtx = createContext(null);

// Label, control and hint/error, wired together (label → control, hint → aria-describedby).
export function Field({ label, hint, error, required, children, className }) {
  const id = useId();
  const noteId = `${id}-note`;
  const labelId = `${id}-label`;
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      {label && (
        <label id={labelId} htmlFor={id} className="text-caption font-medium text-fg-muted">
          {label}{required && <span className="text-accent" aria-hidden> *</span>}
        </label>
      )}
      <FieldCtx.Provider value={{ id, labelId: label ? labelId : undefined, describedBy: error || hint ? noteId : undefined, invalid: Boolean(error), required }}>
        {children}
      </FieldCtx.Provider>
      {error
        ? <p id={noteId} className="flex items-center gap-1 text-caption text-danger"><CircleAlert className="size-3.5 shrink-0" aria-hidden />{error}</p>
        : hint ? <p id={noteId} className="text-caption text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export function useField({ id, invalid, required, 'aria-describedby': describedBy }) {
  const f = useContext(FieldCtx);
  return {
    labelId: f?.labelId,
    props: {
      id: id ?? f?.id,
      required: required ?? f?.required,
      'aria-invalid': (invalid ?? f?.invalid) || undefined,
      'aria-describedby': describedBy ?? f?.describedBy,
    },
  };
}

// A date that looks like every other field: "Set date" or "14 Nov 2026", in the field style. The
// browser's own date input sits invisibly over it, so clicking opens the native picker, typing and
// screen readers work as they always do, and the value is a plain YYYY-MM-DD.
const dateText = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export function DateField({ value, onChange, min, max, disabled, placeholder = 'Set date', className, ...rest }) {
  const shown = value ? dateText.format(new Date(`${value}T00:00:00Z`)) : placeholder;
  return (
    <span className={clsx('ds-focus-within relative flex h-8 items-center gap-2 rounded-tile border border-line-strong bg-field px-2.5 text-caption transition-[border-color] duration-(--dur-fast) hover:border-fg-faint', disabled && 'opacity-60', className)}>
      <CalendarDays className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      <span aria-hidden className={clsx('truncate', value ? 'text-fg' : 'text-fg-subtle')}>{shown}</span>
      <input
        type="date" value={value ?? ''} min={min} max={max} disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch { /* not allowed here */ } }}
        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
        {...rest}
      />
    </span>
  );
}

// A plain <select> inside a Field, labelled by it (the Field's label points at this id). Use the
// styled Select where a custom menu fits; this one is for long native lists (time zones, people).
export function FieldSelect(props) {
  const { props: field } = useField(props);
  return <select {...props} {...field} />;
}

export const FIELD_BOX = clsx(
  'ds-focus w-full rounded-tile border border-line-strong bg-field text-small text-fg placeholder:text-fg-subtle',
  'transition-[border-color,background-color] duration-(--dur-fast) hover:border-fg-faint aria-invalid:border-danger',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

// size: md (forms) or sm (toolbars). icon: a leading icon inside the field (e.g. Search).
export function Input({ className, invalid, size = 'md', icon: Icon, ...props }) {
  const { props: f } = useField({ ...props, invalid });
  const pad = Icon ? (size === 'sm' ? 'pl-8 pr-2.5' : 'pl-9 pr-3') : (size === 'sm' ? 'px-2.5' : 'px-3');
  const field = <input className={clsx(FIELD_BOX, size === 'sm' ? 'h-8 text-caption' : 'h-9', pad, className)} {...props} {...f} />;
  if (!Icon) return field;
  return (
    <div className="relative">
      <Icon className={clsx('pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-fg-subtle', size === 'sm' ? 'left-2.5' : 'left-3')} aria-hidden />
      {field}
    </div>
  );
}

export function Textarea({ className, invalid, ...props }) {
  const { props: f } = useField({ ...props, invalid });
  return <textarea className={clsx(FIELD_BOX, 'min-h-24 resize-y px-3 py-2 leading-relaxed', className)} {...props} {...f} />;
}

// A select that looks like the rest of the app (the native one can't be styled) and keeps the
// keyboard of a real one: arrows, Home/End, Enter/Space, Escape, Tab, and type-to-jump.
// options: [{ value, label, description?, icon? (component), leading? (element), disabled? }]
export function Select({ value, onChange, options, placeholder = 'Choose…', size = 'md', className, disabled, ...rest }) {
  const { props: f, labelId } = useField(rest);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const button = useRef(null);
  const typed = useRef({ text: '', at: 0 });
  const base = useId();
  const listId = `${base}-list`;
  const optId = (i) => `${base}-opt-${i}`;
  const selected = options.findIndex((o) => o.value === value);
  const current = options[selected];

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => { document.removeEventListener('pointerdown', away); };
  }, [open]);
  useEffect(() => {
    if (open) { document.getElementById(`${base}-opt-${active}`)?.scrollIntoView({ block: 'nearest' }); }
  }, [open, active, base]);

  const show = () => { setActive(selected >= 0 ? selected : 0); setOpen(true); };
  const pick = (i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange?.(o.value);
    setOpen(false);
    button.current?.focus();
  };
  const step = (from, dir) => {
    let i = from;
    for (let n = 0; n < options.length; n += 1) {
      i = (i + dir + options.length) % options.length;
      if (!options[i].disabled) return i;
    }
    return from;
  };
  const typeahead = (key) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at > 700 ? '' : typed.current.text) + key.toLowerCase(), at: now };
    const i = options.findIndex((o) => !o.disabled && String(o.label).toLowerCase().startsWith(typed.current.text));
    if (i < 0) return;
    if (open) setActive(i); else onChange?.(options[i].value);
  };
  const onKeyDown = (e) => {
    const k = e.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) { e.preventDefault(); show(); } else if (k.length === 1) typeahead(k);
      return;
    }
    if (k === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (k === 'Home') { e.preventDefault(); setActive(step(-1, 1)); }
    else if (k === 'End') { e.preventDefault(); setActive(step(options.length, -1)); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(active); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (k === 'Tab') setOpen(false);
    else if (k.length === 1) typeahead(k);
  };

  const CurrentIcon = current?.icon;
  return (
    <div ref={root} className={clsx('relative', className)}>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optId(active) : undefined}
        aria-label={rest['aria-label']}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={clsx(FIELD_BOX, 'flex items-center gap-2 text-left', size === 'sm' ? 'h-8 px-2.5 text-caption' : 'h-9 px-3')}
        {...f}
      >
        {current?.leading ?? (CurrentIcon && <CurrentIcon className="size-4 shrink-0 text-fg-muted" aria-hidden />)}
        <span className={clsx('min-w-0 flex-1 truncate', !current && 'text-fg-subtle')}>{current?.label ?? placeholder}</span>
        <ChevronDown className={clsx('size-4 shrink-0 text-fg-subtle transition-transform duration-(--dur-fast)', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          aria-label={labelId ? undefined : rest['aria-label'] ?? placeholder}
          className="ds-drop ds-scroll absolute left-0 top-full z-40 mt-1.5 max-h-64 w-full min-w-48 overflow-auto rounded-card bg-overlay p-1 shadow-overlay"
        >
          {options.map((o, i) => {
            const OptionIcon = o.icon;
            const isSelected = i === selected;
            return (
              <li
                key={o.value}
                id={optId(i)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onPointerMove={() => { if (!o.disabled) setActive(i); }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={clsx(
                  'flex cursor-default items-center gap-2 rounded-tile px-2.5 py-1.5 text-small',
                  i === active ? 'bg-hover text-fg' : 'text-fg-muted',
                  o.disabled && 'opacity-45',
                )}
              >
                {o.leading ?? (OptionIcon && <OptionIcon className="size-4 shrink-0" aria-hidden />)}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.description && <span className="block truncate text-caption text-fg-subtle">{o.description}</span>}
                </span>
                {isSelected && <Check className="size-4 shrink-0 text-fg" aria-hidden />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// A filter that is on or off (aria-pressed). On reads as ink, so it never competes with the
// gradient of the main action.
export function Toggle({ pressed, onChange, icon: Icon, className, children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={Boolean(pressed)}
      onClick={() => onChange?.(!pressed)}
      className={clsx(
        'ds-focus inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-caption font-medium transition-colors duration-(--dur-fast)',
        pressed ? 'border-transparent bg-fg text-canvas' : 'border-line-strong text-fg-muted hover:border-fg-faint hover:text-fg',
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
      {children}
    </button>
  );
}

export function Checkbox({ label, description, className, ...props }) {
  return (
    <label className={clsx('flex w-fit cursor-pointer items-start gap-2.5 text-small text-fg', props.disabled && 'cursor-not-allowed opacity-50', className)}>
      <span className="mt-0.5 grid shrink-0 place-items-center">
        <input
          type="checkbox"
          className="ds-focus peer col-start-1 row-start-1 m-0 size-4 cursor-[inherit] appearance-none rounded-hair border border-line-strong bg-field transition-colors duration-(--dur-fast) checked:border-transparent checked:ds-gradient"
          {...props}
        />
        <Check className="pointer-events-none col-start-1 row-start-1 size-3 text-on-gradient opacity-0 peer-checked:opacity-100" strokeWidth={3.25} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description && <span className="block text-caption text-fg-subtle">{description}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ Ticket marks */

const STATUS = {
  todo: { label: 'To do', Icon: Circle, tone: 'text-status-todo' },
  in_progress: { label: 'In progress', Icon: CircleDashed, tone: 'text-status-progress' },
  done: { label: 'Done', Icon: CircleCheck, tone: 'text-status-done' },
};

// Status category (todo / in_progress / done) with an icon and words, never colour alone.
export function StatusPill({ status, label, size = 'md', className }) {
  const s = STATUS[status] ?? STATUS.todo;
  return (
    <span className={clsx(
      'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-medium text-fg-muted',
      size === 'sm' ? 'h-5 px-1.5 text-micro' : 'h-6 px-2 text-caption',
      status === 'done' ? 'border-transparent bg-raised shadow-done' : 'border-line bg-hover',
      className,
    )}
    >
      <s.Icon className={clsx('size-3.5 shrink-0', s.tone)} strokeWidth={2.25} aria-hidden />
      {label ?? s.label}
    </span>
  );
}

const PRIORITY = {
  critical: { label: 'Critical', bars: 4, tone: 'text-prio-critical' },
  high: { label: 'High', bars: 3, tone: 'text-prio-high' },
  medium: { label: 'Medium', bars: 2, tone: 'text-prio-medium' },
  low: { label: 'Low', bars: 1, tone: 'text-prio-low' },
};

// Signal bars: the number of filled bars carries the meaning, colour only adds to it.
export function PriorityMark({ priority, withLabel, className }) {
  const p = PRIORITY[priority] ?? PRIORITY.medium;
  return (
    <span
      className={clsx('inline-flex shrink-0 items-center gap-1.5 text-caption font-medium text-fg-muted', className)}
      {...(withLabel ? {} : { role: 'img', 'aria-label': `${p.label} priority` })}
    >
      <svg viewBox="0 0 14 14" className={clsx('size-3.5 shrink-0', p.tone)} aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={1 + i * 3.25} y={10 - i * 3} width="2.4" height={3 + i * 3} rx="1" fill="currentColor" opacity={i < p.bars ? 1 : 0.22} />
        ))}
      </svg>
      {withLabel && p.label}
    </span>
  );
}

// The ticket key (SHOP-12): the same mono chip wherever a key shows. keyChipClasses is for a key
// that is also a link (components/ui.jsx KeyLink).
export const keyChipClasses = 'inline-flex h-5 shrink-0 items-center rounded-hair border border-key-line bg-key-bg px-1.5 align-[1px] font-code text-micro font-medium tracking-tight text-key';
export const TICKET_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
export function KeyChip({ children, className, ...props }) {
  return (
    <span className={clsx(keyChipClasses, className)} data-ticket-key={typeof children === 'string' && TICKET_KEY.test(children) ? children : undefined} {...props}>
      {children}
    </span>
  );
}

const BADGE = {
  neutral: 'border-line bg-hover text-fg-muted',
  accent: 'border-transparent bg-accent-soft text-accent',
  success: 'border-transparent bg-success/12 text-success',
  warning: 'border-transparent bg-warning/12 text-warning',
  danger: 'border-transparent bg-danger/12 text-danger',
  info: 'border-transparent bg-info/12 text-info',
};

export function Badge({ tone = 'neutral', icon: Icon, children, className, ...props }) {
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-hair border px-1.5 text-micro font-medium', BADGE[tone] ?? BADGE.neutral, className)} {...props}>
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ People */

const AVATAR_FILLS = ['--brand-amber', '--brand-rose', '--brand-violet', '--avatar-sky', '--avatar-mint', '--avatar-orchid'];
const AVATAR_SIZE = { sm: 'size-5 text-[0.5625rem]', md: 'size-7 text-micro', lg: 'size-9 text-caption', xl: 'size-12 text-body' };

function firstGrapheme(s) {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)][0]?.segment ?? '';
  } catch {
    return s[0] ?? '';
  }
}

// Initials that work for any script (a Bengali conjunct stays whole).
export function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = firstGrapheme(parts[0]);
  const last = parts.length > 1 ? firstGrapheme(parts[parts.length - 1]) : '';
  return (first + last).toLocaleUpperCase();
}

// FNV-1a: spreads similar names across the fills (a plain *31 hash clumps them).
function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h;
}

export function Avatar({ name, id, size = 'md', presence, className }) {
  const fill = AVATAR_FILLS[hash(id ?? name) % AVATAR_FILLS.length];
  const face = (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ background: `var(${fill})` }}
      className={clsx('inline-grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none text-on-glass', AVATAR_SIZE[size], presence && 'ring-2 ring-canvas', !presence && className)}
    >
      <span aria-hidden>{initialsOf(name)}</span>
    </span>
  );
  if (!presence) return face;
  return (
    <span className={clsx('ds-presence relative inline-grid shrink-0 place-items-center rounded-full p-0.5 ds-gradient', className)}>
      {face}
      <span className="sr-only">(here now)</span>
    </span>
  );
}

/* ------------------------------------------------------------------ Surfaces */

const LEVEL = {
  surface: 'bg-surface shadow-surface',
  raised: 'bg-raised shadow-raised',
  overlay: 'bg-overlay shadow-overlay',
};

// A card on one of the three levels. spotlight: a soft light follows the pointer.
export function Card({ level = 'raised', spotlight, interactive, as: Tag = 'div', className, children, onPointerMove, ...props }) {
  const move = (e) => {
    if (spotlight) {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
      e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    onPointerMove?.(e);
  };
  return (
    <Tag
      className={clsx(
        'rounded-card', LEVEL[level], spotlight && 'ds-spotlight',
        interactive && 'transition-[box-shadow,translate] duration-(--dur-base) ease-glass hover:-translate-y-px hover:shadow-lift',
        className,
      )}
      onPointerMove={move}
      {...props}
    >
      {children}
    </Tag>
  );
}

const TILE = {
  todo: 'bg-status-todo/40',
  in_progress: 'bg-status-progress',
  done: 'bg-status-done shadow-done',
};
const TILE_SIZE = { sm: 'size-2.5 rounded-shard', md: 'size-3.5 rounded-shard', lg: 'size-5 rounded-hair' };

// The signature: one tile per ticket, coloured by status, plus dashed slots still open.
// tiles: [{ status, key?, fresh? }] (fresh: new since last drawn, so it sets itself in). It reads as
// one image with a summary for screen readers.
export function Mosaic({ tiles = [], empty = 0, columns, size = 'md', animate = false, label, className }) {
  const count = (s) => tiles.filter((t) => t.status === s).length;
  const total = tiles.length;
  const summary = label ?? `${total} ${total === 1 ? 'ticket' : 'tickets'}: ${count('todo')} to do, ${count('in_progress')} in progress, ${count('done')} done${empty ? `; ${empty} open slots` : ''}`;
  const cols = columns ?? Math.max(4, Math.ceil(Math.sqrt((total + empty) * 2.5)));
  return (
    <div role="img" aria-label={summary} className={clsx('grid w-max gap-1', className)} style={{ gridTemplateColumns: `repeat(${cols}, max-content)` }}>
      {tiles.map((t, i) => (
        <span
          key={t.key ?? i}
          className={clsx(TILE_SIZE[size], TILE[t.status] ?? TILE.todo, 'transition-[background-color,box-shadow] duration-(--dur-slow)', (animate || t.fresh) && 'ds-tile-set')}
          style={animate ? { animationDelay: `${i * 28}ms` } : undefined}
        />
      ))}
      {Array.from({ length: empty }, (_, i) => <span key={`slot-${i}`} className={clsx(TILE_SIZE[size], 'border border-dashed border-line-strong')} />)}
    </div>
  );
}

export function Skeleton({ className }) {
  return <span aria-hidden className={clsx('ds-skeleton block rounded-tile', className)} />;
}

// What a place looks like before anything is in it: honest words and the next step.
// tone "quiet" (default): nothing here yet. tone "lost": something is missing or went wrong, so
// the middle tile is cracked out of the grid instead of waiting to be filled.
// as: the heading level that fits the page (h1 when it is the whole page).
// Pointer position over the empty-state grid, from -1 to 1, kept in CSS variables.
const tilt = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--tx', ((e.clientX - r.left) / r.width * 2 - 1).toFixed(3));
  e.currentTarget.style.setProperty('--ty', ((e.clientY - r.top) / r.height * 2 - 1).toFixed(3));
};
const untilt = (e) => { e.currentTarget.style.setProperty('--tx', '0'); e.currentTarget.style.setProperty('--ty', '0'); };

export function EmptyState({ icon: Icon, title, children, action, secondary, className, tone = 'quiet', as: Heading = 'h2' }) {
  const lost = tone === 'lost';
  return (
    <div className={clsx('mx-auto flex max-w-md flex-col items-center px-6 py-12 text-center', className)}>
      {/* The tiles lean a little towards the cursor (CSS only; off for reduced motion and touch). */}
      <div aria-hidden className="ds-tilt mb-6 grid grid-cols-3 gap-1.5" onPointerMove={tilt} onPointerLeave={untilt}>
        {Array.from({ length: 9 }, (_, i) => (i === 4
          ? <span key={i} className={clsx('grid size-11 place-items-center rounded-card bg-raised shadow-raised', lost ? 'rotate-6 text-warning' : 'text-fg-muted')}>{Icon && <Icon className="size-5" />}</span>
          : <span key={i} className={clsx('size-11 rounded-card border border-dashed border-line-strong', i % 2 === 0 && 'opacity-50')} />))}
      </div>
      <Heading className="font-display text-h1 italic text-balance text-fg">{title}</Heading>
      {children && <p className="mt-2 text-pretty text-small text-fg-muted">{children}</p>}
      {(action || secondary) && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{action}{secondary}</div>}
    </div>
  );
}

// The same idea at the size of one line, for a panel or list with nothing in it yet: an empty
// tile outline, then what is missing (and, when it helps, how to change that).
export function EmptyNote({ children, action, size = 'sm', className }) {
  return (
    <p className={clsx('flex items-start gap-2 text-fg-subtle', size === 'xs' ? 'text-caption' : 'text-small', className)}>
      <span aria-hidden className={clsx('mt-1 shrink-0 rounded-shard border border-dashed border-line-strong', size === 'xs' ? 'size-2' : 'size-2.5')} />
      <span className="min-w-0 text-pretty">{children}{action && <> {action}</>}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ Overlays */

const TOAST = {
  success: { Icon: CircleCheck, tone: 'text-success' },
  error: { Icon: CircleAlert, tone: 'text-danger' },
  info: { Icon: Info, tone: 'text-info' },
};

// What a notification looks like (react-hot-toast renders these in step 4).
export function ToastCard({ tone = 'success', title, children, action, className }) {
  const t = TOAST[tone] ?? TOAST.info;
  return (
    <div className={clsx('flex w-full max-w-sm items-start gap-3 rounded-card bg-overlay px-4 py-3 shadow-overlay', className)}>
      <t.Icon className={clsx('mt-0.5 size-4 shrink-0', t.tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-small font-medium text-fg">{title}</p>
        {children && <p className="mt-0.5 text-caption text-fg-muted">{children}</p>}
      </div>
      {action}
    </div>
  );
}

const TYPE = {
  bug: { label: 'Bug', Icon: Bug, tone: 'text-danger' },
  feature: { label: 'Feature', Icon: Sparkles, tone: 'text-info' },
  task: { label: 'Task', Icon: SquareCheck, tone: 'text-success' },
  epic: { label: 'Epic', Icon: Layers, tone: 'text-status-done' },
};

// A ticket's type as a small coloured icon that also has a name.
export function TypeMark({ type, className }) {
  const t = TYPE[type] ?? TYPE.task;
  return <t.Icon className={clsx('size-4 shrink-0', t.tone, className)} role="img" aria-label={t.label} />;
}

/* ------------------------------------------------------------------ Dialog */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A dialog (CSS only): a sheet from the bottom on phones, centred above. Focus moves in, stays in
// (Tab wraps), and returns to where it was; Escape and the backdrop close it.
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }) {
  const panel = useRef(null);
  const close = useRef(onClose);
  const titleId = useId();
  const descId = useId();
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current?.(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    const frame = requestAnimationFrame(() => {
      // In order of preference (one querySelector with a list would pick by position instead).
      const target = panel.current?.querySelector('[data-autofocus], [autofocus]')
        ?? panel.current?.querySelector('input:not([type=hidden]), textarea, [role=combobox]')
        ?? panel.current?.querySelector('[data-dialog-body] button, [data-dialog-footer] button')
        ?? panel.current?.querySelector('button');
      target?.focus();
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      if (before instanceof HTMLElement) before.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div aria-hidden className="ds-fade absolute inset-0 bg-canvas/70 backdrop-blur-sm" onClick={() => close.current?.()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={clsx('ds-panel relative flex max-h-[92dvh] w-full flex-col rounded-t-panel bg-overlay shadow-overlay sm:rounded-panel', size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md')}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-display text-h1 italic text-fg">{title}</h2>
            {description && <p id={descId} className="mt-1 text-small text-fg-muted">{description}</p>}
          </div>
          <IconButton label="Close" shortcut="Esc" icon={X} size="sm" onClick={() => close.current?.()} />
        </div>
        <div data-dialog-body className="ds-scroll overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div data-dialog-footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ Menu */

const MenuCtx = createContext(null);

// A dropdown menu (CSS only). trigger(props) renders the button; spread the props onto it.
// Keyboard: ArrowDown opens, arrows/Home/End move, Escape closes and returns focus, Tab leaves.
export function Menu({ trigger, label, align = 'start', width = 'w-56', className, children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const list = useRef(null);
  const id = useId();
  const items = () => [...(list.current?.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    const frame = requestAnimationFrame(() => {
      const all = items();
      (all.find((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-current') === 'page') ?? all[0])?.focus();
    });
    return () => { document.removeEventListener('pointerdown', away); cancelAnimationFrame(frame); };
  }, [open]);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) root.current?.querySelector('[data-menu-trigger]')?.focus();
  };
  const onKeyDown = (e) => {
    if (!open) return;
    const all = items();
    const i = all.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); all[(n + all.length) % all.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? all.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const triggerProps = {
    'data-menu-trigger': '',
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: () => setOpen((o) => !o),
    onKeyDown: (e) => { if (!open && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } },
  };
  return (
    <div ref={root} className={clsx('relative', className)} onKeyDown={onKeyDown}>
      {trigger(triggerProps, open)}
      {open && (
        <MenuCtx.Provider value={close}>
          <div
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            className={clsx('ds-drop ds-scroll absolute top-full z-40 mt-1.5 max-h-80 overflow-y-auto rounded-card bg-overlay p-1 shadow-overlay', align === 'end' ? 'right-0' : 'left-0', width)}
          >
            {children}
          </div>
        </MenuCtx.Provider>
      )}
    </div>
  );
}

// One entry. as={Link} for navigation; checked (true/false) makes it a radio item.
export function MenuItem({ as: Tag = 'button', icon: Icon, leading, trailing, checked, current, onClick, className, children, ...props }) {
  const close = useContext(MenuCtx);
  return (
    <Tag
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      tabIndex={-1}
      aria-checked={checked}
      aria-current={current ? 'page' : undefined}
      {...(Tag === 'button' ? { type: 'button' } : {})}
      onClick={(e) => { onClick?.(e); close?.(false); }}
      className={clsx(
        'ds-focus flex w-full items-center gap-2.5 rounded-tile px-2.5 py-1.5 text-left text-small ds-focus-inset hover:bg-hover hover:text-fg focus:bg-hover focus:text-fg',
        checked || current ? 'font-medium text-fg' : 'text-fg-muted',
        className,
      )}
      {...props}
    >
      {leading ?? (Icon && <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
      {(checked || current) && <Check className="size-4 shrink-0 text-fg" aria-hidden />}
    </Tag>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px bg-line" />;
}

/* ------------------------------------------------------------------ Brand */

// Seeded random numbers, so the window is the same picture on every visit (no layout shift).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Split a rectangle again and again into panes, like leaded glass. Exported for the live
// (canvas) version of the window, so the static and live windows are the same picture.
export function panes(seed, width, height) {
  const rand = seeded(seed);
  const out = [];
  const split = (x, y, w, h, depth) => {
    const stop = depth >= 6 || (depth >= 3 && rand() < 0.28) || w < 9 || h < 9;
    if (stop) { out.push({ x, y, w, h, r: rand() }); return; }
    const t = 0.3 + rand() * 0.4;
    if (w > h * (0.8 + rand() * 0.4)) {
      split(x, y, w * t, h, depth + 1);
      split(x + w * t, y, w * (1 - t), h, depth + 1);
    } else {
      split(x, y, w, h * t, depth + 1);
      split(x, y + h * t, w, h * (1 - t), depth + 1);
    }
  };
  split(0, 0, width, height, 0);
  return out;
}

// The brand gradient sampled at a point (amber → rose → violet along the diagonal).
export const GLASS_STOPS = [[0xF7, 0xB2, 0x3B], [0xF2, 0x55, 0x7D], [0x8B, 0x6C, 0xF6]];
const STOPS = GLASS_STOPS;
export function glassColour(t) {
  const u = Math.min(Math.max(t, 0), 1) * 2;
  const [a, b] = u < 1 ? [STOPS[0], STOPS[1]] : [STOPS[1], STOPS[2]];
  const k = u < 1 ? u : u - 1;
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(' ')})`;
}

// The signature artwork: a window of glass panes lit by the brand gradient. A few panes are
// still clear (dashed), like open slots on a board. It is decoration, hidden from screen readers.
// The panes are set one after another on first view (CSS only; still if motion is reduced).
export function StainedWindow({ seed = 7, width = 100, height = 120, missing = -1, className }) {
  const list = panes(seed, width, height);
  const gap = 1.1;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden preserveAspectRatio="xMidYMid slice">
      {list.map((p, i) => {
        const t = (p.x + p.w / 2) / width * 0.55 + (p.y + p.h / 2) / height * 0.45;
        const gone = i === missing;
        const clear = p.r < 0.14 || gone;
        const strength = 0.32 + p.r * 0.68;
        return (
          <rect
            key={i}
            x={p.x + gap / 2}
            y={p.y + gap / 2}
            width={Math.max(p.w - gap, 0)}
            height={Math.max(p.h - gap, 0)}
            rx="1.2"
            className="ds-tile-set"
            style={{ animationDelay: `${Math.round(t * 900 + p.r * 260)}ms`, transformOrigin: `${p.x + p.w / 2}px ${p.y + p.h / 2}px`, transformBox: 'view-box' }}
            fill={clear ? 'none' : glassColour(t)}
            fillOpacity={clear ? undefined : strength}
            stroke={gone ? 'var(--c-accent)' : clear ? 'var(--c-line-strong)' : 'none'}
            strokeWidth={gone ? 0.7 : clear ? 0.35 : undefined}
            strokeDasharray={clear ? '1.2 1' : undefined}
          />
        );
      })}
    </svg>
  );
}

// The mark: four panes of glass of different sizes, lit by one gradient across all of them.
export function Logo({ size = 28, wordmark = false, className }) {
  const raw = useId();
  const gid = `tess${raw.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" role={wordmark ? undefined : 'img'} aria-label={wordmark ? undefined : 'Tessera'} aria-hidden={wordmark || undefined}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: 'var(--brand-amber)' }} />
            <stop offset="0.48" style={{ stopColor: 'var(--brand-rose)' }} />
            <stop offset="1" style={{ stopColor: 'var(--brand-violet)' }} />
          </linearGradient>
        </defs>
        <g fill={`url(#${gid})`}>
          <rect x="2" y="2" width="14" height="11" rx="3" />
          <rect x="18" y="2" width="12" height="17" rx="3" />
          <rect x="2" y="15" width="14" height="15" rx="3" />
          <rect x="18" y="21" width="12" height="9" rx="3" />
        </g>
        {/* Light catching the top of each pane (same as the icons made by scripts/brand.mjs). */}
        <g fill="#fff" opacity=".13">
          <rect x="3.2" y="3" width="11.6" height="3" rx="1.5" />
          <rect x="19.2" y="3" width="9.6" height="3" rx="1.5" />
          <rect x="3.2" y="16" width="11.6" height="3" rx="1.5" />
          <rect x="19.2" y="22" width="9.6" height="3" rx="1.5" />
        </g>
      </svg>
      {wordmark && <span className="font-display text-h1 italic leading-none tracking-tight text-fg">Tessera</span>}
    </span>
  );
}

export { STATUS as STATUS_META, PRIORITY as PRIORITY_META };

/* ------------------------------------------------------------------ Inline editing */

// "Saving…" then a small tick that says "Saved" and fades (1.4 s). run(promise) takes what the save
// returns: true when it saved, false when it was refused (the caller has already said why).
export function useSaved() {
  const [state, setState] = useState('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async (pending) => {
    clearTimeout(timer.current);
    setState('saving');
    const ok = await pending;
    setState(ok ? 'saved' : 'idle');
    if (ok) timer.current = setTimeout(() => setState('idle'), 1400);
    return ok;
  };
  return [state, run];
}

export function SavedTick({ state, className }) {
  return (
    <span role="status" aria-live="polite" className={clsx('pointer-events-none inline-flex items-center text-caption', className)}>
      {state === 'saving' && <span className="ds-fade text-fg-subtle">Saving…</span>}
      {state === 'saved' && <span className="ds-pop inline-flex items-center gap-1 rounded-full bg-success/12 px-1.5 py-0.5 font-medium text-success"><Check className="size-3" strokeWidth={3} aria-hidden />Saved</span>}
    </span>
  );
}

// Text that is edited where it stands: click (or Tab) into it, Enter saves, Escape puts the old
// value back (and does not close the drawer or dialog around it), leaving the field saves too.
// onSave(value) returns a promise of true/false; the tick shows only for a real save.
export function InlineText({ value, onSave, label, readOnly, required = false, multiline = false, as = 'textarea', parse = (v) => v.trim(), format = (v) => v ?? '', className, tickClassName = 'absolute -bottom-5 right-0', ...props }) {
  const ref = useRef(null);
  const skip = useRef(false);
  const [state, run] = useSaved();
  const shown = format(value);
  const commit = () => {
    if (skip.current) { skip.current = false; return; }
    const el = ref.current;
    const next = parse(el.value);
    if (String(next ?? '') === String(value ?? '') || (required && !next)) { el.value = shown; return; }
    run(onSave(next));
  };
  const Field = as;
  return (
    <span className="relative block">
      <Field
        key={shown}
        ref={ref}
        defaultValue={shown}
        readOnly={readOnly}
        aria-label={label}
        rows={as === 'textarea' ? 1 : undefined}
        className={className}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (!multiline || !e.shiftKey)) { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip.current = true; e.currentTarget.value = shown; e.currentTarget.blur(); }
        }}
        onBlur={commit}
        {...props}
      />
      <SavedTick state={state} className={tickClassName} />
    </span>
  );
}

// A button's success tick (Button done={...}) for 1.4 s after a save that really worked:
// const [done, flash] = useDoneFlash(); ... after success: flash().
export function useDoneFlash(ms = 1400) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = () => { clearTimeout(timer.current); setDone(true); timer.current = setTimeout(() => setDone(false), ms); };
  return [done, flash];
}
