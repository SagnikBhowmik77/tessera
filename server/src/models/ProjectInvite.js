import mongoose from 'mongoose';
import { ROLES } from './Project.js';

// An email invitation to join a project. Only a SHA-256 hash of the link's token is stored,
// so a database leak doesn't hand out working invite links.
const projectInviteSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    declinedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.tokenHash;
        return ret;
      },
    },
  },
);

projectInviteSchema.index({ tokenHash: 1 }, { unique: true });
projectInviteSchema.index({ project: 1, email: 1 });
// Old invites clean themselves up 30 days after they expire.
projectInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const ProjectInvite = mongoose.models.ProjectInvite || mongoose.model('ProjectInvite', projectInviteSchema);
