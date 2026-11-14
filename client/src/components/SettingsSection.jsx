/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

// One frame for every block of settings (project and account). On a wide card the title and its
// explanation sit beside the controls; on a narrow one (a container query, so it follows the card,
// not the window) they stack. Inside a SettingsIndex each block registers itself, so the side rail
// only ever lists blocks that are really on the page (some hide until they have something to show).

const IndexCtx = createContext(null);
const GroupCtx = createContext(null);
// The group on screen: settings shows one group at a time (null: no groups, everything shows).
const ShownCtx = createContext(null);

export const anchorOf = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function SettingsSection({ title, description, children, tone, id }) {
  const index = useContext(IndexCtx);
  const group = useContext(GroupCtx);
  const anchor = id ?? anchorOf(title);
  const register = index?.register;
  useEffect(() => register?.(anchor, title, group), [register, anchor, title, group]);
  const Heading = group ? 'h3' : 'h2';
  return (
    <section
      id={anchor}
      tabIndex={-1}
      aria-labelledby={`${anchor}-title`}
      className={clsx(
        '@container rounded-card bg-surface shadow-surface outline-none',
        tone === 'danger' && 'ring-1 ring-danger/45',
      )}
    >
      <div className="grid gap-4 p-4 sm:p-5 @2xl:grid-cols-[14rem_1fr] @2xl:gap-8">
        <header className="min-w-0">
          <Heading id={`${anchor}-title`} className={clsx('text-h3 font-semibold', tone === 'danger' ? 'text-danger' : 'text-fg')}>{title}</Heading>
          {description && <p className="mt-1 text-pretty text-caption text-fg-subtle">{description}</p>}
        </header>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

// A named band of sections. Hidden when none of its sections rendered anything.
// Every group stays mounted (so the rail can list them all); only the shown one is visible.
export function SettingsGroup({ title, children }) {
  const shown = useContext(ShownCtx);
  return (
    <GroupCtx.Provider value={title}>
      <div hidden={shown !== null && shown !== title} className="space-y-3 [&:not(:has(section))]:hidden">
        <h2 className="font-display text-h2 text-fg">{title}</h2>
        {children}
      </div>
    </GroupCtx.Provider>
  );
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Scrolls only the page scroller (#main). scrollIntoView would also nudge the app frame around
// it (overflow: hidden boxes still scroll from code), shifting the whole app off the window.
function scrollToSection(el, smooth) {
  const scroller = document.getElementById('main');
  if (!scroller) return;
  const strip = document.querySelector('[data-settings-strip]');
  const gap = (strip?.offsetHeight ?? 0) + 16;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - gap;
  scroller.scrollTo({ top, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
}

function go(anchor) {
  const el = document.getElementById(anchor);
  if (!el) return;
  scrollToSection(el, true);
  el.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, '', `#${anchor}`);
}

// The page around the sections: a rail of links on wide screens, a strip of group chips on
// narrow ones, both following the section being read.
export function SettingsIndex({ children, label = 'Settings sections' }) {
  const [entries, setEntries] = useState({});
  const [active, setActive] = useState(null);
  const [shown, setShown] = useState(null);
  const strip = useRef(null);
  const rail = useRef(null);

  const register = useCallback((anchor, title, group) => {
    setEntries((e) => ({ ...e, [anchor]: { title, group } }));
    return () => setEntries((e) => { const n = { ...e }; delete n[anchor]; return n; });
  }, []);
  const ctx = useMemo(() => ({ register }), [register]);

  // In page order (the order they were registered in can differ when some load later).
  const items = Object.entries(entries)
    .map(([anchor, v]) => ({ anchor, ...v, el: document.getElementById(anchor) }))
    .filter((i) => i.el)
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const groups = [];
  for (const i of items) {
    const last = groups.at(-1);
    if (last && last.title === i.group) last.items.push(i); else groups.push({ title: i.group, items: [i] });
  }
  const paged = groups.length > 1;
  const shownGroup = paged ? (groups.some((g) => g.title === shown) ? shown : groups[0].title) : null;
  const groupOf = (anchor) => items.find((i) => i.anchor === anchor)?.group;
  const all = items.map((i) => i.anchor).join(' ');
  // The scroll-spy only follows the sections on screen.
  const order = items.filter((i) => !paged || i.group === shownGroup).map((i) => i.anchor).join(' ');

  // The section being read: the last one whose top has passed a line near the top of the scroller.
  useEffect(() => {
    const scroller = document.getElementById('main');
    if (!scroller || !order) return undefined;
    const anchors = order.split(' ');
    let frame = 0;
    const pick = () => {
      frame = 0;
      const line = scroller.getBoundingClientRect().top + 96;
      let current = anchors[0];
      for (const a of anchors) {
        const el = document.getElementById(a);
        if (el && el.getBoundingClientRect().top <= line) current = a;
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = anchors.at(-1);
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(pick); };
    pick();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [order]);

  // Opens the group holding a section, then goes to it once it is visible.
  const show = (anchor, smooth) => {
    setShown(groupOf(anchor) ?? null);
    setActive(anchor);
    requestAnimationFrame(() => { const el = document.getElementById(anchor); if (el) scrollToSection(el, smooth); });
  };

  // Arriving with #anchor in the address: open its group and go there once it exists.
  const arrived = useRef(false);
  useEffect(() => {
    const want = window.location.hash.slice(1);
    if (arrived.current || !want || !all.split(' ').includes(want)) return;
    arrived.current = true;
    show(want, false);
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back and forward move between the groups visited here (the address keeps the section).
  useEffect(() => {
    const onPop = () => {
      const want = window.location.hash.slice(1);
      if (want && all.split(' ').includes(want)) show(want, false);
      else if (!want) setShown(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeGroup = paged ? shownGroup : items.find((i) => i.anchor === active)?.group;
  // Keep the active chip in view in the narrow strip (sideways only, never moving the page).
  useEffect(() => {
    const box = strip.current;
    const chip = box?.querySelector('[aria-current="true"]');
    if (!box || !chip) return;
    const left = chip.offsetLeft - box.clientWidth / 2 + chip.clientWidth / 2;
    box.scrollTo({ left, behavior: reduced() ? 'auto' : 'smooth' });
  }, [activeGroup]);

  // The rail is taller than the window on big projects: keep the marked link inside it.
  useEffect(() => {
    const box = rail.current;
    const item = box?.querySelector('[aria-current="true"]');
    if (!box || !item) return;
    const top = item.offsetTop;
    if (top < box.scrollTop + 40 || top + item.offsetHeight > box.scrollTop + box.clientHeight - 40) {
      box.scrollTo({ top: top - box.clientHeight / 3, behavior: reduced() ? 'auto' : 'smooth' });
    }
  }, [active]);

  // Within the group on screen a link scrolls; to another group it opens that group as a new
  // place in the history, so Back returns to the previous one.
  const link = (e, anchor) => {
    e.preventDefault();
    if (!paged || groupOf(anchor) === shownGroup) { go(anchor); return; }
    window.history.pushState(window.history.state, '', `#${anchor}`);
    show(anchor, false);
    requestAnimationFrame(() => document.getElementById(anchor)?.focus({ preventScroll: true }));
  };

  return (
    <IndexCtx.Provider value={ctx}>
    <ShownCtx.Provider value={shownGroup}>
      {groups.length > 1 && (
        <nav data-settings-strip aria-label={label} className="sticky top-0 z-10 -mx-4 mb-2 border-b border-line bg-canvas/85 backdrop-blur-md sm:-mx-6 lg:hidden">
          <ul ref={strip} className="ds-scroll flex gap-1.5 overflow-x-auto px-4 py-2 sm:px-6">
            {groups.map((g) => (
              <li key={g.title} className="shrink-0">
                <a
                  href={`#${g.items[0].anchor}`}
                  onClick={(e) => link(e, g.items[0].anchor)}
                  aria-current={g.title === activeGroup ? 'true' : undefined}
                  className="ds-focus flex h-8 items-center rounded-full border border-line px-3 text-caption font-medium text-fg-muted transition-colors duration-(--dur-fast) hover:text-fg aria-[current=true]:border-key-line aria-[current=true]:bg-key-bg aria-[current=true]:text-fg"
                >
                  {g.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className="lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label={label} className="hidden lg:block">
          <div ref={rail} className="ds-scroll sticky top-4 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-6">
            {groups.map((g) => (
              <div key={g.title} className="mb-4">
                <p className={clsx('mb-1 px-2.5 text-micro font-medium uppercase tracking-wider', g.title === activeGroup ? 'text-fg-muted' : 'text-fg-faint')}>{g.title}</p>
                <ul>
                  {g.items.map((i) => (
                    <li key={i.anchor}>
                      <a
                        href={`#${i.anchor}`}
                        onClick={(e) => link(e, i.anchor)}
                        aria-current={i.anchor === active ? 'true' : undefined}
                        className="ds-focus relative flex min-h-7 items-center rounded-tile px-2.5 py-1 text-small text-fg-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg aria-[current=true]:bg-hover aria-[current=true]:font-medium aria-[current=true]:text-fg"
                      >
                        {i.anchor === active && <span aria-hidden className="ds-gradient absolute inset-y-1.5 left-0 w-0.5 rounded-full" />}
                        {i.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0 space-y-3">{children}</div>
      </div>
    </ShownCtx.Provider>
    </IndexCtx.Provider>
  );
}
