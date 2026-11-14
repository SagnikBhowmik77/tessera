import { api } from './api.js';

// Installable app and push notifications (E14).

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err.message));
  });
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const keyBytes = (base64) => {
  const s = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Asks the browser for permission (it shows its own prompt), subscribes, and tells the server.
export async function enablePush(serverKey) {
  if (!pushSupported()) throw new Error('This browser does not support push notifications');
  if (!serverKey) throw new Error('Push notifications are not set up on this server');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site in your browser settings' : 'Permission was not given');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(serverKey) });
  return api('/me/push', { method: 'POST', body: sub.toJSON() });
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return null;
  const r = await api('/me/push', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
  return r;
}
