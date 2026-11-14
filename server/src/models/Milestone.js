import mongoose from 'mongoose';

// A milestone: a dated target ("Public beta, 15 Dec") that tickets from any sprint or epic
// count towards. Progress is worked out from its tickets; closing one just files it away.
const milestoneSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    // A calendar day (UTC midnight), or none.
    dueDate: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

milestoneSchema.index({ project: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export const Milestone = mongoose.models.Milestone || mongoose.model('Milestone', milestoneSchema);
