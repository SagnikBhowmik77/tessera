import { useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, MonitorSmartphone, Send } from 'lucide-react';
import { Avatar, IconButton, KeyChip, TypeMark } from '../ds/core.jsx';
import DemoFrame from './DemoFrame.jsx';

// Two people's screens of the same board. A change made on one reaches the other after DELAY,
// with the same presence ring, typing dots and arrival glow the real board uses (ds/surfaces.css).
// Here the two screens talk inside this page, and to other tabs of it through BroadcastChannel;
// in Tessera they talk through the server over Socket.IO.

const DELAY = 350; // slowed down so the hop is visible
const COLUMNS = [['todo', 'To do'], ['progress', 'In progress'], ['done', 'Done']];
const START = [
  { id: 'c1', key: 'ORB-12', title: 'Coupon field rejects lowercase codes', type: 'bug', col: 'todo' },
  { id: 'c2', key: 'ORB-15', title: 'Remember last used payment method', type: 'feature', col: 'todo' },
  { id: 'c3', key: 'ORB-9', title: 'Move tax rules to config', type: 'task', col: 'progress' },
  { id: 'c4', key: 'ORB-4', title: 'Search results page loads slowly', type: 'bug', col: 'done' },
];
const PEOPLE = { asha: { name: 'Asha Rao', short: 'Asha' }, ravi: { name: 'Ravi Iyer', short: 'Ravi' } };
const other = (who) => (who === 'asha' ? 'ravi' : 'asha');
const colName = (col) => COLUMNS.find(([k]) => k === col)[1];
const step = (col, dir) => COLUMNS[Math.min(2, Math.max(0, COLUMNS.findIndex(([k]) => k === col) + dir))][0];

