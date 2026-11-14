import mongoose from 'mongoose';
import { Router } from 'express';
import { z } from 'zod';
import { requireDb } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { listNotifications, markRead } from '../services/notification.service.js';
import { deliverDueReminders } from '../services/follow.service.js';

const listQuery = z.object({
  unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // For "load older": the createdAt of the last one shown.
  before: z.iso.datetime({ message: 'before must be an ISO date-time' }).transform((s) => new Date(s)).optional(),
});
const readBody = z.object({
  // Leave out to mark everything read.
  ids: z.array(z.string().refine((v) => mongoose.isValidObjectId(v), 'Not a valid notification id')).max(100).optional(),
});

// The signed-in person's inbox.
export function notificationRouter() {
  const router = Router();
  router.use(requireDb, requireAuth);
  router.get('/', validate({ query: listQuery }), async (req, res) => {
    // Reminders that came due while the server slept arrive before the inbox is read.
    await deliverDueReminders({ userId: req.user._id });
    res.json(await listNotifications(req.user, req.valid.query));
  });
  router.post('/read', validate({ body: readBody }), async (req, res) => {
    res.json(await markRead(req.user, req.valid.body));
  });
  return router;
}
