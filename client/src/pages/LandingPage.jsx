import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Activity, ArrowRight, CalendarDays, Columns3, Command, FlaskConical, GitPullRequest, ListFilter, Radio,
  Rocket, ScanSearch, ShieldCheck, Smartphone, SquareTerminal,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { apiBase } from '../lib/api.js';
import { Logo, StainedWindow, buttonClasses } from '../ds/core.jsx';

// The public front page: what Tessera is, its four signature features, and a working demo of
// each. The demos are code-split and load as they come near the screen, so the first visit
// downloads the words and the artwork, not four demos.
const DEMOS = {
  bugs: lazy(() => import('../landing/TraceDemo.jsx')),
  flow: lazy(() => import('../landing/ForecastDemo.jsx')),
  live: lazy(() => import('../landing/LiveDemo.jsx')),
  outside: lazy(() => import('../landing/OutsideDemo.jsx')),
};

const FEATURES = [
  {
    id: 'bugs',
    Icon: ScanSearch,
    name: 'Bug intelligence',
    title: 'Paste a stack trace, get a bug',
    text: 'Tessera reads stack traces from eight languages, takes the secrets out before anything is saved, and files the same crash on the same ticket every time it comes back. If a crash returns after its fix, the ticket reopens itself.',
    points: ['Tokens, keys, passwords and emails removed before parsing', 'Repeats counted on one ticket; a crash back after its fix reopens it', 'Impact score, regression timeline, crash comparison and source links'],
  },
  {
    id: 'flow',
    Icon: Activity,
    name: 'Flow analytics',
    title: 'Dates from your own history',
    text: 'Cumulative flow, cycle time and time in each column show where work waits. The forecast replays your team’s real last six weeks ten thousand times, and with too little history it says so instead of guessing.',
    points: ['Forecasts at 50, 85 and 95% confidence, with a what-if for pace', 'Every chart has a table view', 'Time travel: the board exactly as it was on any past day'],
  },
  {
    id: 'live',
    Icon: Radio,
    name: 'Live collaboration',
    title: 'Everyone on the same board',
    text: 'Cards move on every screen as they move, with who is looking and who is typing. Planning poker, retros and incident mode run on the same connection, and an edit never silently overwrites someone else’s.',
    points: ['Presence and typing on the board and each ticket', 'Planning poker, retro boards, incident timelines and postmortems', 'Edit conflicts shown side by side, never overwritten'],
  },
  {
    id: 'outside',
    Icon: GitPullRequest,
    name: 'Outside-in',
    title: 'People outside the team, inside the loop',
    text: 'Clients report problems on a public page without an account and follow them on a private link, in six languages. Your own apps can send their crashes, and “fixes ORB-12” in a commit closes the ticket.',
    points: ['Triage inbox, private tracking link, “fixed” or “still broken”', 'A crash-capture script and a report button for your website', 'GitHub and GitLab: commits, pull requests and deploys on the ticket'],
  },
];

const EVERYDAY = [
  [Columns3, 'A drag-and-drop board', 'WIP limits, swimlanes, saved layouts'],
  [ListFilter, 'List and search', 'Filters, a search language, saved views'],
  [Rocket, 'Sprints', 'Planning, burndown and sprint reports'],
  [CalendarDays, 'Calendar and timeline', 'Due dates, epics and team leave'],
  [ShieldCheck, 'Roles', 'Admin, manager, developer and viewer'],
  [Command, 'Keyboard first', 'Command palette and shortcuts'],
  [Smartphone, 'Installable', 'Offline drafts and push notifications'],
  [SquareTerminal, 'API and CLI', 'OpenAPI docs, tokens, a terminal client'],
];

// Mounts a demo once it is within a screen or so of the viewport. The space is held from the
// start, so nothing on the page moves when it arrives.
function DemoSlot({ id, height }) {
  const box = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true); }, { rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const Demo = DEMOS[id];
  const placeholder = <div className="ds-skeleton rounded-panel" style={{ height }} role="status" aria-label="Loading the demo" />;
  return (
    <div ref={box} style={{ minHeight: height }}>
      {near ? <Suspense fallback={placeholder}><Demo /></Suspense> : placeholder}
    </div>
  );
}

const HEIGHTS = { bugs: 470, flow: 380, live: 520, outside: 420 };

