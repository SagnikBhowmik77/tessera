import mongoose from 'mongoose';

// A deploy of the team's app (E8), reported by GitHub (deployment status events), by a deploy
// hook the team's CI calls, or recorded by hand. Successful production deploys turn "merged"
// tickets into "live" ones and drive the DORA numbers.
const deploymentSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    environment: { type: String, required: true, maxlength: 60 },
    release: { type: String, default: null, maxlength: 100 },
    sha: { type: String, default: null, maxlength: 64 },
    ref: { type: String, default: null, maxlength: 200 },
    status: { type: String, enum: ['success', 'failure'], required: true },
    source: { type: String, enum: ['github', 'hook', 'manual'], required: true },
    url: { type: String, default: null, maxlength: 500 },
    // GitHub's deployment status id, so a delivery sent twice is recorded once.
    externalId: { type: String, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    shipped: { type: Number, default: 0 },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);
deploymentSchema.index({ project: 1, at: -1 });
deploymentSchema.index({ project: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } });

export const Deployment = mongoose.models.Deployment || mongoose.model('Deployment', deploymentSchema);
