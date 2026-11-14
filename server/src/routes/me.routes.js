import { Router } from 'express';
import { requireDb } from '../db.js';
import { noApiToken, requireAuth } from '../middleware/requireAuth.js';
import { apiTokenParams, apiTokenSchema, notifySettingsSchema } from '../schemas/auth.schemas.js';
import { createToken, listTokens, revokeToken } from '../services/apitoken.service.js';
import { notifySettings, updateNotifySettings } from '../services/digest.service.js';
import { pushRemoveSchema, pushSubscriptionSchema } from '../schemas/auth.schemas.js';
import * as push from '../services/push.service.js';
import { validate } from '../middleware/validate.js';
import { assignedToMe } from '../services/search.service.js';
import { myTicketsQuery } from '../schemas/filter.schemas.js';
import * as leave from '../services/leave.service.js';
import { leaveBody, leaveParams } from '../schemas/leave.schemas.js';
import { Project } from '../models/index.js';
import { publish } from '../realtime.js';

// Leave shows on every project the person is in, so those pages refresh it.
async function leaveChanged(user) {
  const projects = await Project.find({ 'members.user': user._id }, { _id: 1 }).lean();
  for (const p of projects) publish(String(p._id), 'planning', { action: 'leave', actorId: String(user._id) });
}

// Things about the signed-in person across all their projects.
export function meRouter() {
  const router = Router();
  router.use(requireDb, requireAuth);
  // Personal API tokens (E13): only with a real login.
  router.get('/tokens', noApiToken, async (req, res) => res.json({ tokens: await listTokens(req.user) }));
  router.post('/tokens', noApiToken, validate({ body: apiTokenSchema }), async (req, res) => res.status(201).json({ token: await createToken(req.user, req.valid.body) }));
  router.delete('/tokens/:tokenId', noApiToken, validate({ params: apiTokenParams }), async (req, res) => res.json({ token: await revokeToken(req.user, req.valid.params.tokenId) }));
  // Push notifications (E14): this server's public key, and the person's subscribed browsers.
  router.get('/push', async (req, res) => res.json({ key: push.pushKey(), subscriptions: await push.listSubscriptions(req.user) }));
  router.post('/push', validate({ body: pushSubscriptionSchema }), async (req, res) => res.status(201).json({ subscriptions: await push.subscribe(req.user, req.valid.body, req.get('user-agent')) }));
  router.delete('/push', validate({ body: pushRemoveSchema }), async (req, res) => res.json({ subscriptions: await push.unsubscribe(req.user, req.valid.body) }));
  router.post('/push/test', async (req, res) => res.json(await push.sendToUser(req.user._id, { title: 'Tessera', body: 'Push notifications work on this device.', url: '/', tag: 'test' })));
  // Notification emails: on/off, quiet hours, digest (E13).
  router.get('/notifications', (req, res) => res.json({ settings: notifySettings(req.user) }));
  router.put('/notifications', validate({ body: notifySettingsSchema }), async (req, res) => res.json({ settings: await updateNotifySettings(req.user, req.valid.body) }));
  // "My work": open tickets assigned to me, soonest due first.
  router.get('/tickets', validate({ query: myTicketsQuery }), async (req, res) => {
    res.json(await assignedToMe(req.user, req.valid.query));
  });
  // My leave (time off). Teammates see it on project calendars and assignee pickers.
  router.get('/leave', async (req, res) => {
    res.json({ leave: await leave.myLeave(req.user) });
  });
  router.post('/leave', validate({ body: leaveBody }), async (req, res) => {
    const added = await leave.addLeave(req.user, req.valid.body);
    await leaveChanged(req.user);
    res.status(201).json({ leave: added });
  });
  router.delete('/leave/:leaveId', validate({ params: leaveParams }), async (req, res) => {
    await leave.removeLeave(req.user, req.valid.params.leaveId);
    await leaveChanged(req.user);
    res.status(204).end();
  });
  return router;
}
