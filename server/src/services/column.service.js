import { HttpError } from '../errors.js';
import { Ticket } from '../models/index.js';

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'column';

// Replaces the board's columns: rename, reorder, add, remove, and set WIP limits.
// Existing columns keep their key (tickets point at it), so renaming never moves cards.
// A column can only be removed once it's empty (including tickets in the bin).
export async function setStatuses(project, input) {
  const current = new Map(project.statuses.map((s) => [s.key, s]));
  const explicit = input.map((s) => s.key).filter(Boolean);
  if (new Set(explicit).size !== explicit.length) throw new HttpError(400, 'duplicate_column', 'Each column can appear only once');
  for (const key of explicit) {
    if (!current.has(key)) throw new HttpError(400, 'unknown_status', `This project has no column "${key}"`);
  }

  const taken = new Set([...current.keys()]);
  const next = input.map((s) => {
    let key = s.key;
    if (!key) {
      const base = slug(s.name);
      key = base;
      for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
      taken.add(key);
    }
    return { key, name: s.name, category: s.category, wipLimit: s.wipLimit ?? null };
  });

  const removed = [...current.keys()].filter((k) => !next.some((s) => s.key === k));
  if (removed.length) {
    const counts = await Ticket.aggregate([
      { $match: { project: project._id, status: { $in: removed } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    if (counts.length) {
      throw new HttpError(409, 'column_not_empty', 'Move the tickets out of a column before removing it',
        counts.map((c) => ({ key: c._id, name: current.get(c._id).name, count: c.count })));
    }
  }

  project.statuses = next;
  try {
    await project.save();
  } catch (err) {
    if (err.name === 'ValidationError') {
      throw new HttpError(400, 'invalid_columns', Object.values(err.errors)[0]?.message ?? 'These columns are not valid');
    }
    throw err;
  }
  return project;
}
