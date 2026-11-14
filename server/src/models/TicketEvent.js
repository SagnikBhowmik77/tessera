import mongoose from 'mongoose';

// Append-only history of every ticket. Flow analytics (cycle time, time in status,
// cumulative flow) and "board time travel" are all computed from these rows, so they
// are never edited or deleted, except when the whole project is deleted.
export const EVENT_TYPES = [
  'created',
  'status_changed',
  'assigned',
  'updated',
  'deleted',
  'restored',
  // Activity only (shown in the ticket's feed, ignored by flow analytics).
  'commented',
  'attachment_added',
  'attachment_removed',
  // The same error was reported again (bug intelligence grouping).
  'error_recurred',
  // A commit or pull request mentioned the ticket (GitHub).
  'linked',
  // A portal report was accepted from the triage inbox onto the board.
  'triaged',
  // A comment was pinned as (or removed from) the ticket's decisions.
  'decision_pinned',
  'decision_unpinned',
  // Planning (E3): epic / parent / blocked-by / sprint / milestone changed (field says which),
  // and blocked spells.
  'relation_changed',
  'blocked',
  'unblocked',
  // A service-level target was missed (field: 'response' or 'resolve'), E4C.
  'sla_breached',
  // A known error was muted (to: until / forever / reason) or unmuted (E5A).
  'error_muted',
  'error_unmuted',
  // Reports spiked (to: lastHour, baseline), E5B.
  'error_spike',
  // Reproduction steps or attempts changed (field: steps | attempt | attempt_removed), E5B.
  'repro_updated',
  // Mapped again with newly uploaded source maps (to: mapped, releases), E6B.
  'error_unminified',
  // Shipped by a production deploy (to: release, environment), E8.
  'deployed',
  // Client-facing (E11): merged with a duplicate report; an outside reporter said fixed / still broken.
  'merged',
  'reporter_answer',
];

const ticketEventSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    // Who did it; null for the system (e.g. a GitHub commit or the public portal, step 10).
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Where a change came from: 'app', 'portal', 'github'.
    source: { type: String, enum: ['app', 'portal', 'github', 'import', 'recurring', 'automation', 'sla', 'sdk', 'reporter', 'merge', 'gitlab'], default: 'app' },
    // The automation rule that made this change ({ id, name }), when source is 'automation'.
    rule: { type: mongoose.Schema.Types.Mixed, default: undefined },
    type: { type: String, enum: EVENT_TYPES, required: true },
    // Which field changed (for 'updated'), e.g. 'priority'.
    field: { type: String, default: null },
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, default: Date.now, required: true },
  },
  { versionKey: false },
);

// A ticket's own history, oldest first.
ticketEventSchema.index({ ticket: 1, at: 1 });
// Project-wide replays for analytics and time travel.
ticketEventSchema.index({ project: 1, at: 1 });

export const TicketEvent = mongoose.models.TicketEvent || mongoose.model('TicketEvent', ticketEventSchema);
