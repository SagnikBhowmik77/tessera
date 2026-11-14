import { projectAnalytics, boardAt } from '../services/flow.service.js';
import { setStatuses } from '../services/column.service.js';
import { serializeProject } from '../services/project.service.js';
import { publish } from '../realtime.js';

export async function analytics(req, res) {
  res.json(await projectAnalytics(req.project, req.valid.query));
}

export async function board(req, res) {
  res.json(await boardAt(req.project, req.valid.query.at));
}

export async function statuses(req, res) {
  const project = await setStatuses(req.project, req.valid.body.statuses);
  publish(String(project._id), 'project', { action: 'updated', actorId: String(req.user._id) });
  res.json({ project: await serializeProject(project, req.user._id) });
}
