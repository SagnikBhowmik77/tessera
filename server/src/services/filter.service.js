import { HttpError } from '../errors.js';
import { SavedFilter } from '../models/index.js';
import { roleAtLeast } from './project.service.js';

const nameTaken = () => new HttpError(409, 'name_taken', 'You already have a saved filter with this name');

// Mine plus the ones teammates shared, mine first.
export async function listFilters(project, user) {
  const rows = await SavedFilter.find({ project: project._id, $or: [{ owner: user._id }, { shared: true }] })
    .sort({ name: 1 })
    .populate('owner', 'name email');
  const json = rows.map((r) => ({ ...r.toJSON(), mine: String(r.owner?._id) === String(user._id) }));
  return [...json.filter((f) => f.mine), ...json.filter((f) => !f.mine)];
}

export async function createFilter(project, user, { name, query, shared }) {
  try {
    const row = await SavedFilter.create({ project: project._id, owner: user._id, name, query, shared });
    await row.populate('owner', 'name email');
    return { ...row.toJSON(), mine: true };
  } catch (err) {
    if (err.code === 11000) throw nameTaken();
    throw err;
  }
}

async function findFilter(project, user, filterId) {
  const row = await SavedFilter.findOne({ _id: filterId, project: project._id, $or: [{ owner: user._id }, { shared: true }] });
  if (!row) throw new HttpError(404, 'filter_not_found', 'Saved filter not found');
  return row;
}

// Only the owner changes a filter.
export async function updateFilter(project, user, filterId, changes) {
  const row = await findFilter(project, user, filterId);
  if (String(row.owner) !== String(user._id)) throw new HttpError(403, 'forbidden', 'Only the person who saved this filter can change it');
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) row[k] = v;
  row.markModified('query');
  try {
    await row.save();
  } catch (err) {
    if (err.code === 11000) throw nameTaken();
    throw err;
  }
  await row.populate('owner', 'name email');
  return { ...row.toJSON(), mine: true };
}

// The owner deletes; managers can also remove shared filters from the project.
export async function deleteFilter(project, membership, user, filterId) {
  const row = await findFilter(project, user, filterId);
  const mine = String(row.owner) === String(user._id);
  if (!mine && !roleAtLeast(membership.role, 'manager')) {
    throw new HttpError(403, 'forbidden', 'You can delete your own filters. Managers can remove shared ones.');
  }
  await row.deleteOne();
}
