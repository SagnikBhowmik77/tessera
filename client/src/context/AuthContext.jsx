import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler, tokenStore } from '../lib/api.js';
// The live connection is loaded with the signed-in app; signing out closes it if it was opened
// (loaded on demand here, so public pages never download the socket client).
const closeSocket = () => import('../lib/socket.js').then((m) => m.closeSocket());

const AuthContext = createContext(null);

// The signed-in person as last seen (what /auth/me returned), kept beside the token and cleared
// with it. With it the app paints at once on the next visit instead of waiting for the sign-in
// check, and that check then refreshes it in the background. Only a refusal (401) signs out; a
// flaky connection no longer does.
const SNAPSHOT = 'tessera.user';
const readSnapshot = () => { try { return JSON.parse(localStorage.getItem(SNAPSHOT)); } catch { return null; } };
const writeSnapshot = (u) => { try { if (u) localStorage.setItem(SNAPSHOT, JSON.stringify(u)); else localStorage.removeItem(SNAPSHOT); } catch { /* storage blocked */ } };

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const [user, setUserState] = useState(() => (tokenStore.get() ? readSnapshot() : null));
  const [ready, setReady] = useState(() => !tokenStore.get() || Boolean(readSnapshot()));
  const setUser = useCallback((u) => { setUserState(u); writeSnapshot(u); }, []);

  const forget = useCallback(() => {
    tokenStore.clear();
    writeSnapshot(null);
    closeSocket();
    qc.clear();
    setUserState(null);
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(forget);
    if (!tokenStore.get()) {
      writeSnapshot(null);
      setReady(true);
      return;
    }
    let cancelled = false;
    api('/auth/me')
      .then((d) => { if (!cancelled) setUser(d.user); })
      .catch((e) => {
        // Refused: the session is over. Anything else (offline, the server busy) keeps the person
        // signed in when there is a snapshot to show; without one there is nothing to show yet.
        if (!cancelled && (e.status === 401 || e.status === 403 || !readSnapshot())) forget();
      })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [forget, setUser]);

  const value = useMemo(() => {
    const signIn = async (path, body) => {
      const d = await api(path, { method: 'POST', body });
      // 2FA on: the password was right, but a code from the app is still needed (no token yet).
      if (d.twoFactorRequired) return d;
      tokenStore.set(d.token);
      setUser(d.user);
      return d;
    };
    return {
      user,
      ready,
      login: (body) => signIn('/auth/login', body),
      // The code step after a correct password: { ticket, code } (a 6-digit code or a backup code).
      loginSecondStep: (body) => signIn('/auth/login/2fa', body),
      register: (body) => signIn('/auth/register', body),
      // A fresh token for this device (after a password change signs out every other one).
      adoptToken: (token, nextUser) => { tokenStore.set(token); setUser(nextUser); },
      logout: async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* signed out locally either way */ }
        forget();
      },
      setUser,
    };
  }, [user, ready, forget, setUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