function Screen({ who, cards, looking, typing, flash, news, onMove, onLook, onType, onSend }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const them = PEOPLE[other(who)];
  const box = useRef(null);
  // The card re-renders in its new column; keep the keyboard on it (its other arrow at an end).
  const moveAndKeepFocus = (cardId, dir) => {
    onMove(cardId, dir);
    requestAnimationFrame(() => {
      const near = box.current?.querySelector(`[data-move="${cardId}:${dir}"]:not(:disabled)`) ?? box.current?.querySelector(`[data-move="${cardId}:${-dir}"]`);
      near?.focus();
    });
  };
  return (
    <section ref={box} aria-label={`${PEOPLE[who].short}'s screen`} className="min-w-0 rounded-card border border-line bg-canvas">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <MonitorSmartphone className="size-3.5 text-fg-subtle" aria-hidden />
        <span className="text-caption font-medium text-fg">{PEOPLE[who].short}&rsquo;s screen</span>
        <span className="ml-auto flex items-center gap-1.5 text-micro text-fg-subtle">
          Here now
          <Avatar name={PEOPLE[who].name} size="sm" />
          <Avatar name={them.name} size="sm" presence />
        </span>
      </header>
      <div className="grid grid-cols-3 gap-2 p-2">
        {COLUMNS.map(([col, name]) => (
          <div key={col} className="min-w-0 rounded-tile bg-sunken p-1.5">
            <p className="px-1 pb-1.5 text-micro font-medium text-fg-muted">{name} <span className="tabular-nums text-fg-subtle">{cards.filter((c) => c.col === col).length}</span></p>
            <ul className="space-y-1.5">
              {cards.filter((c) => c.col === col).map((c) => (
                <li
                  key={`${c.id}-${flash[c.id] ?? 0}`}
                  className={clsx('group relative rounded-tile bg-raised p-1.5 shadow-raised', looking === c.id && 'ds-held', flash[c.id] && 'ds-live-flash')}
                  onPointerEnter={() => onLook(c.id)}
                  onPointerLeave={() => onLook(null)}
                  onFocus={() => onLook(c.id)}
                  onBlur={() => onLook(null)}
                >
                  <div className="flex items-center gap-1">
                    <TypeMark type={c.type} className="size-3" />
                    <KeyChip className="text-micro">{c.key}</KeyChip>
                    {looking === c.id && <span className="ml-auto"><Avatar name={them.name} size="sm" /></span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-micro leading-snug text-fg">{c.title}</p>
                  <div className="mt-1 flex justify-end gap-0.5">
                    <IconButton size="sm" icon={ChevronLeft} label={`Move ${c.key} back`} data-move={`${c.id}:-1`} disabled={col === 'todo'} onClick={() => moveAndKeepFocus(c.id, -1)} />
                    <IconButton size="sm" icon={ChevronRight} label={`Move ${c.key} on`} data-move={`${c.id}:1`} disabled={col === 'done'} onClick={() => moveAndKeepFocus(c.id, 1)} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5 border-t border-line p-2"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onSend(draft.trim()); setDraft(''); } }}
      >
        <label htmlFor={`${id}-c`} className="sr-only">Comment on ORB-9 as {PEOPLE[who].short}</label>
        <input
          id={`${id}-c`}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); onType(); }}
          placeholder="Comment on ORB-9…"
          maxLength={120}
          className="ds-focus h-8 min-w-0 flex-1 rounded-tile border border-line bg-field px-2.5 text-caption text-fg placeholder:text-fg-subtle"
        />
        <IconButton size="sm" type="submit" icon={Send} label="Send comment" />
      </form>
      <div className="min-h-9 px-3 pb-2 text-micro text-fg-muted" aria-live="polite">
        {typing && (
          <span className="flex items-center gap-1.5">
            <span className="ds-typing inline-flex gap-0.5" aria-hidden><span className="size-1 rounded-full bg-fg-muted" /><span className="size-1 rounded-full bg-fg-muted" /><span className="size-1 rounded-full bg-fg-muted" /></span>
            {them.short} is typing
          </span>
        )}
        {!typing && news && <span>{news}</span>}
      </div>
    </section>
  );
}

export default function LiveDemo() {
  // Each screen keeps its own copy, as each browser does in the app.
  const [boards, setBoards] = useState({ asha: START, ravi: START });
  const [looking, setLooking] = useState({ asha: null, ravi: null });
  const [typing, setTyping] = useState({ asha: false, ravi: false });
  const [flash, setFlash] = useState({ asha: {}, ravi: {} });
  const [news, setNews] = useState({ asha: '', ravi: '' });
  const timers = useRef(new Set());
  const typingTimer = useRef({});
  const channel = useRef(null);

  const later = (fn, ms = DELAY) => {
    const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms);
    timers.current.add(t);
  };
  const place = (screen, id, col) => {
    setBoards((b) => ({ ...b, [screen]: b[screen].map((c) => (c.id === id ? { ...c, col } : c)) }));
  };
  const arrive = (screen, id, col, line) => {
    place(screen, id, col);
    setFlash((f) => ({ ...f, [screen]: { ...f[screen], [id]: (f[screen][id] ?? 0) + 1 } }));
    setNews((n) => ({ ...n, [screen]: line }));
  };

  // Other tabs of this page: a move there arrives here on both screens.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const ch = new BroadcastChannel('tessera-landing-live');
    channel.current = ch;
    ch.onmessage = ({ data }) => {
      if (data?.type !== 'move' || !START.some((c) => c.id === data.id) || !COLUMNS.some(([k]) => k === data.col)) return;
      const card = START.find((c) => c.id === data.id);
      for (const s of ['asha', 'ravi']) arrive(s, data.id, data.col, `Another tab moved ${card.key} to ${colName(data.col)}`);
    };
    const pending = timers.current;
    return () => { ch.close(); pending.forEach(clearTimeout); };
  }, []);

  const move = (who, id, dir) => {
    const card = boards[who].find((c) => c.id === id);
    const col = step(card.col, dir);
    place(who, id, col);
    later(() => arrive(other(who), id, col, `${PEOPLE[who].short} moved ${card.key} to ${colName(col)}`));
    channel.current?.postMessage({ type: 'move', id, col });
  };
  const look = (who, id) => later(() => setLooking((l) => ({ ...l, [other(who)]: id })));
  const type = (who) => {
    later(() => setTyping((t) => ({ ...t, [other(who)]: true })));
    clearTimeout(typingTimer.current[who]);
    typingTimer.current[who] = setTimeout(() => setTyping((t) => ({ ...t, [other(who)]: false })), 1600);
  };
  const send = (who, text) => {
    clearTimeout(typingTimer.current[who]);
    later(() => {
      setTyping((t) => ({ ...t, [other(who)]: false }));
      setNews((n) => ({ ...n, [other(who)]: `${PEOPLE[who].short} on ORB-9: “${text}”` }));
    });
  };

  return (
    <DemoFrame title="Live for everyone at once" source="client/src/ds/surfaces.css" sourceNote="the board's own presence, typing and arrival styles; here the screens talk through your browser, in Tessera through Socket.IO">
      <p className="mb-3 text-caption text-fg-muted">
        Move a card, point at one, or start a comment on either screen; the other follows. The hop is slowed to {DELAY} ms so you can see it
        (the load test measured 21 ms at the 95th percentile with 500 people watching one board). Open this page in a second tab and moves show up there too.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {['asha', 'ravi'].map((who) => (
          <Screen
            key={who}
            who={who}
            cards={boards[who]}
            looking={looking[who]}
            typing={typing[who]}
            flash={flash[who]}
            news={news[who]}
            onMove={(id, dir) => move(who, id, dir)}
            onLook={(id) => look(who, id)}
            onType={() => type(who)}
            onSend={(text) => send(who, text)}
          />
        ))}
      </div>
    </DemoFrame>
  );
}
