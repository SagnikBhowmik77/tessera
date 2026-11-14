import mongoose from 'mongoose';

// A sprint: a fixed stretch of days with a goal. Planned -> active (one at a time per project)
// -> closed. What was in it when it started and how it ended are stored, so the retro report
// can say what was committed, what was added later and what slipped, exactly as it happened.
export const SPRINT_STATES = ['planned', 'active', 'closed'];

const ids = { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' }], default: [] };

const sprintSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    goal: { type: String, trim: true, maxlength: 300, default: '' },
    // Calendar days (UTC midnight), inclusive. Needed before the sprint can start.
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    state: { type: String, enum: SPRINT_STATES, default: 'planned' },
    startedAt: { type: Date, default: null },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Tickets in the sprint at the moment it started (the commitment).
    committed: ids,
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // At close: what was finished, what wasn't, and where the unfinished work went.
    completed: ids,
    unfinished: ids,
    carriedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Sprint', default: null },
  },
  { timestamps: true, versionKey: false },
);

sprintSchema.index({ project: 1, state: 1, startDate: 1 });
// At most one active sprint per project.
sprintSchema.index({ project: 1 }, { unique: true, partialFilterExpression: { state: 'active' }, name: 'one_active_sprint' });

export const Sprint = mongoose.models.Sprint || mongoose.model('Sprint', sprintSchema);
