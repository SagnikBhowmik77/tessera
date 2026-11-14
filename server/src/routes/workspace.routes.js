import { Router } from 'express';
import { requireDb } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import * as ws from '../services/workspace.service.js';
import { workspaceMemberParams, workspaceMemberSchema, workspaceNameSchema, workspaceParams, workspaceRoleSchema } from '../schemas/project.schemas.js';

// Workspaces (E14): teams and companies that group projects and people.
export function workspaceRouter() {
  const router = Router();
  router.use(requireDb, requireAuth);
  const w = validate({ params: workspaceParams });
  const m = validate({ params: workspaceMemberParams });
  router.get('/', async (req, res) => res.json({ workspaces: await ws.listWorkspaces(req.user) }));
  router.post('/', validate({ body: workspaceNameSchema }), async (req, res) => res.status(201).json({ workspace: await ws.createWorkspace(req.user, req.valid.body) }));
  router.get('/:workspaceId', w, async (req, res) => res.json({ workspace: await ws.showWorkspace(req.user, req.valid.params.workspaceId) }));
  router.patch('/:workspaceId', w, validate({ body: workspaceNameSchema }), async (req, res) => res.json({ workspace: await ws.renameWorkspace(req.user, req.valid.params.workspaceId, req.valid.body) }));
  router.delete('/:workspaceId', w, async (req, res) => { await ws.deleteWorkspace(req.user, req.valid.params.workspaceId); res.status(204).end(); });
  router.post('/:workspaceId/members', w, validate({ body: workspaceMemberSchema }), async (req, res) => res.status(201).json({ workspace: await ws.addMember(req.user, req.valid.params.workspaceId, req.valid.body) }));
  router.patch('/:workspaceId/members/:userId', m, validate({ body: workspaceRoleSchema }), async (req, res) => res.json({ workspace: await ws.changeMemberRole(req.user, req.valid.params.workspaceId, req.valid.params.userId, req.valid.body.role) }));
  router.delete('/:workspaceId/members/:userId', m, async (req, res) => res.json({ workspace: await ws.removeMember(req.user, req.valid.params.workspaceId, req.valid.params.userId) }));
  return router;
}
