import mongoose from 'mongoose';

// An epic groups other tickets (it is a ticket too, with its own place on the board).
export const TICKET_TYPES = ['bug', 'feature', 'task', 'epic'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

// A parsed error (bug intelligence, step 8). `type` fields are written as { type: String }
// because a bare `type:` key would be read by Mongoose as the path's own type.
const frameSchema = new mongoose.Schema(
  {
    fn: String, file: String, line: Number, column: Number, inApp: Boolean,
    // Unminified with a source map (E6B): the frame as it was sent, and the original code around it.
    minified: { type: new mongoose.Schema({ fn: String, file: String, line: Number, column: Number }, { _id: false }), default: undefined },
    context: { type: new mongoose.Schema({ pre: [String], line: String, post: [String] }, { _id: false }), default: undefined },
  },
  { _id: false },
);
const errorSchema = new mongoose.Schema(
  {
    language: { type: String },
    type: { type: String },
    message: { type: String },
    frames: [frameSchema],
    causes: [new mongoose.Schema({ type: { type: String }, message: { type: String } }, { _id: false })],
    // Same error from the same place in your code -> same fingerprint (see bugs/stacktrace.js).
    fingerprint: { type: String, required: true },
    environment: { type: new mongoose.Schema({ browser: String, os: String }, { _id: false }), default: null },
    occurrences: { type: Number, default: 1, min: 1 },
    firstSeenAt: { type: Date },
    lastSeenAt: { type: Date },
    // How many frames source maps turned back into original code, and from which releases (E6B).
    unminified: { type: new mongoose.Schema({ mapped: Number, of: Number, releases: [String] }, { _id: false }), default: null },
    // When a spike in reports was last alerted (E5B), so one spike alerts once.
    spikeAlertedAt: { type: Date, default: null },
    // Suspect commit and who knows the file (E7), looked up on request.
    suspect: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Muted (E5A): reports are still counted, but don't reopen, notify or run rules until `until`.
    muted: {
      type: new mongoose.Schema({
        at: Date,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        until: { type: Date, default: null },
        forever: { type: Boolean, default: false },
        reason: { type: String, maxlength: 200, default: null },
      }, { _id: false }),
      default: null,
    },
  },
  { _id: false },
);

const ticketSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    // Per-project sequence: with project key TES this ticket is TES-<number>.
    number: { type: Number, required: true, min: 1 },
    type: { type: String, enum: TICKET_TYPES, default: 'task' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    // Markdown.
    description: { type: String, maxlength: 20_000, default: '' },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    // A status key from the project's statuses (checked by the ticket service, step 4).
    status: { type: String, required: true, match: /^[a-z0-9_]{1,32}$/ },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    labels: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],
      validate: { validator: (l) => l.length <= 20, message: 'At most 20 labels' },
    },
    // When work is planned to start (timeline view); on or before the due date.
    startDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    storyPoints: { type: Number, min: 0, max: 100, default: null },
    // Planning (E3): the epic this ticket belongs to, or the ticket it is a sub-task of
    // (one level deep). Same project only; the relations service enforces the rules.
    epic: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    // The sprint it is planned into (none = backlog) and the milestone it counts towards (E3B).
    sprint: { type: mongoose.Schema.Types.ObjectId, ref: 'Sprint', default: null },
    milestone: { type: mongoose.Schema.Types.ObjectId, ref: 'Milestone', default: null },
    // Tickets that must be finished before this one can move (no cycles).
    blockedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }], default: [] },
    // Flagged as blocked by hand, with a reason ("waiting for the payment provider").
    flag: {
      type: new mongoose.Schema({
        reason: { type: String, trim: true, maxlength: 200 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: Date,
      }, { _id: false }),
      default: null,
    },
    // Set while the ticket is blocked (flagged, or waiting on an open blocker); kept by the
    // service together with 'blocked' / 'unblocked' history events for blocked-time analytics.
    blockedSince: { type: Date, default: null },
    blockedReason: { type: String, maxlength: 300, default: null },
    // Order inside a Kanban column. A sortable string (fractional index), so moving one card
    // writes one ticket instead of renumbering the whole column.
    rank: { type: String, required: true },
    // Set when the ticket enters a "done" status, cleared if it is reopened.
    resolvedAt: { type: Date, default: null },
    // Service levels (E4C): when a teammate first responded (a comment by someone other than the
    // reporter, or the ticket leaving a to-do column), and when a missed target was alerted.
    respondedAt: { type: Date, default: null },
    slaAlerted: {
      type: new mongoose.Schema({ response: { type: Date, default: null }, resolve: { type: Date, default: null } }, { _id: false }),
      default: () => ({ response: null, resolve: null }),
    },
    // Set when the ticket is moved to the bin; it can be restored until then.
    deletedAt: { type: Date, default: null },
    // Filled when the ticket was made from a pasted error or stack trace.
    error: { type: errorSchema, default: null },
    // Where it came from: the app, the public bug portal, or GitHub.
    source: { type: String, enum: ['app', 'portal', 'github', 'import', 'recurring', 'sdk'], default: 'app' },
    // Custom field values (E4B), by field key: text, number, option, YYYY-MM-DD, true/false or a link.
    fields: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Portal reports wait in the triage inbox (off the board) until a teammate accepts them.
    triage: { type: Boolean, default: false },
    // An outside reporter (portal), who is emailed when the ticket is fixed.
    contact: {
      type: new mongoose.Schema({ name: { type: String, maxlength: 80 }, email: { type: String, maxlength: 254 } }, { _id: false }),
      default: null,
    },
    // More outside people who reported the same error through the portal (E5A). They get the
    // "fixed" email too. Kept to 25 so a busy crash can't grow the ticket without limit.
    // Reproduction tracking (E5B): steps, and each teammate's attempt and its result.
    repro: {
      type: new mongoose.Schema({
        steps: { type: String, maxlength: 5000, default: '' },
        attempts: [new mongoose.Schema({
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          at: { type: Date, required: true },
          result: { type: String, enum: ['reproduced', 'not_reproduced'], required: true },
          environment: { type: String, maxlength: 100, default: null },
          note: { type: String, maxlength: 500, default: null },
        })],
      }, { _id: false }),
      default: null,
    },
    // Deployments (E8): when a commit or merged pull request finished it, the production deploy that
    // shipped it, and a reporter "fixed" email held until then.
    mergedAt: { type: Date, default: null },
    shipped: { type: new mongoose.Schema({ deployment: mongoose.Schema.Types.ObjectId, release: String, environment: String, at: Date }, { _id: false }), default: null },
    fixEmailPending: { type: Boolean, default: false },
    // The GitHub issue this ticket is kept in sync with (E7).
    githubIssue: { type: new mongoose.Schema({ number: Number, url: String, state: String }, { _id: false }), default: null },
    otherReporters: { type: [new mongoose.Schema({ name: { type: String, maxlength: 80 }, email: { type: String, maxlength: 254 } }, { _id: false })], default: [] },
    // Client-facing (E11): shown on the public roadmap; merged into another report of the same problem.
    roadmap: { type: Boolean, default: false },
    duplicateOf: { type: new mongoose.Schema({ ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }, number: Number }, { _id: false }), default: null },
    // The CI test this ticket is about (E12, flaky or failing tests), as suite::name.
    testKey: { type: String, maxlength: 500, default: null },
    // People who asked to hear about every change (Watch button); reporter and assignee hear anyway.
    watchers: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    // Commits and pull requests that mention this ticket (GitHub webhook).
    links: {
      type: [new mongoose.Schema({
        kind: { type: String, enum: ['commit', 'pull_request', 'merge_request'], required: true },
        url: { type: String, required: true, maxlength: 500 },
        title: { type: String, maxlength: 300 },
        ref: { type: String, maxlength: 60 },
        author: { type: String, maxlength: 100 },
        at: { type: Date, default: Date.now },
        // Pull request status from GitHub (E7): state, draft, review, CI, conflicts, files changed.
        pr: { type: mongoose.Schema.Types.Mixed, default: undefined },
      }, { _id: false })],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        ret.project = String(ret.project);
        ret.dueDate = ret.dueDate ? ret.dueDate.toISOString().slice(0, 10) : null;
        ret.startDate = ret.startDate ? ret.startDate.toISOString().slice(0, 10) : null;
        ret.watchers = (ret.watchers ?? []).map(String);
        ret.epic = ret.epic ? String(ret.epic) : null;
        ret.parent = ret.parent ? String(ret.parent) : null;
        ret.sprint = ret.sprint ? String(ret.sprint) : null;
        ret.milestone = ret.milestone ? String(ret.milestone) : null;
        ret.fields = ret.fields ?? {};
        delete ret.slaAlerted;
        ret.otherReporters = (ret.otherReporters ?? []).length;
        ret.blockedBy = (ret.blockedBy ?? []).map(String);
        if (ret.flag?.by) ret.flag.by = String(ret.flag.by);
        return ret;
      },
    },
  },
);

