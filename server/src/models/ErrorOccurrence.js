import mongoose from 'mongoose';

// One row per time a crash was reported (E5A). The ticket keeps the running count; these rows
// are the history behind it: when, from which browser/OS, by whom, and whether that report
// reopened a finished ticket or arrived while the error was muted. Impact scores, the
// regression timeline and affected environments are all computed from them.
const errorOccurrenceSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    at: { type: Date, required: true },
    source: { type: String, enum: ['app', 'portal', 'sdk'], default: 'app' },
    // Sent by apps through the SDK (E6A): their release and environment, and the page (no query string).
    release: { type: String, default: null },
    appEnvironment: { type: String, default: null },
    page: { type: String, default: null },
    // Who reported it, to count distinct people: "user:<id>", or "email:<sha256>" for an
    // outside reporter (the address itself is not copied here). Null when unknown.
    who: { type: String, default: null },
    environment: { type: new mongoose.Schema({ browser: String, os: String }, { _id: false }), default: null },
    regression: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
  },
  { versionKey: false },
);

errorOccurrenceSchema.index({ ticket: 1, at: -1 });
errorOccurrenceSchema.index({ project: 1, at: -1 });
// Kept for a year, like the audit log.
errorOccurrenceSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

export const ErrorOccurrence = mongoose.models.ErrorOccurrence || mongoose.model('ErrorOccurrence', errorOccurrenceSchema);
