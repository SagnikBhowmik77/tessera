import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { addDays, dayToDate, todayIn } from '../dates.js';
import { Leave } from '../models/index.js';

// Leave (time off). People add and remove their own; project members see each other's.

const MAX_DAYS = 365;
const MAX_UPCOMING = 50;
const dayOf = (d) => d.toISOString().slice(0, 10);

const shape = (l, user) => ({
  id: String(l._id),
  from: dayOf(l.from),
  to: dayOf(l.to),
  note: l.note,
  days: Math.round((l.to - l.from) / 86400e3) + 1,
  ...(user && { user }),
});

// My leave: anything not yet over, plus the last 90 days.
export async function myLeave(user) {
  const since = dayToDate(addDays(todayIn(config.timeZone), -90));
  const rows = await Leave.find({ user: user._id, to: { $gte: since } }).sort({ from: 1 }).lean();
  return rows.map((l) => shape(l));
}

export async function addLeave(user, { from, to, note = '' }) {
  if (to < from) throw new HttpError(400, 'leave_dates', 'The last day must be on or after the first');
  if (Math.round((to - from) / 86400e3) + 1 > MAX_DAYS) throw new HttpError(400, 'leave_too_long', `Leave is at most ${MAX_DAYS} days at a time`);
  const today = todayIn(config.timeZone);
  if (to < dayToDate(addDays(today, -90))) throw new HttpError(400, 'leave_too_old', 'Leave can go back at most 90 days');
  const clash = await Leave.findOne({ user: user._id, from: { $lte: to }, to: { $gte: from } }).lean();
  if (clash) throw new HttpError(409, 'leave_overlap', `You already have leave from ${dayOf(clash.from)} to ${dayOf(clash.to)}`);
  if (await Leave.countDocuments({ user: user._id, to: { $gte: dayToDate(today) } }) >= MAX_UPCOMING) {
    throw new HttpError(400, 'too_much_leave', `At most ${MAX_UPCOMING} upcoming leave entries`);
  }
  return shape(await Leave.create({ user: user._id, from, to, note }));
}

export async function removeLeave(user, id) {
  const { deletedCount } = await Leave.deleteOne({ _id: id, user: user._id });
  if (!deletedCount) throw new HttpError(404, 'leave_not_found', 'Leave not found');
}

// Everyone in the project who is away at some point between two days (inclusive).
export async function projectLeave(project, { from, to }) {
  if (to < from) throw new HttpError(400, 'leave_dates', '`to` must be on or after `from`');
  if ((to - from) / 86400e3 > 400) throw new HttpError(400, 'range_too_long', 'Ask for at most 400 days at a time');
  const memberIds = project.members.map((m) => m.user._id ?? m.user);
  const rows = await Leave.find({ user: { $in: memberIds }, from: { $lte: to }, to: { $gte: from } })
    .sort({ from: 1 }).populate('user', 'name').lean();
  return rows.filter((l) => l.user).map((l) => shape(l, { id: String(l.user._id), name: l.user.name }));
}
