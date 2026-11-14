import { Component } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Layers, RefreshCw, ServerCrash, TriangleAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, EmptyState, Logo, buttonClasses, panes } from '../ds/core.jsx';
import { HeroWindow } from './cinematic.jsx';

// A project page that could not load. "Not found" only when the server said so (404, or 403 for
// a project you are not in); anything else is a failed load, which can be tried again.
export function ProjectMissing({ error }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const gone = error?.status === 404 || error?.status === 403 || error?.status === 400;
  if (gone) {
    return (
      <EmptyState as="h1" tone="lost" icon={Layers} title="Project not found" action={<Button onClick={() => navigate('/projects')}>Back to projects</Button>}>
        It may have been deleted, or you are no longer a member.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      as="h1"
      tone="lost"
      icon={ServerCrash}
      title="This project didn't load"
      action={<Button variant="primary" icon={RefreshCw} onClick={() => qc.invalidateQueries()}>Try again</Button>}
      secondary={<Button variant="ghost" onClick={() => navigate('/projects')}>Back to projects</Button>}
    >
      {error?.message || 'Something went wrong while loading it.'}
    </EmptyState>
  );
}

// An address that leads nowhere. Its own page (not a silent redirect), so a mistyped or stale
// link is noticed. Works signed in or out. The window has one pane missing: the page that isn't here.
export function NotFoundPage() {
  const { user } = useAuth();
  return (
    <div className="ds-canvas ds-public-light flex min-h-dvh flex-col">
      <header className="p-5">
        <Link to="/" className="ds-focus inline-flex rounded-tile" aria-label="Tessera, home"><Logo wordmark size={24} /></Link>
      </header>
      <main className="grid flex-1 place-items-center px-6 pb-16">
        <div className="flex w-full max-w-3xl flex-col items-center gap-10 md:flex-row md:gap-14">
          <div className="aspect-[5/6] w-48 shrink-0 rounded-t-full rounded-b-panel bg-canvas p-1.5 shadow-lift sm:w-60">
            <HeroWindow seed={404} width={100} height={120} missing={MISSING} video="not-found" className="size-full rounded-t-full rounded-b-card" />
          </div>
          <div className="text-center md:text-left">
            <p className="font-code text-caption text-fg-subtle">404</p>
            <h1 className="mt-1 font-display text-display italic text-balance text-fg">This page isn't here</h1>
            <p className="mt-3 max-w-sm text-pretty text-body text-fg-muted">The address may be mistyped, or the page was moved or removed. One pane is missing from the window; the rest of Tessera is where you left it.</p>
            <div className="mt-7 flex justify-center md:justify-start">
              <Link to={user ? '/projects' : '/login'} className={buttonClasses({ variant: 'primary', size: 'lg' })}>{user ? 'Go to your projects' : 'Sign in'}</Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
// The pane left out of the 404 window: a large one near the middle, so the gap is easy to see.
const MISSING = (() => {
  const list = panes(404, 100, 120);
  let best = 0;
  let score = -1;
  list.forEach((p, i) => {
    const centre = 1 - Math.hypot(p.x + p.w / 2 - 50, p.y + p.h / 2 - 66) / 80;
    const s = p.w * p.h * Math.max(centre, 0);
    if (s > score && p.r >= 0.14) { score = s; best = i; }
  });
  return best;
})();

// If a screen throws while drawing, the rest of the app would go blank. This catches it and says
// so plainly, with a way back. Moving to another page clears it (resetKey changes).
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, at: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.at ? { error: null, at: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error('Tessera screen crashed:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full min-h-96 place-items-center" role="alert">
        <EmptyState
          as="h1"
          tone="lost"
          icon={TriangleAlert}
          title="This screen hit a problem"
          action={<Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>Reload the page</Button>}
          secondary={<a href="/projects" className={buttonClasses({ variant: 'ghost' })}>Back to projects</a>}
        >
          Nothing you already saved is lost. Reloading usually fixes it. The error was: {String(this.state.error?.message || this.state.error).slice(0, 160)}
        </EmptyState>
      </div>
    );
  }
}
