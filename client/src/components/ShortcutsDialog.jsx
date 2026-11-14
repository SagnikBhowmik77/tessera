import { useEffect } from 'react';
import { Dialog, Kbd } from '../ds/core.jsx';

// Every keyboard shortcut Tessera has, in one place. Opened with "?" anywhere (except Triage,
// which has its own set and its own "?") or from the keyboard button in the sidebar. Only real
// shortcuts are listed: each line matches a handler in the code.
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const GROUPS = [
  {
    title: 'Anywhere',
    rows: [
      [[MOD, 'K'], 'Search, jump to a ticket or project, or run a command'],
      [['?'], 'Show these shortcuts'],
      [['['], 'Collapse or expand the sidebar'],
      [['Esc'], 'Close the open dialog, drawer or menu'],
    ],
  },
  {
    title: 'Board',
    rows: [
      [['C'], 'New ticket'],
      [['Enter'], 'Open the focused card'],
      [['Space'], 'Pick up the focused card, then drop it'],
      [['←', '→', '↑', '↓'], 'Move a picked-up card between columns and places'],
      [['Esc'], 'Put a picked-up card back where it was'],
    ],
  },
  {
    title: 'Editing in place',
    rows: [
      [['Enter'], 'Save a title, points or labels'],
      [['Esc'], 'Put back what was there'],
      [[MOD, 'Enter'], 'Send a comment'],
      [['@'], 'Mention someone in a comment'],
    ],
  },
  {
    title: 'Lists, menus and pickers',
    rows: [
      [['↑', '↓'], 'Move through the options'],
      [['Enter'], 'Choose'],
      [['A–Z'], 'Jump to the option starting with that letter'],
    ],
  },
  {
    title: 'Triage',
    rows: [
      [['?'], 'Its own list: priority, assignee, status, due date and labels from the keyboard'],
    ],
  },
];

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function useShortcutsKey(setOpen) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || typing(document.activeElement)) return;
      if (/\/triage(\/|$)/.test(window.location.pathname)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setOpen]);
}

export default function ShortcutsDialog({ open, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Everything Tessera does from the keyboard." size="lg">
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title} aria-labelledby={`keys-${g.title}`}>
            <h3 id={`keys-${g.title}`} className="mb-2 text-micro font-medium uppercase tracking-wider text-fg-faint">{g.title}</h3>
            <dl className="space-y-2">
              {g.rows.map(([keys, what]) => (
                <div key={what} className="flex items-start justify-between gap-4">
                  <dt className="text-small text-fg-muted">{what}</dt>
                  <dd className="flex shrink-0 items-center gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
