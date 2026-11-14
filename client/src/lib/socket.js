import { io } from 'socket.io-client';
import { apiBase, tokenStore } from './api.js';

// One live connection per tab, opened after login and closed on logout.
let socket = null;

export function getSocket() {
  if (!tokenStore.get()) return null;
  if (!socket) {
    socket = io(apiBase || undefined, {
      // A function, so a reconnect after logging in again sends the new token.
      auth: (cb) => cb({ token: tokenStore.get() }),
      transports: ['websocket'],
    });
  }
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}
