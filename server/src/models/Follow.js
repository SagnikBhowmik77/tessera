import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

// When each person last opened each ticket, for "since you last looked" (catch me up).
const ticketVisitSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    ticket: { type: ObjectId, ref: 'Ticket', required: true },
    project: { type: ObjectId, ref: 'Project', required: true },
    seenAt: { type: Date, required: true },
  },
  { versionKey: false },
);
ticketVisitSchema.index({ user: 1, ticket: 1 }, { unique: true });
ticketVisitSchema.index({ project: 1 });
// A ticket nobody has opened for a year doesn't need its "last seen" kept.
ticketVisitSchema.index({ seenAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

// "Remind me later": the ticket leaves My work until `until`, then comes back with a reminder.
const snoozeSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    ticket: { type: ObjectId, ref: 'Ticket', required: true },
    project: { type: ObjectId, ref: 'Project', required: true },
    until: { type: Date, required: true },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
snoozeSchema.index({ user: 1, ticket: 1 }, { unique: true });
// The reminder sweep: everything due, oldest first.
snoozeSchema.index({ until: 1 });
snoozeSchema.index({ project: 1 });

export const TicketVisit = mongoose.models.TicketVisit || mongoose.model('TicketVisit', ticketVisitSchema);
export const Snooze = mongoose.models.Snooze || mongoose.model('Snooze', snoozeSchema);
