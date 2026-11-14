/* eslint-disable react-refresh/only-export-components */
// The app's first set of building blocks, kept as thin adapters so every screen that still uses
import { Link } from 'react-router';
// them gets the design system ("Stained Glass", ds/core.jsx) without changing its code. New code
// imports from ../ds/core.jsx directly.
import clsx from 'clsx';
import * as ds from '../ds/core.jsx';

export const Spinner = ds.Spinner;
export const EmptyState = ds.EmptyState;

// size: 'sm' | 'md' | 'icon' (square). variant as before: primary, secondary, ghost, danger.
export function Button({ size = 'md', ...props }) {
  return <ds.Button size={size === 'icon' ? 'md' : size} square={size === 'icon'} {...props} />;
}

// Label wrapped around its input (so any plain input inside is labelled), with a hint or error.
export function Field({ label, error, hint, children, className }) {
  return (
    <label className={clsx('block space-y-1.5', className)}>
      {label && <span className="label">{label}</span>}
      {children}
      {error
        ? <span className="flex items-center gap-1 text-caption text-danger">{error}</span>
        : hint ? <span className="block text-caption text-fg-subtle">{hint}</span> : null}
    </label>
  );
}

export function Avatar({ user, size = 'md', className }) {
  if (!user) return null;
  return <ds.Avatar name={user.name} id={user.id} size={size} className={className} />;
}

export function TypeIcon({ type, className }) {
  return <ds.TypeMark type={type} className={className} />;
}

export function PriorityDot({ priority, withLabel }) {
  return <ds.PriorityMark priority={priority} withLabel={withLabel} />;
}

const TONE = { zinc: 'neutral', brand: 'accent', red: 'danger', amber: 'warning', teal: 'success' };
export function Badge({ tone = 'zinc', ...props }) {
  return <ds.Badge tone={TONE[tone] ?? tone} {...props} />;
}

export function Modal({ open, onClose, title, children, footer, wide }) {
  return <ds.Dialog open={open} onClose={onClose} title={title} footer={footer} size={wide ? 'lg' : 'md'}>{children}</ds.Dialog>;
}

// "Are you sure?" before anything is deleted. The confirm button has focus, so Enter confirms; Escape cancels.
export function ConfirmDialog({ open, title, children, confirmLabel = 'Delete', busy, onConfirm, onCancel }) {
  return (
    <ds.Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={(
        <>
          <ds.Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</ds.Button>
          <ds.Button variant="danger" loading={busy} onClick={onConfirm} data-autofocus>{confirmLabel}</ds.Button>
        </>
      )}
    >
      <div className="text-small text-fg-muted">{children}</div>
    </ds.Dialog>
  );
}

// Language picker for the public pages (E11): { lang, setLang, label, languages: [[code, name]] }.
export function LangPicker({ lang, setLang, label, languages }) {
  return (
    <div className="flex items-center justify-end gap-2 text-caption text-fg-subtle">
      <span aria-hidden className="max-sm:hidden">{label}</span>
      <ds.Select size="sm" className="w-36 sm:w-40" value={lang} onChange={setLang} aria-label={label} options={languages.map(([code, name]) => ({ value: code, label: name }))} />
    </div>
  );
}

// The mark alone, sized by className (e.g. size-8).
export function Logo({ className }) {
  return <span className={clsx('inline-grid', className)}><ds.Logo size="100%" /></span>;
}

// A ticket key that opens its ticket: the key chip, as a link.
export function KeyLink({ to, children, className }) {
  return <Link to={to} data-ticket-key={typeof children === 'string' && ds.TICKET_KEY.test(children) ? children : undefined} className={clsx(ds.keyChipClasses, 'ds-focus transition-colors duration-(--dur-fast) hover:border-key hover:bg-hover', className)}>{children}</Link>;
}
