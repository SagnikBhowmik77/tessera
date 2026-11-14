import mongoose from 'mongoose';

// Platform (E14).
const { ObjectId } = mongoose.Schema.Types;

// A team or company: a group of people and the projects they share. Project roles stay per
// project; the workspace is where projects are grouped and people are found to add to them.
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'];
const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    members: [new mongoose.Schema({ user: { type: ObjectId, ref: 'User', required: true }, role: { type: String, enum: WORKSPACE_ROLES, required: true } }, { _id: false })],
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);
workspaceSchema.index({ 'members.user': 1 });
export const Workspace = mongoose.models.Workspace || mongoose.model('Workspace', workspaceSchema);

// A browser that agreed to receive push notifications for one person.
const pushSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true, maxlength: 1000 },
    keys: { p256dh: { type: String, required: true, maxlength: 200 }, auth: { type: String, required: true, maxlength: 100 } },
    userAgent: { type: String, maxlength: 300, default: null },
    lastSuccessAt: { type: Date, default: null },
    failures: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
pushSchema.index({ endpoint: 1 }, { unique: true });
pushSchema.index({ user: 1 });
export const PushSubscription = mongoose.models.PushSubscription || mongoose.model('PushSubscription', pushSchema);
