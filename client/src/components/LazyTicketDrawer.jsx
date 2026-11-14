/* eslint-disable react-refresh/only-export-components */
import { Suspense, lazy, useEffect } from 'react';

// The ticket drawer (with its Markdown, error insights, GitHub and debugging tools) is the
// heaviest part of the board, and nobody needs it until they open a ticket. It loads on its own:
// fetched in the background once the page is idle (so opening a ticket still feels instant), or at
// once when a link opens a ticket directly.
const load = () => import('./TicketDrawer.jsx');
const Drawer = lazy(load);

export const preloadTicketDrawer = load;

// Fetched at the first sign someone may open a ticket: a pointer over, or focus on, anything with a
// ticket key (a tap counts too: touch sends "pointerover" before the tap itself). Never on a timer,
// so it can't compete with the page's own first load.
export function usePreloadTicketDrawer() {
  useEffect(() => {
    let done = false;
    const intent = (e) => {
      if (done || !e.target?.closest?.('[data-ticket-card], [data-ticket-key], [role="row"]')) return;
      done = true;
      load();
    };
    document.addEventListener('pointerover', intent, { passive: true });
    document.addEventListener('focusin', intent);
    return () => {
      document.removeEventListener('pointerover', intent);
      document.removeEventListener('focusin', intent);
    };
  }, []);
}

export default function TicketDrawer(props) {
  return <Suspense fallback={null}><Drawer {...props} /></Suspense>;
}
