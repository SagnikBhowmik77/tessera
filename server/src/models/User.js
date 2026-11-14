import mongoose from 'mongoose';
import { PORTAL_ACCENTS } from './Project.js';

// Personal preferences (stored on the account).
export const THEMES = ['system', 'light', 'dark'];
export const DENSITIES = ['comfortable', 'compact'];
export const BOARD_LANES = ['', 'assignee', 'epic', 'priority'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Stored lowercase so "Asha@X.com" and "asha@x.com" are the same account.
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    // Never returned unless a query asks for it with .select('+passwordHash').
    // Null for someone who joined with GitHub or Google and hasn't set a password.
    passwordHash: { type: String, default: null, select: false },
    // Safe to send: whether a password exists (the hash above is hidden).
    passwordSet: { type: Boolean, default: true },
    // Linked sign-in providers: the provider's own account id (never a token).
    oauth: {
      github: { type: new mongoose.Schema({ id: String, login: String }, { _id: false }), default: undefined },
      google: { type: new mongoose.Schema({ id: String, email: String }, { _id: false }), default: undefined },
    },
    // Bumped on "log out everywhere" and password change; tokens carry it and stop working when it changes.
    tokenVersion: { type: Number, default: 0 },
    // Email me about mentions and assignments while I'm not in the app.
    emailNotifications: { type: Boolean, default: true },
    // Quiet hours and digests (E13). Times are in timeZone (the app's own zone when unset).
    notify: {
      type: new mongoose.Schema({
        digest: { type: String, enum: ['off', 'daily', 'weekly'], default: 'off' },
        digestHour: { type: Number, min: 0, max: 23, default: 8 },
        timeZone: { type: String, maxlength: 60, default: null },
        quiet: { enabled: { type: Boolean, default: false }, from: { type: String, default: '22:00' }, to: { type: String, default: '08:00' } },
        lastDigestAt: { type: Date, default: null },
      }, { _id: false }),
      default: () => ({}),
    },
    // Set when the person opens the link we emailed (or accepts an emailed invite).
    // Notification emails only go to verified addresses.
    emailVerifiedAt: { type: Date, default: null },
    // Authenticator-app 2FA. Secrets are stored encrypted and never leave the server.
    twoFactor: {
      type: new mongoose.Schema({
        enabled: { type: Boolean, default: false },
        secret: { type: String, default: null },
        // Set during setup, until the first code from the app confirms it.
        pendingSecret: { type: String, default: null },
        // The last 30-second step used, so the same code can't be used twice.
        lastStep: { type: Number, default: -1 },
        backupCodes: { type: [String], default: [] },
      }, { _id: false }),
      default: () => ({}),
      select: false,
    },
    // Copy of twoFactor.enabled that is safe to read and send (the block above is hidden).
    twoFactorEnabled: { type: Boolean, default: false },
    // How the app looks and is laid out for this person, saved with the account so it follows
    // them to every device: light/dark (or the system's), an accent from the curated set, how
    // dense lists and cards are, whether the sidebar is collapsed, and the board's layout.
    preferences: {
      type: new mongoose.Schema({
        theme: { type: String, enum: THEMES, default: 'system' },
        accent: { type: String, enum: [...PORTAL_ACCENTS, null], default: null },
        density: { type: String, enum: DENSITIES, default: 'comfortable' },
        sidebarCollapsed: { type: Boolean, default: false },
        board: {
          type: new mongoose.Schema({
            lanes: { type: String, enum: BOARD_LANES, default: '' },
            mine: { type: Boolean, default: false },
            sprintOnly: { type: Boolean, default: false },
          }, { _id: false }),
          default: () => ({}),
        },
      }, { _id: false }),
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    // What the API sends: { id, name, email, createdAt, updatedAt }. Secrets never leave the server.
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.tokenVersion;
        delete ret.twoFactor;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
// One Tessera account per GitHub / Google account.
userSchema.index({ 'oauth.github.id': 1 }, { unique: true, partialFilterExpression: { 'oauth.github.id': { $type: 'string' } } });
userSchema.index({ 'oauth.google.id': 1 }, { unique: true, partialFilterExpression: { 'oauth.google.id': { $type: 'string' } } });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
