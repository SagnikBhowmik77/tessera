import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { Avatar, KeyChip, PriorityMark, Skeleton, StatusPill, TypeMark } from '../ds/core.jsx';

// Hover (or focus) any ticket key, anywhere, and a small card shows what it is: type, status,
// title, who has it, priority and due date. One listener for the whole app: a key is any element
// with data-ticket-key (KeyChip and KeyLink set it). Its project comes from the nearest
// [data-project-id], the link it points to, or the page's address. The data is the same cached
// query the drawer uses, so a key you have looked at opens instantly and nothing is fetched twice.

const SHOW_AFTER = 350;
const projectOf = (el) => el.closest('[data-project-id]')?.dataset.projectId
  ?? /\/projects\/([a-f0-9]{24})/.exec(el.getAttribute('href') ?? '')?.[1]
  ?? /\/projects\/([a-f0-9]{24})/.exec(window.location.pathname)?.[1];

export default function KeyPreview() {
  const qc = useQueryClient();
  const [at, setAt] = useState(null); // { el, pid, key, number, rect }
  const [data, setData] = useState(null); // { ticket, project } | { error }
  const timer = useRef(0);
  const shown = useRef(null);

  useEffect(() => {
    const target = (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-ticket-key]') : null;
      if (!el || el.closest('[data-ticket-card], [data-no-preview]')) return null;
      return el;
    };
    const open = (el) => {
      const pid = projectOf(el);
      const key = el.dataset.ticketKey;
      const number = Number(key.split('-').pop());
      if (!pid || !number) return;
      shown.current = el;
      el.setAttribute('aria-describedby', 'key-preview');
      setAt({ el, pid, key, number, rect: el.getBoundingClientRect() });
      setData(null);
      Promise.all([
        qc.fetchQuery({ queryKey: qk.ticket(pid, number), queryFn: () => api(`/projects/${pid}/tickets/${number}`).then((d) => d.ticket), staleTime: 30_000 }),
        qc.fetchQuery({ queryKey: qk.project(pid), queryFn: () => api(`/projects/${pid}`).then((d) => d.project), staleTime: 60_000 }),
      ]).then(([ticket, project]) => { if (shown.current === el) setData({ ticket, project }); })
        .catch((err) => { if (shown.current === el) setData({ error: err.status === 404 ? 'This ticket no longer exists.' : 'Could not load this ticket.' }); });
    };
    const close = () => {
      clearTimeout(timer.current);
      shown.current?.removeAttribute('aria-describedby');
      shown.current = null;
      setAt(null);
    };
    const over = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const el = target(e);
      if (!el || el === shown.current) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => open(el), SHOW_AFTER);
    };
    const out = (e) => {
      const el = target(e);
      if (!el || el.contains(e.relatedTarget)) return;
      clearTimeout(timer.current);
      if (el === shown.current) close();
    };
    const focus = (e) => { const el = target(e); if (el && el.matches(':focus-visible')) open(el); };
    const blur = (e) => { if (target(e) === shown.current) close(); };
    const key = (e) => { if (e.key === 'Escape' && shown.current) close(); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
    };
  }, [qc]);

  if (!at) return null;
  // Below the key, or above it when there is no room; kept inside the window.
  const width = 288;
  const below = at.rect.bottom + 180 < window.innerHeight;
  const left = Math.min(Math.max(8, at.rect.left), window.innerWidth - width - 8);
  const style = below ? { top: at.rect.bottom + 6, left, width } : { bottom: window.innerHeight - at.rect.top + 6, left, width };
  const t = data?.ticket;
  const status = t && data.project?.statuses.find((s) => s.key === t.status);
  return createPortal(
    <div id="key-preview" role="tooltip" style={style} className="ds-fade pointer-events-none fixed z-50 rounded-card bg-overlay p-3 shadow-overlay" data-key-preview={at.key}>
      <div className="flex items-center gap-2">
        {t && <TypeMark type={t.type} />}
        <KeyChip data-no-preview>{at.key}</KeyChip>
        {status && <StatusPill status={status.category} label={status.name} size="sm" className="ml-auto" />}
      </div>
      {data?.error ? <p className="mt-2 text-small text-fg-subtle">{data.error}</p> : t ? (
        <>
          <p className="mt-2 line-clamp-3 text-small font-medium text-fg [overflow-wrap:anywhere]">{t.title}</p>
          <div className="mt-2.5 flex items-center gap-2 text-caption text-fg-subtle">
            {t.assignee ? <><Avatar name={t.assignee.name} id={t.assignee.id} size="sm" /><span className="truncate">{t.assignee.name}</span></> : <span>Nobody has it</span>}
            <PriorityMark priority={t.priority} className="ml-auto" />
            {t.dueDate && <span className="tabular-nums">due {new Date(`${t.dueDate}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
          </div>
        </>
      ) : (
        <div className="mt-2 space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
      )}
    </div>,
    document.body,
  );
}
