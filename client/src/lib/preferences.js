import { useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { api } from './api.js';
import { ACCENTS } from './accents.js';
import { applyTheme, themeChoice } from './theme.js';
import { useAuth } from '../context/AuthContext.jsx';

// Personal preferences, saved with the account (PATCH /auth/me/preferences) so they follow the
// person to every device: theme, accent, density, the sidebar, and the board's layout.
export const DEFAULT_PREFERENCES = {
  theme: 'system', accent: null, density: 'comfortable', sidebarCollapsed: false,
  board: { lanes: '', mine: false, sprintOnly: false },
};
const LOOK = 'tessera.look';

const withDefaults = (p) => ({ ...DEFAULT_PREFERENCES, ...p, board: { ...DEFAULT_PREFERENCES.board, ...p?.board } });

// [preferences, update]. update(changes) shows the change at once and saves it; if the server
// refuses, it goes back and says so (the voice rule: plain, and what happened next).
export function usePreferences() {
  const { user, setUser } = useAuth();
  const prefs = withDefaults(user?.preferences);
  const latest = useRef(user);
  useEffect(() => { latest.current = user; }, [user]);
  const update = useCallback(async (changes) => {
    const before = latest.current;
    if (!before) return false;
    const merged = withDefaults({ ...before.preferences, ...changes, board: { ...before.preferences?.board, ...changes.board } });
    latest.current = { ...before, preferences: merged };
    setUser(latest.current);
    if (changes.theme) applyTheme(changes.theme);
    try {
      const { user: saved } = await api('/auth/me/preferences', { method: 'PATCH', body: changes });
      latest.current = saved;
      setUser(saved);
      return true;
    } catch (e) {
      latest.current = before;
      setUser(before);
      if (changes.theme) applyTheme(withDefaults(before.preferences).theme);
      toast.error(`Couldn't save that preference: ${e.message} It's back to how it was.`);
      return false;
    }
  }, [setUser]);
  return [prefs, update];
}

// Applies the account's look to the signed-in app: theme, accent (the same contrast-checked
// set as the public pages, see lib/accents.js) and density. A copy of the accent and density lets
// index.html apply them before the first paint; leaving the signed-in app takes them off again, so
// public pages keep their own (or the team's) look.
export function useLook(prefs) {
  useEffect(() => {
    if (prefs.theme !== themeChoice()) applyTheme(prefs.theme);
  }, [prefs.theme]);
  useEffect(() => {
    const html = document.documentElement;
    const a = ACCENTS[prefs.accent];
    if (a) {
      html.classList.add('ds-accented');
      html.style.setProperty('--accent-light', a.light);
      html.style.setProperty('--accent-dark', a.dark);
    }
    html.dataset.density = prefs.density;
    try { localStorage.setItem(LOOK, JSON.stringify({ accent: a ? [a.light, a.dark] : null, density: prefs.density })); } catch { /* storage blocked */ }
    return () => {
      html.classList.remove('ds-accented');
      html.style.removeProperty('--accent-light');
      html.style.removeProperty('--accent-dark');
      delete html.dataset.density;
    };
  }, [prefs.accent, prefs.density]);
}
