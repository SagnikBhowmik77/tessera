import mongoose from 'mongoose';

export const NOTIFICATION_TYPES = [
  'mention', // someone @mentioned you in a comment
  'assigned', // someone assigned a ticket to you
  'comment', // a new comment on a ticket you reported or are assigned to
  'resolved', // a ticket you reported was moved to done by someone else
  'regression', // a finished bug came back: the same error was reported again
  'portal_report', // someone outside the team filed a report through the public portal
  'status_changed', // a ticket you watch moved to another column
  'reminder', // a ticket you snoozed is back
  'sla_breached', // a ticket you own (or, unassigned, in a project you manage) missed a service-level target
  'crash_new', // an app sent a crash never seen before (in a project you manage)
  'reporter_message', // an outside reporter wrote on their tracking page
  'reporter_answer', // an outside reporter says the fix did not work
  'crash_spike', // reports of an error you own (or, unassigned, in a project you manage) suddenly jumped
];

// The ticket's key and title are copied in, so the inbox still reads well
// if the ticket is later renamed or deleted.
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // Arrived during the person's quiet hours: emailed in one summary when they end (E13).
    emailHeld: { type: Boolean, default: false },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ticketKey: { type: String, default: null },
    ticketTitle: { type: String, default: null },
    excerpt: { type: String, maxlength: 200, default: null },
    comment: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  {
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.user;
        ret.project = String(ret.project);
        ret.ticket = ret.ticket ? String(ret.ticket) : null;
        ret.comment = ret.comment ? String(ret.comment) : null;
        return ret;
      },
    },
  },
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, readAt: 1 });
// The inbox keeps 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
