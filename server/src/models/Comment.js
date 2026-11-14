import mongoose from 'mongoose';

// A comment on a ticket. Threads are one level deep, like GitHub and Linear: a reply to a
// reply joins the same thread. Deleted comments keep their place so replies still make sense.
const commentSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // The thread's first comment; null for a top-level comment.
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    // Markdown. Mentions are written as @[Name](userId).
    body: { type: String, maxlength: 10_000, default: '' },
    // Project members mentioned in the body (notified in step 7).
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // A handoff note is written when a ticket is reassigned (shown with its own badge).
    kind: { type: String, enum: ['comment', 'handoff'], default: 'comment' },
    // A comment written somewhere else and brought in (E7: on the linked GitHub issue).
    external: { type: new mongoose.Schema({ source: String, login: String, url: String }, { _id: false }), default: null },
    // Team-only by default. 'reporter': also emailed to the outside reporter of a portal ticket.
    visibility: { type: String, enum: ['internal', 'reporter'], default: 'internal' },
    // The outside reporter's conversation this belongs to (E11), and whether they wrote it.
    tracker: { type: mongoose.Schema.Types.ObjectId, ref: 'Tracker', default: null },
    fromReporter: { type: Boolean, default: false },
    sentTo: { type: String, maxlength: 254, default: null },
    sentAt: { type: Date, default: null },
    // Pinned as a decision: listed at the top of the ticket so nobody rereads the thread.
    pinnedAt: { type: Date, default: null },
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.project;
        ret.ticket = String(ret.ticket);
        ret.parent = ret.parent ? String(ret.parent) : null;
        ret.mentions = (ret.mentions || []).map(String);
        if (ret.pinnedBy && !ret.pinnedBy.name) ret.pinnedBy = String(ret.pinnedBy);
        if (ret.deletedAt) {
          ret.body = null;
          ret.mentions = [];
        }
        return ret;
      },
    },
  },
);

commentSchema.index({ ticket: 1, createdAt: 1 });
commentSchema.index({ project: 1 });

export const Comment = mongoose.models.Comment || mongoose.model('Comment', commentSchema);
