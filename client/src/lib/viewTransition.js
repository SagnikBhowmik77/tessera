import { flushSync } from 'react-dom';

// A card that grows into the ticket drawer, and shrinks back into its card on close, using the
// browser's View Transitions API. The card and the drawer share one name ("ticket") for the length
// of the change, so the browser morphs one box into the other (420 ms, see surfaces.css).
// Without the API, or with reduced motion, the drawer simply opens and closes as before.

const can = () => typeof document !== 'undefined' && 'startViewTransition' in document && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const cardFor = (key) => document.querySelector(`[data-ticket-card="${CSS.escape(String(key))}"]`);

function run(before, update, after) {
  const root = document.documentElement;
  root.dataset.vt = 'ticket';
  before?.();
  const t = document.startViewTransition(() => { flushSync(update); after?.(); });
  t.finished.finally(() => {
    delete root.dataset.vt;
    // Names are only for the change itself; nothing keeps one afterwards.
    for (const el of document.querySelectorAll('[data-ticket-card]')) el.style.viewTransitionName = '';
  });
}

// Open: the clicked card is named before, the drawer (named in its own style) after.
export function openFromCard(key, update) {
  const card = cardFor(key);
  if (!can() || !card) { update(); return; }
  run(() => { card.style.viewTransitionName = 'ticket'; }, () => { card.style.viewTransitionName = ''; update(); });
}

// Close: the drawer is named before; the card it came from takes the name once the drawer is gone.
export function closeToCard(key, update) {
  if (!can() || !cardFor(key)) { update(); return; }
  run(null, update, () => { const card = cardFor(key); if (card) card.style.viewTransitionName = 'ticket'; });
}
