import { z } from 'zod';
import { addDays, dayToDate, todayIn } from '../dates.js';
import { ORIGIN } from '../services/ingest.service.js';
import { PORTAL_ACCENTS } from '../models/Project.js';

// Public portal settings (managers).
export const portalSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    intro: z.string().trim().max(500, 'The intro is at most 500 characters').optional(),
    widget: z.object({
      enabled: z.boolean().optional(),
      origins: z.array(z.string().trim().toLowerCase().transform((s) => s.replace(/\/+$/, '')).pipe(z.string().regex(ORIGIN, 'Write each website as https://example.com (no path)'))).max(10, 'At most 10 websites').optional(),
    }).optional(),
    // How the page looks: the name reporters see (empty = the project's) and an accent colour.
    brand: z.object({
      name: z.string().trim().max(60, 'The name on the page is at most 60 characters').optional(),
      accent: z.enum(PORTAL_ACCENTS, `The accent is one of: ${PORTAL_ACCENTS.join(', ')}`).nullable().optional(),
    }).optional(),
  })
  .refine((b) => b.enabled !== undefined || b.intro !== undefined || b.widget !== undefined || b.brand !== undefined, 'Send enabled, intro, widget or brand');

export const portalTokenParams = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'This report link is not valid'),
});

// What someone outside the team fills in. `website` is a hidden field real people never see:
// bots that fill in every box give themselves away.
export const portalReportSchema = z.object({
  title: z.string().trim().min(3, 'Give the problem a short title').max(200, 'Titles are at most 200 characters'),
  description: z.string().trim().max(10_000, 'Descriptions are at most 10,000 characters').default(''),
  type: z.enum(['bug', 'feature'], 'Type is bug or feature').default('bug'),
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).optional(),
  errorText: z.string().max(50_000, 'Errors are at most 50,000 characters').optional(),
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(4000).optional(),
});

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-11-30')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');

// Release notes for what was finished between two days (default: the last 14 days).
export const releaseNotesQuery = z
  .object({
    from: day.optional(),
    to: day.optional(),
    version: z.string().trim().min(1).max(40, 'Version is at most 40 characters').optional(),
  })
  .transform((q) => {
    const to = q.to ?? todayIn();
    return { from: q.from ?? addDays(to, -13), to, version: q.version };
  })
  .refine((q) => q.from <= q.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((q) => (dayToDate(q.to) - dayToDate(q.from)) / 86_400_000 <= 365, { message: 'At most 366 days at a time', path: ['from'] });

// Client-facing (E11).
const token = (what) => z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, `This ${what} link is not valid`);
const tref = z.string().trim().regex(/^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?[0-9]{1,7}$/, 'Name a ticket like SC-12');
export const trackParams = z.object({ token: token('tracking') });
export const trackMessageSchema = z.object({ body: z.string().trim().min(1, 'Write a message').max(5000, 'Messages are at most 5,000 characters') });
export const trackAnswerSchema = z.object({ answer: z.enum(['fixed', 'broken'], 'Answer is fixed or broken') });
export const roadmapParams = z.object({ token: token('roadmap') });
export const roadmapItemParams = roadmapParams.extend({ number: z.coerce.number().int().min(1).max(9_999_999) });
// A random id the visitor's browser made (no account on a public roadmap).
export const voterHeader = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Missing or invalid voter id');
export const sharedParams = z.object({ token: token('board') });
export const mergeSchema = z.object({ into: tref });
export const roadmapFlagSchema = z.object({ onRoadmap: z.boolean() });
export const roadmapSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  intro: z.string().trim().max(500, 'The intro is at most 500 characters').optional(),
  rotate: z.literal(true).optional(),
}).refine((b) => b.enabled !== undefined || b.intro !== undefined || b.rotate, 'Send enabled, intro or rotate');
export const shareLinkSchema = z.object({
  name: z.string().trim().min(1, 'Name the link, e.g. "Client: Acme"').max(80, 'At most 80 characters'),
  showPeople: z.boolean().default(false),
});
