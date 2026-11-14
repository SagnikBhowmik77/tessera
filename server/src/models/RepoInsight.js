import mongoose from 'mongoose';

// Results of on-demand repository analysis (E7): "knowledge" (who knows which part of the code)
// and "todos" (TODO/FIXME comments). One of each per project, replaced by the next run.
const repoInsightSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    kind: { type: String, enum: ['knowledge', 'todos'], required: true },
    repo: { type: String, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
repoInsightSchema.index({ project: 1, kind: 1 }, { unique: true });

export const RepoInsight = mongoose.models.RepoInsight || mongoose.model('RepoInsight', repoInsightSchema);
