import mongoose from 'mongoose';

// One-time links sent by email: "reset your password" and "verify your email".
// Only a SHA-256 hash of the link's token is stored, so a database leak can't be used to
// reset anyone's password. Each link works once and expires on its own.
const emailTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: ['reset', 'verify'], required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);

emailTokenSchema.index({ tokenHash: 1 }, { unique: true });
emailTokenSchema.index({ user: 1, purpose: 1 });
// Used or expired links are cleaned up a day after they expire.
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const EmailToken = mongoose.models.EmailToken || mongoose.model('EmailToken', emailTokenSchema);
