import { z } from 'zod';
import { BOARD_LANES, DENSITIES, PORTAL_ACCENTS, THEMES } from '../models/index.js';

const name = z.string().trim().min(1, 'Name is required').max(80, 'Name must be at most 80 characters');
const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(254));

// bcrypt only uses the first 72 bytes, so longer passwords are refused rather than silently cut.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain a letter and a number');

export const registerSchema = z.object({ name, email, password });

// Login doesn't re-check password rules: a wrong password simply fails to match.
export const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required').max(200) });

export const updateProfileSchema = z
  .object({ name: name.optional(), emailNotifications: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.emailNotifications !== undefined, 'Send a name or emailNotifications');

// Personal preferences: any subset; what is sent replaces just those settings.
export const preferencesSchema = z
  .object({
    theme: z.enum(THEMES, `Theme is one of: ${THEMES.join(', ')}`).optional(),
    accent: z.enum(PORTAL_ACCENTS, `The accent is one of: ${PORTAL_ACCENTS.join(', ')}`).nullable().optional(),
    density: z.enum(DENSITIES, `Density is one of: ${DENSITIES.join(', ')}`).optional(),
    sidebarCollapsed: z.boolean().optional(),
    board: z.object({
      lanes: z.enum(BOARD_LANES, 'Lanes are none, assignee, epic or priority').optional(),
      mine: z.boolean().optional(),
      sprintOnly: z.boolean().optional(),
    }).strict().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Send at least one preference');

export const changePasswordSchema = z.object({
  // Left out by someone who joined with GitHub / Google and is setting their first password.
  currentPassword: z.string().max(200).optional(),
  newPassword: password,
});

// password for accounts that have one; confirmEmail for GitHub / Google accounts without one.
export const deleteAccountSchema = z.object({ password: z.string().max(200).optional(), confirmEmail: z.string().max(254).optional() });

// ---- E2: forgot password, verify email, 2FA, sessions ----
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'This link is not valid');
// A 6-digit code from the app, or a backup code like "ab3d-7kq2".
const secondFactor = z.string().trim().min(6, 'Enter the 6-digit code').max(20, 'Enter the 6-digit code');

export const forgotSchema = z.object({ email });
export const resetSchema = z.object({ token: linkToken, password });
export const verifySchema = z.object({ token: linkToken });
export const loginSecondStepSchema = z.object({ ticket: z.string().min(20).max(2000), code: secondFactor });
export const twoFactorCodeSchema = z.object({ code: secondFactor });
export const twoFactorDisableSchema = z.object({ password: z.string().max(200).optional(), code: secondFactor });
export const sessionParams = z.object({ sessionId: z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid session id') });

// ---- E2B: sign in with GitHub / Google ----
export const oauthParams = z.object({ provider: z.enum(['github', 'google'], 'Unknown sign-in provider') });
export const oauthStartQuery = z.object({
  mode: z.enum(['login', 'link']).default('login'),
  intent: z.string().max(2000).optional(),
  from: z.string().max(300).optional(),
});
export const oauthExchangeSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'That sign-in link is not valid') });

// Personal API tokens and notification settings (E13).
export const apiTokenSchema = z.object({
  name: z.string().trim().min(1, 'Name the token, e.g. "Laptop CLI"').max(80),
  scope: z.enum(['read', 'write'], 'Scope is read or write').default('read'),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable().default(90),
});
export const apiTokenParams = z.object({ tokenId: z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid token id') });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times look like 22:00');
export const notifySettingsSchema = z.object({
  emailNotifications: z.boolean().optional(),
  digest: z.enum(['off', 'daily', 'weekly']).optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  timeZone: z.string().max(60).optional(),
  quiet: z.object({ enabled: z.boolean().optional(), from: hhmm.optional(), to: hhmm.optional() }).optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one setting');

// Push notifications (E14): the browser's PushSubscription as JSON.
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});
export const pushRemoveSchema = z.object({ endpoint: z.string().url().max(1000).optional(), id: z.string().regex(/^[a-f0-9]{24}$/).optional() }).refine((b) => b.endpoint || b.id, 'Send endpoint or id');
