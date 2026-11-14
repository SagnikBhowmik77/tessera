import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  Bell, CalendarDays, ChartNoAxesColumn, Columns3, GanttChart, Inbox, LayoutList, Moon, Plus, Search, Settings, Sun, Timer, Trash2, Zap,
} from 'lucide-react';
import { useTheme } from '../lib/theme.js';
import {
  Avatar, Badge, Button, Card, Checkbox, DSProvider, Dialog, EmptyState, Field, IconButton, Input, KeyChip, Kbd, Logo, Mosaic,
  PriorityMark, Segmented, Select, Skeleton, Spinner, StatusPill, Switch, Tabs, Textarea, ToastCard, Tooltip,
} from '../ds/index.jsx';

// /styleguide: every token and component of the design system, in the current theme, with live
// contrast ratios measured from the real CSS. Not linked from the app. The words inside the
// specimens are placeholders to show each component; no screen uses them.

const SECTIONS = [['colour', 'Colour'], ['type', 'Type'], ['shape', 'Shape & space'], ['depth', 'Depth'], ['motion', 'Motion'], ['components', 'Components']];

const COLOURS = [
  { group: 'Surfaces', note: 'Back to front. In dark mode each step is lighter; each has its own shadow.', items: [['canvas', '--c-canvas'], ['sunken', '--c-sunken'], ['surface', '--c-surface'], ['raised', '--c-raised'], ['overlay', '--c-overlay']] },
  { group: 'Lines and states', items: [['line', '--c-line'], ['line-strong', '--c-line-strong'], ['field', '--c-field'], ['hover', '--c-hover'], ['press', '--c-press'], ['selection', '--c-selection']] },
  { group: 'Text', text: true, note: 'Ratios are against the surface colour. Faint is for decoration and disabled text only.', items: [['fg', '--c-fg'], ['fg-muted', '--c-fg-muted'], ['fg-subtle', '--c-fg-subtle'], ['fg-faint', '--c-fg-faint']] },
  { group: 'Accent, focus and keys', text: true, items: [['accent', '--c-accent'], ['focus', '--c-focus', 'non-text: 3:1 needed'], ['key', '--c-key', 'on key-bg', '--c-key-bg']] },
  { group: 'Status', text: true, note: 'Always paired with an icon and a word.', items: [['status-todo', '--c-status-todo'], ['status-progress', '--c-status-progress'], ['status-done', '--c-status-done']] },
  { group: 'Priority', text: true, note: 'Shown as signal bars; colour only adds to the bar count.', items: [['prio-critical', '--c-prio-critical'], ['prio-high', '--c-prio-high'], ['prio-medium', '--c-prio-medium'], ['prio-low', '--c-prio-low']] },
  { group: 'Feedback', text: true, items: [['success', '--c-success'], ['warning', '--c-warning'], ['danger', '--c-danger'], ['info', '--c-info']] },
];

const TYPE = [
  ['display', '48 / 48 · Instrument Serif italic', 'font-display text-display italic', 'Every ticket is a tile.'],
  ['title', '32 / 35 · Instrument Serif italic', 'font-display text-title italic', 'Checkout, sprint 14'],
  ['h1', '24 / 30 · Instrument Serif italic', 'font-display text-h1 italic', 'Board'],
  ['h2', '18 / 24 · Geist 600', 'text-h2 font-semibold', 'Ready for review'],
  ['h3', '15 / 21 · Geist 600', 'text-h3 font-semibold', 'Steps to reproduce'],
  ['body', '14 / 21 · Geist 400', 'text-body', 'The checkout button does nothing when a coupon is applied. অনন্যা চট্টোপাধ্যায় · अनन्या'],
  ['small', '13 / 19 · Geist 400', 'text-small text-fg-muted', 'Updated 3 minutes ago by the person who moved it'],
  ['caption', '12 / 17 · Geist 500', 'text-caption font-medium text-fg-muted', 'Assignee · Due date · Labels'],
  ['micro', '11 / 14 · Geist 500, caps', 'text-micro font-medium uppercase tracking-wider text-fg-subtle', 'In progress · 4'],
  ['code', '13 · Geist Mono', 'font-code text-small', 'SHOP-142   git checkout -b shop-142-safari'],
];

