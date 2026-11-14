/* eslint-disable react-refresh/only-export-components */
import clsx from 'clsx';
import { Logo, Skeleton } from '../ds/core.jsx';
import { LangPicker } from './ui.jsx';
import { ProjectTile } from './ProjectTile.jsx';
import { LANGUAGES } from '../lib/i18n.js';
import { HeroWindow } from './cinematic.jsx';
import { apiBase } from '../lib/api.js';
import { accentStyle } from '../lib/accents.js';

// The frame of the pages people outside the team see (report, tracking): whose page it is, the
// language, and the work in a single column. A soft wash of the brand light sits behind the top
// (CSS only, so it costs nothing to load and can't shift the layout).
// `brand` (portal branding) is the team's chosen name, accent and logo; with an accent the whole
// page wears it (links, focus, the button, the light from above, the glass band).
export function PublicFrame({ project, brand, t, lang, setLang, children, width = 'max-w-xl', hero = false }) {
  const name = brand?.name ?? project?.name;
  return (
    <div className="ds-canvas ds-public-light ds-accented flex min-h-dvh flex-col px-4 pb-6 pt-5 sm:pt-8" style={brand?.accent ? { ...accentStyle(brand.accent), '--tile-accent': 'var(--accent)', '--tile-on': 'var(--on-gradient)' } : undefined}>
      <div className={clsx('relative mx-auto flex w-full flex-1 flex-col', width)}>
        <header className="mb-6 flex min-h-9 items-center justify-between gap-3 sm:mb-8">
          {project ? (
            <span className="flex min-w-0 items-center gap-2.5">
              {brand?.logo
                ? <img src={apiBase + brand.logo} alt="" width="32" height="32" decoding="async" className="size-8 shrink-0 rounded-tile object-contain" />
                : <ProjectTile project={{ ...project, name }} className="size-8 text-caption" />}
              <span className="truncate text-small font-semibold text-fg">{name}</span>
            </span>
          ) : <span />}
          <LangPicker lang={lang} setLang={setLang} label={t('common.language')} languages={LANGUAGES} />
        </header>
        {/* The report page sits on a band of glass (its pattern follows the link, so it is there from the
            first frame and never moves the form); the card overlaps its lower edge. */}
        {hero && (
          <div className="relative -mx-4 h-40 overflow-hidden sm:mx-0 sm:h-44 sm:rounded-panel">
            <HeroWindow seed={[...String(hero)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 100003, 7)} width={180} height={44} video="portal-hero" className="h-full" />
            {/* With a team accent the glass takes its hue (same light and shade, the team's colour). */}
            {brand?.accent && <div aria-hidden className="pointer-events-none absolute inset-0 bg-(--accent) mix-blend-color" />}
          </div>
        )}
        <main className={clsx('relative flex-1', hero && '-mt-16 px-1 sm:-mt-20 sm:px-6')}>{children}</main>
        {/* Held to the bottom of the window, so content arriving above it never moves it. */}
        <footer className="mt-8 flex justify-center">
          <a href="/" className="ds-focus flex items-center gap-1.5 rounded-tile px-2 py-1 text-caption text-fg-subtle transition-colors duration-(--dur-fast) hover:text-fg-muted">
            <Logo size={14} />{t('common.poweredBy')}
          </a>
        </footer>
      </div>
    </div>
  );
}

// A link that no longer works (or never did): what happened and what it may mean.
export function PublicGone({ title, hint }) {
  return (
    <section className="rounded-panel bg-surface px-6 py-12 text-center shadow-raised">
      <div aria-hidden className="mx-auto mb-5 grid w-max grid-cols-3 gap-1">
        {Array.from({ length: 6 }, (_, i) => <span key={i} className="size-3 rounded-shard border border-dashed border-line-strong" />)}
      </div>
      <h1 className="font-display text-h1 text-fg">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-pretty text-small text-fg-muted">{hint}</p>
    </section>
  );
}

// The page's shape while it loads, about as tall as what replaces it, so nothing below jumps.
export function PublicSkeleton({ className = 'min-h-[46rem]' }) {
  return (
    <div className={clsx('rounded-panel bg-surface p-6 shadow-raised sm:p-8', className)} aria-busy="true">
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="mt-3 h-4 w-1/2" />
      <div className="mt-6 grid grid-cols-2 gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      <Skeleton className="mt-6 h-9 w-full" />
      <Skeleton className="mt-4 h-28 w-full" />
    </div>
  );
}
