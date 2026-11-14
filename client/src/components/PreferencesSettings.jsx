import { usePreferences } from '../lib/preferences.js';
import { Button, KeyChip, SavedTick, Select, useSaved } from '../ds/core.jsx';
import { Segmented, Switch } from '../ds/motion.jsx';
import AccentPicker from './AccentPicker.jsx';

const LANES = [
  { value: '', label: 'No swimlanes' },
  { value: 'assignee', label: 'By assignee' },
  { value: 'epic', label: 'By epic' },
  { value: 'priority', label: 'By priority' },
];

function Row({ title, hint, children }) {
  return (
    <div className="grid gap-x-6 gap-y-2 border-t border-line py-4 first:border-t-0 first:pt-0 sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-start">
      <div>
        <h3 className="text-small font-medium text-fg">{title}</h3>
        {hint && <p className="mt-0.5 text-caption text-fg-subtle">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// How Tessera looks and is laid out for you. Saved with your account, so it is the same on every
// device you sign in on; each change applies and saves at once.
export default function PreferencesSettings({ Section }) {
  const [prefs, update] = usePreferences();
  const [state, run] = useSaved();
  const save = (changes) => run(update(changes));
  return (
    <Section title="Appearance and layout" description="Saved with your account, so they follow you to every device you sign in on.">
      <div className="relative">
        <SavedTick state={state} className="absolute -top-1 right-0" />
        <Row title="Theme" hint="System follows your device's light or dark setting.">
          <Segmented
            label="Theme" value={prefs.theme} onChange={(theme) => save({ theme })}
            options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
          />
        </Row>

        <Row title="Accent colour" hint="Links, focus rings, selected items and the main button take this colour. Each one passes WCAG AA in light and dark mode.">
          <AccentPicker value={prefs.accent} onChange={(accent) => save({ accent })} noneLabel="Tessera (the brand gradient)" />
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-card border border-line bg-canvas px-3 py-2.5" aria-hidden>
            <Button variant="primary" size="sm" tabIndex={-1}>New ticket</Button>
            <KeyChip>ORB-12</KeyChip>
            <span className="text-small font-medium text-key underline decoration-key/40 underline-offset-4">A link</span>
            <span className="rounded-tile border border-key-line bg-key-bg px-2 py-1 text-caption font-medium text-fg">Selected</span>
          </div>
        </Row>

        <Row title="Density" hint="Compact fits more cards and rows on screen; comfortable gives them more room.">
          <Segmented
            label="Density" value={prefs.density} onChange={(density) => save({ density })}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
          />
        </Row>

        <Row title="Sidebar" hint="On wide screens. Press [ anywhere to switch.">
          <Switch checked={prefs.sidebarCollapsed} onChange={(sidebarCollapsed) => save({ sidebarCollapsed })} label="Collapse to icons" />
        </Row>

        <Row title="Board" hint="How every board opens. Changing them on a board saves here too.">
          <div className="space-y-3">
            <Select
              size="sm" className="w-48" aria-label="Swimlanes" value={prefs.board.lanes}
              onChange={(lanes) => save({ board: { lanes } })} options={LANES}
            />
            <Switch checked={prefs.board.mine} onChange={(mine) => save({ board: { mine } })} label="Show only tickets assigned to me" />
            <Switch checked={prefs.board.sprintOnly} onChange={(sprintOnly) => save({ board: { sprintOnly } })} label="Show only the running sprint" description="When the project has one." />
          </div>
        </Row>
      </div>
    </Section>
  );
}