const RADII = [['shard', '2px', 'rounded-shard', 'Mosaic cells'], ['hair', '4px', 'rounded-hair', 'Chips, keys, checkboxes'], ['tile', '6px', 'rounded-tile', 'Buttons, fields, menu items'], ['card', '10px', 'rounded-card', 'Cards, menus'], ['panel', '16px', 'rounded-panel', 'Dialogs, drawers, sheets']];
const SPACE = [['1', '4', 'w-1'], ['2', '8', 'w-2'], ['3', '12', 'w-3'], ['4', '16', 'w-4'], ['6', '24', 'w-6'], ['8', '32', 'w-8'], ['12', '48', 'w-12'], ['16', '64', 'w-16']];
const DEPTH = [['surface', 'bg-surface shadow-surface', 'Panels that sit on the page'], ['raised', 'bg-raised shadow-raised', 'Cards and buttons'], ['lift', 'bg-raised shadow-lift', 'A card being hovered or dragged'], ['overlay', 'bg-overlay shadow-overlay', 'Menus, dialogs, toasts'], ['done', 'bg-raised shadow-done', 'The glow of finished work']];
const DURATIONS = [['instant', '--dur-instant', '80ms'], ['fast', '--dur-fast', '140ms'], ['base', '--dur-base', '220ms'], ['slow', '--dur-slow', '360ms'], ['set', '--dur-set', '560ms']];
const EASINGS = [['out', '--motion-out', [0.22, 1, 0.36, 1], 'Things arriving'], ['in-out', '--motion-in-out', [0.65, 0, 0.35, 1], 'Things moving across'], ['spring', '--motion-spring', [0.34, 1.4, 0.64, 1], 'A tile being set']];

