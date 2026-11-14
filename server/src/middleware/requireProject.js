import mongoose from 'mongoose';
import { HttpError } from '../errors.js';
import { Project } from '../models/index.js';
import { roleAtLeast } from '../services/project.service.js';

// Loads :projectId for a member of it with at least `minRole`.
// Not a member (or no such project): 404, so outsiders can't even learn the project exists.
// `write: true` blocks changes while the project is archived.
// Sets req.project (the Project document) and req.membership ({ user, role }).
export function requireProject(minRole = 'viewer', { write = false } = {}) {
  // The role rides along on the middleware for the OpenAPI document (E15).
  return Object.assign(async (req, _res, next) => {
    const { projectId } = req.params;
    const notFound = new HttpError(404, 'project_not_found', 'Project not found');
    if (!mongoose.isValidObjectId(projectId)) throw notFound;
    const project = await Project.findOne({ _id: projectId, 'members.user': req.user._id });
    if (!project) throw notFound;
    const membership = project.members.find((m) => String(m.user) === String(req.user._id));
    if (!roleAtLeast(membership.role, minRole)) {
      throw new HttpError(403, 'forbidden', `This needs the ${minRole} role or higher in this project`);
    }
    if (write && project.archivedAt) {
      throw new HttpError(409, 'project_archived', 'This project is archived. Unarchive it to make changes.');
    }
    req.project = project;
    req.membership = membership;
    next();
  }, { minRole });
}

// For routes nested under requireProject(): checks the role and archive state on the
// already loaded project instead of loading it again.
export function requireRole(minRole, { write = false } = {}) {
  return Object.assign((req, _res, next) => {
    if (!roleAtLeast(req.membership.role, minRole)) {
      throw new HttpError(403, 'forbidden', `This needs the ${minRole} role or higher in this project`);
    }
    if (write && req.project.archivedAt) {
      throw new HttpError(409, 'project_archived', 'This project is archived. Unarchive it to make changes.');
    }
    next();
  }, { minRole });
}
