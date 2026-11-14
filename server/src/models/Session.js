import mongoose from 'mongoose';

// One row per signed-in device. The login token carries the session's id (jti); a token
// only works while its session exists and isn't revoked, so any device can be signed out
// on its own from the Account page. Rows delete themselves when the token would expire anyway.
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    jti: { type: String, required: true },
    // What the person sees in "Active sessions": parsed from the browser's user agent.
    browser: { type: String, maxlength: 60, default: null },
    os: { type: String, maxlength: 60, default: null },
    ip: { type: String, maxlength: 64, default: null },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);

sessionSchema.index({ jti: 1 }, { unique: true });
sessionSchema.index({ user: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
