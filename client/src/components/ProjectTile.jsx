import clsx from 'clsx';
import { glassColour, initialsOf } from '../ds/core.jsx';

// A project's tile: a pane of glass in its own colour, taken from the brand gradient by its key,
// so a project keeps its colour everywhere and forever. Its own small file, so the public pages
// (report, tracking) can show it without loading the signed-in app's shell.
export function ProjectTile({ project, className }) {
  // Public pages may not be told the key; the name's initials stand in, so the tile is never blank.
  const key = project.key || initialsOf(project.name ?? '').toUpperCase();
  const t = ([...key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 997, 7) % 100) / 100;
  return (
    <span
      // Decorative: the project's name always sits beside it, so assistive tech skips the initials.
      aria-hidden
      // The initials are drawn by CSS, not written as text: they are decoration, and as text they
      // would count as part of a button's visible label next to it (WCAG 2.5.3).
      data-initials={key.slice(0, 2)}
      className={clsx('grid shrink-0 place-items-center rounded-hair font-code font-semibold text-(--tile-on,var(--on-glass)) before:content-[attr(data-initials)]', className ?? 'size-6 text-micro')}
      // On a team's public page with an accent (portal branding) the tile wears it too, so its
      // initials keep the contrast that accent was checked for. Elsewhere each project keeps its own.
      style={{ background: `var(--tile-accent, ${glassColour(t)})` }}
    />
  );
}
