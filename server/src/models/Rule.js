import mongoose from 'mongoose';

// Automation rules (E4C): "when X happens to a ticket, and it matches these conditions, do Y".
// Rules run in order (top to bottom). Changes a rule makes never trigger other rules, so two
// rules can't bounce a ticket back and forth.
export const RULE_TRIGGERS = ['created', 'moved', 'priority_changed', 'assigned', 'label_added', 'sla_breached'];
export const RULE_ACTIONS = ['assign', 'set_priority', 'add_label', 'remove_label', 'move', 'due_in', 'add_watcher'];

const ruleSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    enabled: { type: Boolean, default: true },
    // Lower runs first.
    order: { type: Number, default: 0 },
    // `status` (moved: into this column, or any), `priority` (priority_changed: to this, or any),
    // `label` (label_added), `kind` (sla_breached: response, resolve, or either).
    trigger: {
      type: { type: String, enum: RULE_TRIGGERS, required: true },
      status: { type: String, default: null },
      priority: { type: String, default: null },
      label: { type: String, default: null },
      kind: { type: String, enum: ['response', 'resolve', null], default: null },
    },
    // Every condition that is set must hold; an empty list means "any".
    conditions: {
      types: { type: [String], default: [] },
      priorities: { type: [String], default: [] },
      labels: { type: [String], default: [] },
      // true: only unassigned tickets; false: only assigned ones; null: either.
      unassigned: { type: Boolean, default: null },
    },
    // `value`: a user id (assign / add_watcher; null for assign = unassign), a priority, a label,
    // a status key, or a number of days (due_in).
    actions: {
      type: [new mongoose.Schema({
        type: { type: String, enum: RULE_ACTIONS, required: true },
        value: { type: mongoose.Schema.Types.Mixed, default: null },
      }, { _id: false })],
      validate: { validator: (a) => a.length >= 1 && a.length <= 5, message: 'A rule has 1 to 5 actions' },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // What it has actually done, so a manager can see whether it works.
    runs: { type: Number, default: 0 },
    lastRun: {
      type: new mongoose.Schema({ at: Date, ticketKey: String }, { _id: false }),
      default: null,
    },
    // The last time it could not do something, and why (e.g. a column at its WIP limit).
    lastError: {
      type: new mongoose.Schema({ at: Date, ticketKey: String, message: String }, { _id: false }),
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.project;
        ret.createdBy = ret.createdBy ? String(ret.createdBy) : null;
        return ret;
      },
    },
  },
);

ruleSchema.index({ project: 1, order: 1 });

export const Rule = mongoose.models.Rule || mongoose.model('Rule', ruleSchema);
