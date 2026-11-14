import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { config } from './config.js';
import { dbStatus } from './db.js';
import { Project } from './models/index.js';
import { verifyToken } from './services/auth.service.js';

// Live collaboration over Socket.IO.
// Rooms: user:<id> (every tab of one person), project:<id> (board updates),
// ticket:<projectId>:<number> (who is looking at a ticket, and typing).
let io = null;
// ticket room -> Map(socketId -> { id, name })
const presence = new Map();

const reply = (ack, value) => { if (typeof ack === 'function') ack(value); };
const ticketRoom = (projectId, number) => `ticket:${projectId}:${number}`;

function usersIn(room) {
  const seen = new Map();
  for (const u of presence.get(room)?.values() ?? []) seen.set(u.id, u);
  return [...seen.values()];
}

function broadcastPresence(room) {
  const [, projectId, number] = room.split(':');
  io.to(room).emit('presence', { projectId, number: Number(number), users: usersIn(room) });
}

function stopViewing(socket) {
  const room = socket.data.viewing;
  if (!room) return;
  socket.data.viewing = null;
  presence.get(room)?.delete(socket.id);
  if (presence.get(room)?.size === 0) presence.delete(room);
  socket.leave(room);
  broadcastPresence(room);
}

export function attachRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: config.clientOrigins }, serveClient: false });

  // Same login as the REST API: the token goes in the handshake's `auth.token`.
  io.use(async (socket, next) => {
    try {
      if (!dbStatus().connected) return next(new Error('db_unavailable'));
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('auth_required'));
      const { user, claims } = await verifyToken(token);
      socket.data.user = { id: String(user._id), name: user.name };
      socket.data.session = claims.jti;
      next();
    } catch (err) {
      next(new Error(err.code || 'invalid_token'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.user;
    socket.join(`user:${me.id}`);
    // So one signed-out device can be disconnected without touching the others.
    socket.join(`session:${socket.data.session}`);

    // Board updates for one project; members only.
    socket.on('project:join', async (projectId, ack) => {
      try {
        if (!mongoose.isValidObjectId(projectId)) return reply(ack, { ok: false, error: 'project_not_found' });
        const member = await Project.exists({ _id: projectId, 'members.user': me.id });
        if (!member) return reply(ack, { ok: false, error: 'project_not_found' });
        socket.join(`project:${projectId}`);
        reply(ack, { ok: true });
      } catch {
        reply(ack, { ok: false, error: 'internal' });
      }
    });

    socket.on('project:leave', (projectId, ack) => {
      if (socket.data.viewing?.startsWith(`ticket:${projectId}:`)) stopViewing(socket);
      socket.leave(`project:${projectId}`);
      reply(ack, { ok: true });
    });

    // "Who else is looking at this ticket". One ticket per tab; opening another leaves the first.
    socket.on('ticket:view', (data, ack) => {
      const { projectId, number } = data || {};
      if (!socket.rooms.has(`project:${projectId}`)) return reply(ack, { ok: false, error: 'join_project_first' });
      if (!Number.isInteger(number) || number < 1) return reply(ack, { ok: false, error: 'bad_ticket' });
      const room = ticketRoom(projectId, number);
      if (socket.data.viewing !== room) {
        stopViewing(socket);
        socket.join(room);
        socket.data.viewing = room;
        if (!presence.has(room)) presence.set(room, new Map());
        presence.get(room).set(socket.id, me);
        broadcastPresence(room);
      }
      reply(ack, { ok: true, users: usersIn(room) });
    });

    socket.on('ticket:unview', (_data, ack) => {
      stopViewing(socket);
      reply(ack, { ok: true });
    });

    // "Asha is typing…" under the comment box, for the ticket this tab is viewing.
    socket.on('ticket:typing', (data) => {
      const room = socket.data.viewing;
      if (!room) return;
      const [, projectId, number] = room.split(':');
      socket.to(room).emit('typing', { projectId, number: Number(number), user: me, typing: Boolean(data?.typing) });
    });

    // "Ravi is moving SHOP-4": a card someone has picked up on the board, shown to everyone else in
    // the project. Members of the project room only; never echoed back to the one dragging.
    socket.on('ticket:drag', (data) => {
      const { projectId, number } = data || {};
      if (!socket.rooms.has(`project:${projectId}`) || !Number.isInteger(number) || number < 1) return;
      const dragging = Boolean(data.dragging);
      socket.data.dragging = dragging ? { projectId, number } : null;
      socket.to(`project:${projectId}`).emit('drag', { projectId, number, user: me, dragging });
    });

    socket.on('disconnect', () => {
      stopViewing(socket);
      // A tab closed mid-drag lets go of the card for everyone else.
      const held = socket.data.dragging;
      if (held) socket.to(`project:${held.projectId}`).emit('drag', { ...held, user: me, dragging: false });
    });
  });
  return io;
}

// Everything below is a no-op when no socket server is attached.

export function publish(projectId, event, payload) {
  io?.to(`project:${projectId}`).emit(event, payload);
}

export function toUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function isOnline(userId) {
  return Boolean(io?.sockets.adapter.rooms.get(`user:${userId}`)?.size);
}

// After "log out everywhere", a password change or account deletion.
export function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

// One device signed out from the Account page.
export function disconnectSession(jti) {
  io?.in(`session:${jti}`).disconnectSockets(true);
}

// Someone removed from (or leaving) a project stops receiving its updates at once.
export async function removeFromProject(userId, projectId) {
  if (!io) return;
  for (const remote of await io.in(`user:${userId}`).fetchSockets()) {
    const socket = io.sockets.sockets.get(remote.id);
    if (!socket) continue;
    if (socket.data.viewing?.startsWith(`ticket:${projectId}:`)) stopViewing(socket);
    socket.leave(`project:${projectId}`);
  }
}

export async function closeProjectRoom(projectId) {
  if (!io) return;
  for (const remote of await io.in(`project:${projectId}`).fetchSockets()) {
    const socket = io.sockets.sockets.get(remote.id);
    if (socket?.data.viewing?.startsWith(`ticket:${projectId}:`)) stopViewing(socket);
  }
  io.in(`project:${projectId}`).socketsLeave(`project:${projectId}`);
}

export async function closeRealtime() {
  if (!io) return;
  await new Promise((resolve) => io.close(() => resolve()));
  io = null;
  presence.clear();
}
