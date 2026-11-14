import { useEffect, useState } from 'react';
import { api } from './api.js';

// Comment drafts and an offline send queue (E14). Drafts are kept per ticket in this browser, so
// a half-written comment survives a reload or a closed tab. A comment written while offline waits
// in the queue and is sent when the connection comes back. Both live only in this browser.

const DRAFT = 'tessera.draft.';
const OUTBOX = 'tessera.outbox';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } };

export const loadDraft = (key) => (key ? read(DRAFT + key, '') : '');
export const saveDraft = (key, text) => { if (key) write(DRAFT + key, text.trim() ? text : null); };

const listeners = new Set();
const notify = () => { for (const fn of listeners) fn(read(OUTBOX, [])); };

export function queueComment(path, body, label) {
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, path, body, label, at: new Date().toISOString() };
  write(OUTBOX, [...read(OUTBOX, []), item].slice(-50));
  notify();
  return item;
}

export const isNetworkError = (err) => err?.status === 0;

let flushing = false;
// Sends what is waiting, oldest first. Stops at the first network error (still offline); drops an
// item the server refuses (e.g. the ticket was deleted) and reports it.
export async function flushOutbox({ onSent, onDropped } = {}) {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const item of read(OUTBOX, [])) {
      try {
        await api(item.path, { method: 'POST', body: item.body });
        onSent?.(item);
      } catch (err) {
        if (isNetworkError(err)) break;
        onDropped?.(item, err);
      }
      write(OUTBOX, read(OUTBOX, []).filter((x) => x.id !== item.id));
      notify();
    }
  } finally { flushing = false; }
}

export function useOutbox() {
  const [items, setItems] = useState(() => read(OUTBOX, []));
  useEffect(() => { listeners.add(setItems); return () => listeners.delete(setItems); }, []);
  return items;
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}
