import { HttpError } from '../errors.js';
import { Snooze, Ticket, TicketEvent, TicketVisit } from '../models/index.js';
import { notify } from './notification.service.js';

// Following a ticket: "since you last looked" (catch me up), Watch, and snooze-until reminders.

// What counts as a change worth catching up on (not 'created': you can't have seen it before that).
const CATCH_UP_EVENTS = [
  'status_changed', 'assigned', 'updated', 'deleted', 'restored', 'commented',
  'attachment_added', 'attachment_removed', 'error_recurred', 'linked', 'triaged',
  'decision_pinned', 'decision_unpinned', 'error_muted', 'error_unmuted', 'error_spike', 'repro_updated', 'error_unminified', 'deployed',
];
const MAX_CHANGES = 50;

const eventJson = (e) => {
  const json = e.toJSON();
  json.id = String(json._id);
  delete json._id;
  delete json.project;
  delete json.ticket;
  return json;
};

// Opening a ticket: records "seen now" and returns what other people changed since the
// previous visit. The first visit has no previous one, so nothing is reported.
export async function visitTicket(project, user, ticket) {
  const now = new Date();
  const before = await TicketVisit.findOneAndUpdate(
    { user: user._id, ticket: ticket._id },
    { $set: { seenAt: now, project: project._id } },
    { upsert: true, returnDocument: 'before' },
  ).lean();
  const previousVisit = before?.seenAt ?? null;
  let changes = [];
  let more = 0;
  if (previousVisit) {
    const filter = {
      ticket: ticket._id,
      type: { $in: CATCH_UP_EVENTS },
      at: { $gt: previousVisit, $lte: now },
      actor: { $ne: user._id },
    };
    const rows = await TicketEvent.find(filter).sort({ at: 1, _id: 1 }).limit(MAX_CHANGES + 1).populate('actor', 'name email');
    if (rows.length > MAX_CHANGES) {
      more = (await TicketEvent.countDocuments(filter)) - MAX_CHANGES;
      rows.length = MAX_CHANGES;
    }
    changes = rows.map(eventJson);
  }
  const snooze = await Snooze.findOne({ user: user._id, ticket: ticket._id }, { until: 1 }).lean();
  return {
    previousVisit,
    changes,
    more,
    watching: ticket.watchers.some((w) => String(w) === String(user._id)),
    snoozedUntil: snooze?.until ?? null,
  };
}

export async function setWatching(ticket, user, on) {
  await Ticket.updateOne({ _id: ticket._id }, on ? { $addToSet: { watchers: user._id } } : { $pull: { watchers: user._id } });
  return { watching: on };
}

const MAX_SNOOZE_DAYS = 365;

export async function snoozeTicket(project, ticket, user, until) {
  const at = new Date(until);
  const now = Date.now();
  if (at.getTime() <= now + 60_000) throw new HttpError(400, 'snooze_in_past', 'Pick a time at least a minute from now');
  if (at.getTime() > now + MAX_SNOOZE_DAYS * 864e5) throw new HttpError(400, 'snooze_too_far', 'Snooze for at most a year');
  await Snooze.updateOne(
    { user: user._id, ticket: ticket._id },
    { $set: { until: at, project: project._id } },
    { upsert: true },
  );
  return { snoozedUntil: at };
}

export async function unsnoozeTicket(ticket, user) {
  await Snooze.deleteOne({ user: user._id, ticket: ticket._id });
  return { snoozedUntil: null };
}

// Ticket ids the user has snoozed right now (My work hides them).
export async function snoozedTicketIds(userId, now = new Date()) {
  const rows = await Snooze.find({ user: userId, until: { $gt: now } }, { ticket: 1, until: 1 }).lean();
  return new Map(rows.map((r) => [String(r.ticket), r.until]));
}

// Turns every snooze that has come due into a "reminder" notification, then removes it.
// Runs on a timer and also before an inbox is read, so a server that was asleep (free hosting)
// still delivers reminders the moment someone looks. Each snooze is claimed with a delete,
// so two sweeps at once never remind twice.
export async function deliverDueReminders({ userId = null, now = new Date() } = {}) {
  const due = await Snooze.find({ until: { $lte: now }, ...(userId && { user: userId }) }).sort({ until: 1 }).limit(200).lean();
  let delivered = 0;
  for (const s of due) {
    const claimed = await Snooze.findOneAndDelete({ _id: s._id, until: s.until });
    if (!claimed) continue;
    const ticket = await Ticket.findOne({ _id: s.ticket, deletedAt: null }).populate('project', 'key members archivedAt');
    // A ticket that was deleted, or a project the person has left, needs no reminder.
    const stillMember = ticket?.project?.members?.some((m) => String(m.user) === String(s.user));
    if (!ticket || !stillMember) continue;
    await notify([{
      user: s.user,
      project: ticket.project._id,
      ticket: ticket._id,
      type: 'reminder',
      actor: null,
      ticketKey: `${ticket.project.key}-${ticket.number}`,
      ticketTitle: ticket.title,
      excerpt: 'You snoozed this ticket. It is back on your list.',
    }]);
    delivered += 1;
  }
  return delivered;
}

let timer = null;
export function startReminderSweep(everyMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => {
    deliverDueReminders().catch((err) => console.error(`Reminder sweep failed: ${err.message}`));
  }, everyMs);
  timer.unref();
}

// Someone left these projects (or deleted their account): forget what they followed there.
export async function forgetMember(projectIds, userId) {
  await Ticket.updateMany({ project: { $in: projectIds }, watchers: userId }, { $pull: { watchers: userId } });
  await Snooze.deleteMany({ project: { $in: projectIds }, user: userId });
  await TicketVisit.deleteMany({ project: { $in: projectIds }, user: userId });
}
