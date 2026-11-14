import mongoose from 'mongoose';

// Notifications and integrations (E13).
const { ObjectId } = mongoose.Schema.Types;

// A personal API token (tsp_...) for scripts and the CLI. Only a SHA-256 hash is stored; the
// token is shown once. 'read' tokens can only make GET requests.
const apiTokenSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 80 },
    hash: { type: String, required: true },
    prefix: { type: String, required: true },
    scope: { type: String, enum: ['read', 'write'], default: 'read' },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
apiTokenSchema.index({ hash: 1 }, { unique: true });
apiTokenSchema.index({ user: 1, createdAt: -1 });
export const ApiToken = mongoose.models.ApiToken || mongoose.model('ApiToken', apiTokenSchema);

// One delivery to Slack, Discord or an outgoing webhook, kept so the team can see what was sent
// and why something failed. Only the last 50 per target are kept.
const deliverySchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    target: { kind: { type: String, enum: ['slack', 'discord', 'webhook'] }, id: ObjectId, name: String },
    event: { type: String, required: true },
    ok: { type: Boolean, required: true },
    status: { type: Number, default: null },
    error: { type: String, maxlength: 300, default: null },
    duration: { type: Number, default: null },
    attempts: { type: Number, default: 1 },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
deliverySchema.index({ project: 1, 'target.id': 1, at: -1 });
export const WebhookDelivery = mongoose.models.WebhookDelivery || mongoose.model('WebhookDelivery', deliverySchema);