ticketSchema.index({ project: 1, number: 1 }, { unique: true });
// The board: one column, in card order.
ticketSchema.index({ project: 1, status: 1, rank: 1 });
// Grouping repeat errors: "has this crash been reported in this project before?"
ticketSchema.index(
  { project: 1, 'error.fingerprint': 1 },
  { partialFilterExpression: { 'error.fingerprint': { $exists: true } } },
);
// Sub-tasks of a ticket, tickets in an epic, and "what does this block".
ticketSchema.index({ parent: 1 }, { partialFilterExpression: { parent: { $type: 'objectId' } } });
ticketSchema.index({ epic: 1 }, { partialFilterExpression: { epic: { $type: 'objectId' } } });
ticketSchema.index({ blockedBy: 1 });
// A sprint's or milestone's tickets.
ticketSchema.index({ sprint: 1 }, { partialFilterExpression: { sprint: { $type: 'objectId' } } });
ticketSchema.index({ milestone: 1 }, { partialFilterExpression: { milestone: { $type: 'objectId' } } });
// "Assigned to me" and the workload heatmap.
ticketSchema.index({ assignee: 1, status: 1 });
// Keyword search (step 6). Title matches count more than description matches.
ticketSchema.index(
  { title: 'text', description: 'text', labels: 'text' },
  { weights: { title: 10, labels: 5, description: 1 }, name: 'ticket_text' },
);

export const Ticket = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);
