import mongoose from 'mongoose';

// A ticket template (E4B): ready-made title, description, type, priority, labels and points,
// plus sub-tasks that are created with every ticket made from it ("New hire setup" -> 6 steps).
const templateSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 20_000, default: '' },
    type: { type: String, default: 'task' },
    priority: { type: String, default: 'medium' },
    labels: { type: [String], default: [] },
    storyPoints: { type: Number, min: 0, max: 100, default: null },
    subtasks: { type: [{ type: String, trim: true, maxlength: 200 }], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);
templateSchema.index({ project: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

// A recurring ticket: a template made into a ticket on a schedule (every N days, every N weeks
// from a first day, or every N months on a day). `nextRun` is the next calendar day (India) due.
const recurrenceSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', required: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    schedule: {
      every: { type: String, enum: ['day', 'week', 'month'], required: true },
      interval: { type: Number, min: 1, max: 12, default: 1 },
      // The first run (YYYY-MM-DD); later runs count from it (same weekday, same day of month).
      anchor: { type: String, required: true },
    },
    // Due date of each new ticket, this many days after the day it is for (null = none).
    dueInDays: { type: Number, min: 0, max: 90, default: null },
    nextRun: { type: String, required: true },
    active: { type: Boolean, default: true },
    // Set when the schedule had to stop itself (e.g. the person who set it up left the project).
    pausedReason: { type: String, default: null },
    lastRun: {
      type: new mongoose.Schema({
        day: String,
        at: Date,
        number: Number,
        // Runs that fell due while the server was asleep and were folded into this one.
        missed: { type: Number, default: 0 },
      }, { _id: false }),
      default: null,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);
recurrenceSchema.index({ active: 1, nextRun: 1 });
recurrenceSchema.index({ project: 1 });

export const Template = mongoose.models.Template || mongoose.model('Template', templateSchema);
export const Recurrence = mongoose.models.Recurrence || mongoose.model('Recurrence', recurrenceSchema);