export default function LandingPage() {
  const { user } = useAuth();
  useEffect(() => {
    const before = document.title;
    document.title = 'Tessera: issue tracking for teams who ship';
    return () => { document.title = before; };
  }, []);
  // A link such as /#live: the page arrives after the browser looked for the section, so go there
  // now (every demo's space is already held, so the position is final).
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (target) document.getElementById(target)?.scrollIntoView();
  }, []);

  return (
    <div className="ds-canvas min-h-dvh text-fg">
      <a href="#features" className="ds-focus sr-only z-50 rounded-tile bg-surface px-3 py-2 text-small focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to the features</a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="ds-focus rounded-tile" aria-label="Tessera, home"><Logo wordmark size={26} /></Link>
          <nav aria-label="Features" className="hidden md:block">
            <ul className="flex gap-1">
              {FEATURES.map((f) => (
                <li key={f.id}><a href={`#${f.id}`} className="ds-focus rounded-tile px-2.5 py-1.5 text-small text-fg-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg">{f.name}</a></li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <Link to="/projects" className={buttonClasses({ variant: 'primary', size: 'sm' })}>Open your projects</Link>
            ) : (
              <>
                <Link to="/login" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>Sign in</Link>
                <Link to="/register" className={buttonClasses({ variant: 'primary', size: 'sm' })}>Create an account</Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:pt-20">
          <div>
            <p className="text-small font-medium text-fg-muted">Issue tracking for teams who ship</p>
            <h1 className="mt-3 font-display text-title italic leading-tight text-fg sm:text-display">
              The issue tracker that reads the stack trace for you.
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-body text-fg-muted">
              Tessera has what you expect from Jira or Linear: projects, a drag-and-drop board, sprints, roles and search.
              On top of that are four things they don&rsquo;t give you out of the box, each with a working demo below.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {user
                ? <Link to="/projects" className={buttonClasses({ variant: 'primary' })}>Open your projects</Link>
                : <Link to="/register" className={buttonClasses({ variant: 'primary' })}>Create an account</Link>}
              <a href="#features" className={buttonClasses({ variant: 'secondary' })}>Try the demos</a>
            </div>
            <p className="mt-6 flex max-w-xl gap-2 text-caption text-fg-subtle">
              <FlaskConical className="mt-px size-3.5 shrink-0" aria-hidden />
              The demos on this page run in your browser on made-up sample data, using Tessera&rsquo;s own code. They are not real usage, customers or numbers.
            </p>
          </div>
          {/* The arched window beside the words on wide screens; a band of glass under them on narrow ones. */}
          <div className="mx-auto hidden w-full max-w-md lg:block">
            <div className="aspect-[5/6] overflow-hidden rounded-t-full rounded-b-panel bg-sunken p-1.5 shadow-lift">
              <StainedWindow seed={11} width={100} height={120} className="size-full rounded-t-full rounded-b-card" />
            </div>
          </div>
          <div className="h-24 overflow-hidden rounded-card bg-sunken p-1 shadow-surface lg:hidden">
            <StainedWindow seed={11} width={240} height={60} className="size-full rounded-tile" />
          </div>
        </section>

        <section id="features" aria-labelledby="features-title" className="scroll-mt-16 border-t border-line bg-sunken">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
            <h2 id="features-title" className="font-display text-title italic text-fg">Four things worth a closer look</h2>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f, i) => (
                <li key={f.id}>
                  <a href={`#${f.id}`} className="ds-focus group flex h-full flex-col rounded-card border border-line bg-surface p-4 transition-colors duration-(--dur-fast) hover:border-line-strong">
                    <span className="flex items-center justify-between text-caption tabular-nums text-fg-subtle"><f.Icon className="size-4 text-fg-muted" aria-hidden />0{i + 1}</span>
                    <span className="mt-3 text-small font-semibold text-fg">{f.name}</span>
                    <span className="mt-1 text-caption text-fg-muted">{f.title}</span>
                    <span className="mt-auto flex items-center gap-1 pt-3 text-caption font-medium text-fg-muted group-hover:text-fg">Try it<ArrowRight className="size-3.5" aria-hidden /></span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {FEATURES.map((f, i) => (
          <section key={f.id} id={f.id} aria-labelledby={`${f.id}-title`} className="scroll-mt-16 border-t border-line">
            <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
                <div>
                  <p className="flex items-center gap-2 text-caption font-medium text-fg-subtle"><f.Icon className="size-4" aria-hidden /><span className="tabular-nums">0{i + 1}</span> {f.name}</p>
                  <h2 id={`${f.id}-title`} className="mt-2 font-display text-title italic text-fg">{f.title}</h2>
                </div>
                <div>
                  <p className="text-pretty text-body text-fg-muted">{f.text}</p>
                  <ul className="mt-4 space-y-1.5">
                    {f.points.map((p) => (
                      <li key={p} className="flex gap-2 text-small text-fg"><span className="mt-2 size-1.5 shrink-0 rounded-full ds-gradient" aria-hidden />{p}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="mt-8"><DemoSlot id={f.id} height={HEIGHTS[f.id]} /></div>
            </div>
          </section>
        ))}

        <section aria-labelledby="everyday-title" className="border-t border-line bg-sunken">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="everyday-title" className="font-display text-title italic text-fg">And everything a tracker should do</h2>
            <ul className="mt-6 grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
              {EVERYDAY.map(([Icon, name, text]) => (
                <li key={name} className="flex gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span>
                    <span className="block text-small font-medium text-fg">{name}</span>
                    <span className="block text-caption text-fg-muted">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-display text-title italic text-fg">Every ticket is a tile. Every release, a window.</h2>
              <p className="mt-2 text-body text-fg-muted">Make a project and invite the team; the first board is ready in a minute.</p>
            </div>
            {user
              ? <Link to="/projects" className={buttonClasses({ variant: 'primary' })}>Open your projects</Link>
              : <Link to="/register" className={buttonClasses({ variant: 'primary' })}>Create an account</Link>}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-caption text-fg-subtle sm:px-6">
          <Logo size={18} />
          <span>Built with React, Express, MongoDB and Socket.IO.</span>
          <span className="ml-auto flex gap-4">
            {!user && <Link to="/login" className="ds-focus rounded-hair hover:text-fg">Sign in</Link>}
            <a href={`${apiBase}/api/docs`} className="ds-focus rounded-hair hover:text-fg">API docs</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
