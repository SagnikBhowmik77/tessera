import { Ticket, TicketEvent } from '../models/index.js';

// Whether a ticket is blocked, kept in one place. A ticket is blocked while it is flagged by hand
// or waits on a blocker that is still open; a finished or binned ticket is never blocked.
// Every change is written to the history ('blocked' with the reason, 'unblocked'), so blocked time
// can be measured later exactly as it happened. A new reason during a spell starts a new 'blocked'
// event, so time is attributed to the right reason.

const doneKeys = (project) => new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));

export async function refreshBlocked(project, ticketIds, actor = null, at = new Date()) {
  if (!ticketIds.length) return;
  const done = doneKeys(project);
  const tickets = await Ticket.find({ _id: { $in: ticketIds }, project: project._id });
  const blockerIds = [...new Set(tickets.flatMap((t) => t.blockedBy.map(String)))];
  const blockers = new Map((await Ticket.find({ _id: { $in: blockerIds } }, { number: 1, status: 1, deletedAt: 1 }).lean())
    .map((b) => [String(b._id), b]));
  const events = [];
  for (const t of tickets) {
    const open = t.blockedBy.map((id) => blockers.get(String(id))).filter((b) => b && !b.deletedAt && !done.has(b.status));
    const flagged = Boolean(t.flag?.reason);
    const finished = Boolean(t.deletedAt) || done.has(t.status);
    const blocked = !finished && (flagged || open.length > 0);
    const kind = flagged ? 'flag' : 'dependency';
    const reason = flagged ? t.flag.reason : `Waiting on ${open.map((b) => `${project.key}-${b.number}`).join(', ')}`;
    if (blocked && (!t.blockedSince || t.blockedReason !== reason)) {
      await Ticket.updateOne({ _id: t._id }, { $set: { blockedSince: t.blockedSince ?? at, blockedReason: reason } });
      events.push({ project: project._id, ticket: t._id, actor, type: 'blocked', to: { reason, kind }, at });
    } else if (!blocked && t.blockedSince) {
      await Ticket.updateOne({ _id: t._id }, { $set: { blockedSince: null, blockedReason: null } });
      events.push({ project: project._id, ticket: t._id, actor, type: 'unblocked', from: { reason: t.blockedReason }, at });
    }
  }
  if (events.length) await TicketEvent.insertMany(events);
}

// A ticket changed column, was binned or restored: its own state and that of every ticket it
// blocks may have changed.
export async function afterStatusChange(project, ticket, actor = null, at = new Date()) {
  const dependents = await Ticket.find({ project: project._id, blockedBy: ticket._id }, { _id: 1 }).lean();
  await refreshBlocked(project, [ticket._id, ...dependents.map((d) => d._id)], actor, at);
  // The caller is about to send this ticket back: give it the state just written.
  const fresh = await Ticket.findById(ticket._id, { blockedSince: 1, blockedReason: 1 }).lean();
  ticket.blockedSince = fresh?.blockedSince ?? null;
  ticket.blockedReason = fresh?.blockedReason ?? null;
}