/* ---- contrast, measured from the live CSS ---- */
function parseRgb(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s ?? '');
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r, g, b, a };
}
const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
function luminance({ r, g, b }) {
  const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hex = ({ r, g, b, a }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}${a < 1 ? ` · ${Math.round(a * 100)}%` : ''}`;

function useResolvedColours(probeRef, theme) {
  const [values, setValues] = useState({});
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const probe = probeRef.current;
      if (!probe) return;
      const read = (v) => { probe.style.color = `var(${v})`; return parseRgb(getComputedStyle(probe).color); };
      const next = {};
      for (const g of COLOURS) for (const [, v, , bg] of g.items) { next[v] = read(v); if (bg) next[bg] = read(bg); }
      next['--c-surface'] = read('--c-surface');
      setValues(next);
    });
    return () => { cancelAnimationFrame(frame); };
  }, [probeRef, theme]);
  return values;
}

function grade(r) {
  if (r >= 7) return ['AAA', 'success'];
  if (r >= 4.5) return ['AA', 'success'];
  if (r >= 3) return ['AA large / UI', 'warning'];
  return ['Decoration only', 'neutral'];
}

/* ---- layout pieces ---- */
function Section({ id, title, intro, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 border-t border-line py-12">
      <h2 id={`${id}-h`} className="font-display text-title italic text-fg">{title}</h2>
      {intro && <p className="mt-2 max-w-2xl text-small text-fg-muted">{intro}</p>}
      <div className="mt-8 space-y-10">{children}</div>
    </section>
  );
}

function Sub({ title, note, children }) {
  return (
    <div>
      <h3 className="text-micro font-medium uppercase tracking-wider text-fg-subtle">{title}</h3>
      {note && <p className="mt-1 text-caption text-fg-subtle">{note}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Swatch({ name, v, note, bgVar, text, values }) {
  const c = values[v];
  const under = bgVar ? values[bgVar] && values['--c-surface'] && over(values[bgVar], values['--c-surface']) : values['--c-surface'];
  const ratio = text && c && under ? contrast(over(c, under), under) : null;
  const [label, tone] = ratio ? grade(ratio) : [];
  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-surface">
      {text ? (
        <div className="flex h-16 items-center border-b border-line px-3" style={bgVar ? { background: `var(${bgVar})` } : undefined}>
          <span className="text-h2 font-semibold" style={{ color: `var(${v})` }}>Aa Tessera</span>
        </div>
      ) : <div className="h-16 border-b border-line" style={{ background: `var(${v})` }} />}
      <div className="space-y-1 p-3">
        <div className="text-small font-medium text-fg">{name}</div>
        <div className="font-code text-micro text-fg-subtle">{v}</div>
        <div className="font-code text-micro text-fg-subtle">{c ? hex(c) : '…'}</div>
        {ratio && <Badge tone={tone}>{ratio.toFixed(2)}:1 · {label}</Badge>}
        {note && <div className="text-micro text-fg-subtle">{note}</div>}
      </div>
    </div>
  );
}

function EaseCurve({ points }) {
  const [x1, y1, x2, y2] = points;
  const d = `M0,100 C${x1 * 100},${100 - y1 * 100} ${x2 * 100},${100 - y2 * 100} 100,0`;
  return (
    <svg viewBox="-6 -50 112 162" className="h-24 w-20 text-fg" aria-hidden>
      <line x1="0" y1="0" x2="100" y2="0" stroke="var(--c-line-strong)" strokeDasharray="3 3" />
      <line x1="0" y1="100" x2="100" y2="100" stroke="var(--c-line-strong)" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const PRIORITY_OPTIONS = ['critical', 'high', 'medium', 'low'].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1), leading: <PriorityMark priority={p} /> }));
const STATUS_OPTIONS = [
  { value: 'todo', label: 'To do', leading: <StatusPill status="todo" size="sm" label="" className="w-5 justify-center px-0" /> },
  { value: 'in_progress', label: 'In progress', leading: <StatusPill status="in_progress" size="sm" label="" className="w-5 justify-center px-0" /> },
  { value: 'done', label: 'Done', leading: <StatusPill status="done" size="sm" label="" className="w-5 justify-center px-0" /> },
];
const MOSAIC_SPECIMEN = ['done', 'done', 'in_progress', 'todo', 'done', 'in_progress', 'todo', 'todo', 'done', 'todo', 'in_progress', 'done', 'todo', 'todo'].map((status) => ({ status }));
const TABS = [
  { value: 'board', label: 'Board', icon: Columns3, group: 'views' },
  { value: 'list', label: 'List', icon: LayoutList, group: 'views' },
  { value: 'calendar', label: 'Calendar', icon: CalendarDays, group: 'views' },
  { value: 'timeline', label: 'Timeline', icon: GanttChart, group: 'views' },
  { value: 'sprints', label: 'Sprints', icon: Timer, group: 'plan' },
  { value: 'analytics', label: 'Analytics', icon: ChartNoAxesColumn, group: 'plan' },
  { value: 'settings', label: 'Settings', icon: Settings, group: 'admin' },
];

export default function StyleguidePage() {
  const { theme, toggle } = useTheme();
  const probe = useRef(null);
  const values = useResolvedColours(probe, theme);
  const reduced = useReducedMotion();
  const [played, setPlayed] = useState(false);
  const [mosaicRun, setMosaicRun] = useState(0);
  const [priority, setPriority] = useState('high');
  const [status, setStatus] = useState('in_progress');
  const [view, setView] = useState('board');
  const [range, setRange] = useState('30');
  const [tab, setTab] = useState('board');
  const [notify, setNotify] = useState(true);
  const [digest, setDigest] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [saving, setSaving] = useState('idle');
  const timers = useRef([]);

  useEffect(() => {
    const before = document.title;
    document.title = 'Styleguide · Tessera';
    const list = timers.current;
    return () => { document.title = before; list.forEach(clearTimeout); };
  }, []);

  const save = () => {
    setSaving('busy');
    timers.current.push(setTimeout(() => setSaving('done'), 900), setTimeout(() => setSaving('idle'), 2600));
  };

  return (
    <DSProvider>
      <div className="ds-canvas min-h-dvh">
        <span ref={probe} aria-hidden className="hidden" />
        <a href="#main" className="ds-focus sr-only rounded-tile bg-overlay px-3 py-2 text-small text-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50">Skip to content</a>

        <header className="sticky top-0 z-30 border-b border-line bg-canvas/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
            <Logo wordmark size={26} />
            <span className="hidden text-caption text-fg-subtle sm:inline">Design system · Stained Glass</span>
            <span className="flex-1" />
            <Segmented
              label="Theme"
              size="sm"
              value={theme}
              onChange={(t) => { if (t !== theme) toggle(); }}
              options={[{ value: 'dark', label: 'Dark', icon: Moon }, { value: 'light', label: 'Light', icon: Sun }]}
            />
          </div>
        </header>

        <div className="mx-auto flex max-w-6xl gap-10 px-4 sm:px-6">
          <nav aria-label="Sections" className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-40 shrink-0 py-8 lg:block">
            <ul className="space-y-1">
              {SECTIONS.map(([id, label]) => (
                <li key={id}><a href={`#${id}`} className="ds-focus block rounded-tile px-2 py-1 text-small text-fg-muted hover:bg-hover hover:text-fg">{label}</a></li>
              ))}
            </ul>
          </nav>

          <main id="main" className="min-w-0 flex-1 pb-24 pt-10">
            <p className="text-micro font-medium uppercase tracking-wider text-fg-subtle">Tessera design system</p>
            <h1 className="mt-3 font-display text-display italic text-fg">
              Light through <span className="ds-gradient-text pr-1">coloured glass</span>
            </h1>
            <p className="mt-4 max-w-2xl text-body text-fg-muted">
              Deep ink, with colour only where it means something: status, priority, focus, and the gradient reserved for the logo,
              the main action and finished work. Every value below comes from one set of tokens, in both themes.
            </p>

            <Section id="colour" title="Colour" intro="Measured live from the CSS in the theme you are looking at. Switch the theme at the top to check the other one.">
              {COLOURS.map((g) => (
                <Sub key={g.group} title={g.group} note={g.note}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {g.items.map(([name, v, note, bgVar]) => <Swatch key={v} name={name} v={v} note={note} bgVar={bgVar} text={g.text} values={values} />)}
                  </div>
                </Sub>
              ))}
              <Sub title="Brand gradient" note="Logo, the primary action, focus and the done glow. Nowhere else.">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="h-16 w-full max-w-md rounded-card ds-gradient shadow-raised" />
                  <div className="font-code text-micro text-fg-subtle">--gradient: #F7B23B → #F2557D → #8B6CF6 (135°)<br />ink on it: --on-gradient #14111A</div>
                </div>
              </Sub>
            </Section>

            <Section id="type" title="Type" intro="Instrument Serif for headings with a voice, Geist for everything you read and use, Geist Mono for keys and code. Names in any script fall back to Noto / Nirmala.">
              <div className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-surface">
                {TYPE.map(([name, spec, cls, sample]) => (
                  <div key={name} className="grid gap-2 p-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
                    <div>
                      <div className="text-small font-medium text-fg">{name}</div>
                      <div className="font-code text-micro text-fg-subtle">{spec}</div>
                    </div>
                    <div className={`${cls} min-w-0 break-words text-fg`}>{sample}</div>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="shape" title="Shape & space" intro="Five radii and a 4-point spacing scale. A shape inside another has a smaller radius than its container.">
              <Sub title="Radius">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {RADII.map(([name, px, cls, use]) => (
                    <div key={name} className="space-y-2">
                      <div className={`${cls} h-16 border border-line-strong bg-raised shadow-raised`} />
                      <div className="text-small font-medium text-fg">{name} · {px}</div>
                      <div className="text-caption text-fg-subtle">{use}</div>
                    </div>
                  ))}
                </div>
              </Sub>
              <Sub title="Spacing">
                <div className="space-y-2">
                  {SPACE.map(([step, px, cls]) => (
                    <div key={step} className="flex items-center gap-4">
                      <span className="w-16 font-code text-micro text-fg-subtle">{step} · {px}px</span>
                      <span className={`${cls} h-3 rounded-shard ds-gradient`} />
                    </div>
                  ))}
                </div>
              </Sub>
            </Section>

            <Section id="depth" title="Depth" intro="Four levels, each with its own fill, edge and shadow. In dark mode a fine top highlight catches the light, like the edge of a pane.">
              <div className="grid grid-cols-2 gap-4 rounded-panel bg-sunken p-4 sm:grid-cols-3 sm:p-6 lg:grid-cols-5">
                {DEPTH.map(([name, cls, use]) => (
                  <div key={name} className={`${cls} rounded-card p-4`}>
                    <div className="text-small font-medium text-fg">{name}</div>
                    <div className="mt-1 text-caption text-fg-muted">{use}</div>
                  </div>
                ))}
              </div>
              <Sub title="Focus" note="One focus outline for everything you can reach with the keyboard. Press Tab on this page to see it.">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="inline-flex h-9 items-center rounded-tile bg-raised px-3.5 text-small font-medium text-fg shadow-raised outline-2 outline-offset-2 outline-focus">Focused button</span>
                  <span className="inline-flex h-9 w-56 items-center rounded-tile border border-line-strong bg-hover px-3 text-small text-fg-subtle outline-2 outline-offset-2 outline-focus">Focused field</span>
                </div>
              </Sub>
            </Section>

            <Section id="motion" title="Motion" intro={`Quick and physical, never decorative for its own sake. ${reduced ? 'Your device asks for reduced motion, so everything here jumps straight to the end.' : 'With reduced motion turned on, every duration below becomes zero.'}`}>
              <Sub title="Durations">
                <div className="space-y-3">
                  {DURATIONS.map(([name, v, ms]) => (
                    <div key={name} className="flex items-center gap-4">
                      <span className="w-28 shrink-0 font-code text-micro text-fg-subtle">{name} · {ms}</span>
                      <span className="relative h-2 flex-1 rounded-full bg-hover">
                        <span className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full ds-gradient" style={{ left: played ? 'calc(100% - 0.75rem)' : '0', transition: `left var(${v}) var(--motion-out)` }} />
                      </span>
                    </div>
                  ))}
                  <Button size="sm" onClick={() => setPlayed((p) => !p)}>{played ? 'Play back' : 'Play'}</Button>
                </div>
              </Sub>
              <Sub title="Easing">
                <div className="flex flex-wrap gap-6">
                  {EASINGS.map(([name, v, pts, use]) => (
                    <div key={name} className="flex items-center gap-3 rounded-card bg-surface p-3 shadow-surface">
                      <EaseCurve points={pts} />
                      <div>
                        <div className="text-small font-medium text-fg">{name}</div>
                        <div className="font-code text-micro text-fg-subtle">{v}</div>
                        <div className="mt-1 text-caption text-fg-muted">{use}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Sub>
            </Section>

            <Section id="components" title="Components" intro="The parts every screen is built from. Each one works with the keyboard alone and never relies on colour only.">
              <Sub title="Buttons">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" icon={Plus} kbd="C">New ticket</Button>
                    <Button>Secondary</Button>
                    <Button variant="ghost">Ghost</Button>
                    <Button variant="danger" icon={Trash2}>Delete</Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" size="sm">Small</Button>
                    <Button variant="primary">Medium</Button>
                    <Button variant="primary" size="lg">Large</Button>
                    <Button variant="primary" loading={saving === 'busy'} done={saving === 'done'} onClick={save}>
                      {saving === 'done' ? 'Saved' : 'Save (try me)'}
                    </Button>
                    <Button loading>Loading</Button>
                    <Button disabled>Disabled</Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <IconButton label="Search" shortcut="/" icon={Search} />
                    <IconButton label="Notifications" icon={Bell} />
                    <IconButton label="Quick actions" shortcut="⌘K" icon={Zap} />
                    <IconButton label="Settings" icon={Settings} variant="secondary" />
                    <IconButton label="Delete" icon={Trash2} variant="danger" />
                  </div>
                </div>
              </Sub>

              <Sub title="Fields">
                <div className="grid max-w-3xl gap-5 sm:grid-cols-2">
                  <Field label="Title" required hint="Short and specific: what is wrong, where.">
                    <Input placeholder="Checkout button does nothing on Safari" />
                  </Field>
                  <Field label="Email" error="That doesn't look like an email address.">
                    <Input type="email" defaultValue="riya@" />
                  </Field>
                  <Field label="Priority">
                    <Select value={priority} onChange={setPriority} options={PRIORITY_OPTIONS} />
                  </Field>
                  <Field label="Status">
                    <Select value={status} onChange={setStatus} options={STATUS_OPTIONS} />
                  </Field>
                  <Field label="Description" className="sm:col-span-2">
                    <Textarea placeholder="What happened, what you expected, and how to make it happen again." />
                  </Field>
                </div>
              </Sub>

              <Sub title="Choices">
                <div className="grid max-w-3xl gap-6 sm:grid-cols-2">
                  <div className="space-y-3">
                    <Checkbox label="Only my tickets" defaultChecked />
                    <Checkbox label="Show done" description="Tickets finished in the last 14 days." />
                    <Checkbox label="Unavailable option" disabled />
                  </div>
                  <div className="space-y-4">
                    <Switch label="Email me about mentions" description="Sent within a minute." checked={notify} onChange={setNotify} />
                    <Switch label="Daily digest" checked={digest} onChange={setDigest} />
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                    <Segmented label="View" value={view} onChange={setView} options={[{ value: 'board', label: 'Board', icon: Columns3 }, { value: 'list', label: 'List', icon: LayoutList }, { value: 'calendar', label: 'Calendar', icon: CalendarDays }]} />
                    <Segmented label="Range" size="sm" value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
                  </div>
                </div>
              </Sub>

              <Sub title="Tabs" note="Grouped: views, planning, admin. Arrow keys move between them.">
                <Tabs label="Project" tabs={TABS} value={tab} onChange={setTab} />
              </Sub>

              <Sub title="Ticket marks">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status="todo" /><StatusPill status="in_progress" /><StatusPill status="done" />
                    <StatusPill status="in_progress" size="sm" />
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <PriorityMark priority="critical" withLabel /><PriorityMark priority="high" withLabel />
                    <PriorityMark priority="medium" withLabel /><PriorityMark priority="low" withLabel />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyChip>SHOP-1</KeyChip><KeyChip>SHOP-142</KeyChip><KeyChip>WAR-1024</KeyChip>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>neutral</Badge><Badge tone="accent">accent</Badge><Badge tone="success">success</Badge>
                    <Badge tone="warning">warning</Badge><Badge tone="danger">danger</Badge><Badge tone="info">info</Badge>
                  </div>
                </div>
              </Sub>

              <Sub title="People" note="Initials work in every script. The gradient ring means the person is here now.">
                <div className="flex flex-wrap items-center gap-4">
                  <Avatar name="অনন্যা চট্টোপাধ্যায়" size="sm" />
                  <Avatar name="অনন্যা চট্টোপাধ্যায়" />
                  <Avatar name="Riya Sen" size="lg" />
                  <Avatar name="Arjun Mehta" size="xl" />
                  <Avatar name="Riya Sen" size="lg" presence />
                  <span className="flex -space-x-2">
                    {['Riya Sen', 'Arjun Mehta', 'অনন্যা চট্টোপাধ্যায়', 'Kabir Das'].map((n) => <Avatar key={n} name={n} className="ring-2 ring-canvas" />)}
                  </span>
                </div>
              </Sub>

              <Sub title="Cards" note="A ticket card as the board will show it. Move the pointer over it.">
                <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
                  <Card spotlight interactive className="space-y-3 p-3.5">
                    <div className="flex items-center gap-2">
                      <KeyChip>SHOP-1</KeyChip>
                      <span className="flex-1" />
                      <PriorityMark priority="critical" />
                    </div>
                    <p className="text-small font-medium text-fg">Checkout button does nothing on Safari 17</p>
                    <div className="flex items-center gap-2">
                      <StatusPill status="in_progress" size="sm" />
                      <Badge>checkout</Badge>
                      <span className="flex-1" />
                      <Avatar name="অনন্যা চট্টোপাধ্যায়" size="sm" />
                    </div>
                  </Card>
                  <Card spotlight interactive className="space-y-3 p-3.5 shadow-done">
                    <div className="flex items-center gap-2">
                      <KeyChip>SHOP-4</KeyChip>
                      <span className="flex-1" />
                      <PriorityMark priority="low" />
                    </div>
                    <p className="text-small font-medium text-fg">Write release notes for 2.4</p>
                    <div className="flex items-center gap-2">
                      <StatusPill status="done" size="sm" />
                      <Badge>docs</Badge>
                    </div>
                  </Card>
                </div>
              </Sub>

              <Sub title="Mosaic" note="The signature. One tile per ticket, by status; dashed tiles are open slots. Screen readers hear a one-line summary.">
                <div className="flex flex-wrap items-end gap-6">
                  <Mosaic key={mosaicRun} tiles={MOSAIC_SPECIMEN} empty={6} size="lg" animate />
                  <Mosaic tiles={MOSAIC_SPECIMEN} empty={6} size="md" />
                  <Mosaic tiles={MOSAIC_SPECIMEN} size="sm" />
                  <Button size="sm" onClick={() => setMosaicRun((n) => n + 1)}>Set the tiles again</Button>
                </div>
              </Sub>

              <Sub title="Loading">
                <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
                  <Card className="space-y-3 p-3.5">
                    <div className="flex items-center gap-2"><Skeleton className="h-5 w-16" /><span className="flex-1" /><Skeleton className="size-4" /></div>
                    <Skeleton className="h-4 w-11/12" />
                    <Skeleton className="h-4 w-2/3" />
                  </Card>
                  <div className="flex items-center gap-3 text-small text-fg-muted"><Spinner className="text-fg-subtle" /> Loading the board…</div>
                </div>
              </Sub>

              <Sub title="Empty state">
                <Card level="surface">
                  <EmptyState
                    icon={Inbox}
                    title="No tickets yet"
                    action={<Button variant="primary" icon={Plus} kbd="C">New ticket</Button>}
                    secondary={<Button variant="ghost">Import from CSV</Button>}
                  >
                    Tickets you and your team create show up here, one tile each.
                  </EmptyState>
                </Card>
              </Sub>

              <Sub title="Feedback">
                <div className="space-y-4">
                  <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
                    <ToastCard title="Moved SHOP-2 to In progress" action={<Button size="sm" variant="ghost">Undo</Button>} />
                    <ToastCard tone="error" title="Couldn't save">The server didn't answer. Your text is kept; try again.</ToastCard>
                    <ToastCard tone="info" title="Riya is editing this ticket" />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Tooltip content="Opens the command menu" shortcut="⌘K"><Button>Hover or focus me</Button></Tooltip>
                    <Button onClick={() => setDialog(true)}>Open a dialog</Button>
                    <span className="inline-flex items-center gap-1.5 text-caption text-fg-subtle">Shortcuts look like <Kbd>G</Kbd><Kbd>B</Kbd></span>
                  </div>
                </div>
              </Sub>
            </Section>
          </main>
        </div>

        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Delete SHOP-4?"
          description="The ticket, its comments and its history are removed for everyone."
          footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button><Button variant="danger" icon={Trash2} onClick={() => setDialog(false)}>Delete</Button></>}
        >
          <Field label="Type the key to confirm" hint="This can't be undone.">
            <Input placeholder="SHOP-4" />
          </Field>
        </Dialog>
      </div>
    </DSProvider>
  );
}
