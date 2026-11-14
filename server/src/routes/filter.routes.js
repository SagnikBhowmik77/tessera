import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import * as filters from '../services/filter.service.js';
import { createFilterSchema, updateFilterSchema, filterParams } from '../schemas/filter.schemas.js';

// Mounted at /api/projects/:projectId/filters after requireProject('viewer').
// Saved filters are personal views, so every member (viewers too) can keep them.
export function filterRouter() {
  const router = Router({ mergeParams: true });
  const f = validate({ params: filterParams });

  router.get('/', async (req, res) => {
    res.json({ filters: await filters.listFilters(req.project, req.user) });
  });
  router.post('/', validate({ body: createFilterSchema }), async (req, res) => {
    res.status(201).json({ filter: await filters.createFilter(req.project, req.user, req.valid.body) });
  });
  router.patch('/:filterId', f, validate({ body: updateFilterSchema }), async (req, res) => {
    res.json({ filter: await filters.updateFilter(req.project, req.user, req.valid.params.filterId, req.valid.body) });
  });
  router.delete('/:filterId', f, async (req, res) => {
    await filters.deleteFilter(req.project, req.membership, req.user, req.valid.params.filterId);
    res.status(204).end();
  });
  return router;
}
