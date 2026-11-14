import { useSyncExternalStore } from 'react';

// Light, dark, or whatever the system says. Signed in, the choice is saved with the account (see
// lib/preferences.js); a local copy lets index.html apply it before the first paint, so the page
// never flashes the wrong colours, and covers the pages people see without signing in.
const KEY = 'tessera.theme';
const system = () => window.matchMedia('(prefers-color-scheme: dark)');

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

// 'light', 'dark' or 'system'.
export function themeChoice() {
  const s = stored();
  return s === 'light' || s === 'dark' ? s : 'system';
}

export function currentTheme() {
  const choice = themeChoice();
  return choice === 'system' ? (system().matches ? 'dark' : 'light') : choice;
}

// Applies a choice now and remembers it on this device.
export function applyTheme(choice) {
  try {
    if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice);
    else localStorage.removeItem(KEY);
  } catch { /* not remembered on this device */ }
  document.documentElement.classList.toggle('dark', currentTheme() === 'dark');
}

// Following the system: switch when it does.
if (typeof window !== 'undefined') {
  system().addEventListener?.('change', () => { if (themeChoice() === 'system') applyTheme('system'); });
}

const subscribe = (cb) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => o.disconnect();
};
const isDark = () => document.documentElement.classList.contains('dark');

// The theme as shown right now, and a switch to the other one. `onChange` (optional) is told the
// new choice, so a signed-in page can save it with the account.
export function useTheme(onChange) {
  const theme = useSyncExternalStore(subscribe, isDark) ? 'dark' : 'light';
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    onChange?.(next);
  };
  return { theme, toggle };
}
