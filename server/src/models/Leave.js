import mongoose from 'mongoose';

// Time off: a person is away from `from` to `to` (calendar days, inclusive). It belongs to the
// person, not a project, and every project they are in sees it on its calendar and assignee picker.
const leaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    // Optional, shown to teammates ("Diwali", "Conference").
    note: { type: String, trim: true, maxlength: 100, default: '' },
  },
  { timestamps: true, versionKey: false },
);

// "Who is away in this range": by person, then by end day.
leaveSchema.index({ user: 1, to: 1 });

export const Leave = mongoose.models.Leave || mongoose.model('Leave', leaveSchema);
