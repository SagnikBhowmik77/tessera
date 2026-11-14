import mongoose from 'mongoose';
import { z } from 'zod';
import { ROLES, STATUS_CATEGORIES } from '../models/index.js';
import { addDays, dayToDate, startOfDayIn, todayIn } from '../dates.js';
import { REPO_NAME } from '../bugs/sourcelink.js';
import { ORIGIN } from '../services/ingest.service.js';

const objectId = (label) => z.string().refine((v) => mongoose.isValidObjectId(v), `${label} is not a valid id`);

const name = z.string().trim().min(1, 'Name is required').max(80, 'Name must be at most 80 characters');
const key = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/, 'Key is 2 to 6 letters or digits and starts with a letter, e.g. TES');
const description = z.string().trim().max(2000, 'Description must be at most 2000 characters');
const role = z.enum(ROLES, `Role must be one of: ${ROLES.join(', ')}`);
const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(254));

export const projectParams = z.object({ projectId: objectId('Project') });
export const memberParams = z.object({ projectId: objectId('Project'), userId: objectId('User') });
export const inviteIdParams = z.object({ projectId: objectId('Project'), inviteId: objectId('Invite') });
export const inviteTokenParams = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/, 'This invite link is invalid'),
});

export const listProjectsQuery = z.object({
  archived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const createProjectSchema = z.object({
  name, key, description: description.default(''),
  // A starting set of columns and labels (E4D); see services/setup.service.js.
  template: z.enum(['kanban', 'scrum', 'bugs', 'support', 'content'], 'Pick one of the project templates').optional(),
});
const labelName = z.string().trim().toLowerCase().min(1, 'Labels cannot be empty').max(30, 'Labels are at most 30 characters');
export const suggestedLabelsSchema = z.object({ labels: z.array(labelName).max(50, 'At most 50 labels') });
export const cardLayoutSchema = z.object({ fields: z.array(z.string().max(40)).max(20) });

export const updateProjectSchema = z
  .object({ name: name.optional(), key: key.optional(), description: description.optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field to change');

// Typing the project key to confirm, as in GitHub's "type the repository name".
export const deleteProjectSchema = z.object({ confirmKey: z.string().trim().toUpperCase() });

export const changeRoleSchema = z.object({ role });

export const createInviteSchema = z.object({ email, role: role.default('developer') });

// Board columns (step 9). Existing columns are sent with their key; new ones without.
export const statusesSchema = z.object({
  statuses: z
    .array(z.object({
      key: z.string().regex(/^[a-z0-9_]{1,32}$/, 'Unknown column').optional(),
      name: z.string().trim().min(1, 'Column name is required').max(40, 'Column names are at most 40 characters'),
      category: z.enum(STATUS_CATEGORIES, `Category is one of: ${STATUS_CATEGORIES.join(', ')}`),
      wipLimit: z.number().int().min(1, 'A WIP limit is at least 1').max(999).nullable().optional(),
    }))
    .min(2, 'A board needs at least two columns')
    .max(12, 'At most 12 columns'),
});

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-11-30')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');

// Analytics range in the team's calendar; default the last 30 days.
export const analyticsQuery = z
  .object({
    from: day.optional(),
    to: day.optional(),
    // How long without any activity before an open ticket counts as stale.
    staleDays: z.coerce.number().int().min(1).max(365).default(7),
  })
  .transform((q) => {
    const to = q.to ?? todayIn();
    return { from: q.from ?? addDays(to, -29), to, staleDays: q.staleDays };
  })
  .refine((q) => q.from <= q.to, { message: 'from must be on or before to', path: ['from'] })
  .refine((q) => q.to <= todayIn(), { message: "to can't be in the future", path: ['to'] })
  .refine((q) => (dayToDate(q.to) - dayToDate(q.from)) / 86_400_000 <= 365, { message: 'At most 366 days at a time', path: ['from'] });

// Board time travel: an exact moment, or a calendar day (= the end of that day).
export const boardAtQuery = z
  .object({ at: z.union([z.iso.datetime({ offset: true }), day], 'at is a date (2026-11-01) or a date-time') })
  .transform(({ at }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return { at: new Date(at) };
    const endOfDay = startOfDayIn(addDays(at, 1)).getTime() - 1;
    // Today means "now"; a future day stays in the future so it is refused below.
    return { at: new Date(at > todayIn() ? endOfDay : Math.min(endOfDay, Date.now())) };
  })
  .refine((q) => q.at.getTime() <= Date.now() + 60_000, { message: 'Time travel only goes backwards', path: ['at'] });

// Where the code lives, for source links (E5B). repo: null removes it.
export const sourceSchema = z.object({
  repo: z.string().trim().regex(REPO_NAME, 'Write the repository as owner/name').nullable(),
  branch: z.string().trim().min(1, 'Branch is required').max(100).default('main'),
  pathPrefix: z.string().trim().max(300, 'At most 300 characters').default(''),
});

// Crash capture keys (E6A).
export const ingestKeySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name, e.g. "Shop website"').max(60, 'At most 60 characters'),
  kind: z.enum(['ingest', 'upload', 'deploy']).default('ingest'),
  // A pasted "https://shop.example.com/" is fine: the trailing slash is dropped first.
  origins: z.array(z.string().trim().transform((s) => s.replace(/\/+$/, '')).pipe(z.string().regex(ORIGIN, 'Write each website as https://example.com (no path)'))).max(10, 'At most 10 websites').default([]),
});
export const ingestKeyParams = z.object({ projectId: objectId('Project'), keyId: objectId('Key') });

// GitHub deep integration (E7).
export const githubTokenSchema = z.object({ token: z.string().trim().min(1, 'Paste the token').max(300) });
export const githubOptionsSchema = z.object({
  moves: z.object({ branch: z.string().max(40).nullable().default(null), pr: z.string().max(40).nullable().default(null) }).optional(),
  issues: z.object({ sync: z.boolean() }).optional(),
}).refine((b) => b.moves || b.issues, 'Send moves or issues');
export const todoTicketSchema = z.object({ file: z.string().min(1).max(500), line: z.number().int().min(1) });

// Deployments (E8).
export const deploySettingsSchema = z.object({
  production: z.string().trim().min(1).max(60).optional(),
  emailAfterDeploy: z.boolean().optional(),
  statusPage: z.object({ enabled: z.boolean().optional(), showCrashes: z.boolean().optional() }).optional(),
});

// Flow analytics II (E9).
export const forecastQuery = z.object({
  scope: z.string().regex(/^(open|sprint|epic:\d{1,7})$/, 'Scope is open, sprint or epic:<number>').default('open'),
  add: z.coerce.number().int().min(-1000).max(1000).default(0),
  factor: z.coerce.number().min(0.1).max(3).default(1),
  days: z.coerce.number().int().min(1).max(365).optional(),
});
export const compareDatesQuery = z.object({ from: z.coerce.date(), to: z.coerce.date() });

// Live collaboration II (E10).
const oid = (label) => z.string().refine((v) => mongoose.isValidObjectId(v), `${label} is not a valid id`);
const tref = z.string().trim().regex(/^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?[0-9]{1,7}$/, 'Name a ticket like SC-12');
export const roundParams = z.object({ projectId: oid('Project'), roundId: oid('Round') });
export const retroParams = z.object({ projectId: oid('Project'), retroId: oid('Retro') });
export const retroItemParams = retroParams.extend({ itemId: oid('Note') });
export const incidentParams = z.object({ projectId: oid('Project'), incidentId: oid('Incident') });
export const shareLinkParams = z.object({ projectId: oid('Project'), linkId: oid('Link') });
export const pokerStartSchema = z.object({ ticket: tref });
export const pokerVoteSchema = z.object({ value: z.string().max(3) });
export const pokerAcceptSchema = z.object({ points: z.number().int().min(0).max(100) });
export const retroCreateSchema = z.object({ title: z.string().trim().min(1, 'Give the retro a name').max(120), votesPerPerson: z.number().int().min(1).max(10).optional() });
export const retroItemSchema = z.object({ column: z.enum(['went_well', 'to_improve', 'actions']), text: z.string().trim().min(1, 'Write the note').max(500) });
export const incidentStartSchema = z.object({ title: z.string().trim().min(3, 'Say what is broken').max(180), severity: z.enum(['sev1', 'sev2', 'sev3']).default('sev2') });
export const incidentPatchSchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
  commanderId: oid('Commander').optional(),
  severity: z.enum(['sev1', 'sev2', 'sev3']).optional(),
  rootCause: z.string().max(5000).optional(),
  lessons: z.string().max(5000).optional(),
  followUp: tref.optional(),
});
export const incidentResolveSchema = z.object({ summary: z.string().trim().max(500).optional() });

// Debug files (E12): CI test results.
const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
export const testRunFields = z.object({
  branch: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  commit: z.preprocess(blankToUndefined, z.string().trim().regex(/^[0-9a-f]{7,64}$/i, 'commit is a git commit hash').optional()),
  name: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
});
export const testRunParams = z.object({ projectId: oid('Project'), runId: oid('Run') });
export const testTicketSchema = z.object({ key: z.string().min(3).max(500) });
export const testReportQuery = z.object({ runs: z.coerce.number().int().min(2).max(200).default(30) });

// Notifications and integrations (E13).
const EVENT_NAMES = ['ticket.created', 'ticket.moved', 'ticket.done', 'ticket.assigned', 'ticket.commented', 'ticket.updated'];
const eventList = z.array(z.enum(EVENT_NAMES, 'Unknown event')).min(1, 'Pick at least one event').max(EVENT_NAMES.length);
export const alertSchema = z.object({
  kind: z.enum(['slack', 'discord']),
  name: z.string().trim().min(1, 'Name it, e.g. "#bugs channel"').max(80),
  url: z.string().trim().max(500),
  events: eventList.default(['ticket.created', 'ticket.done']),
  priorities: z.array(z.enum(['critical', 'high', 'medium', 'low'])).max(4).default([]),
});
export const webhookSchema = z.object({ name: z.string().trim().min(1, 'Name it').max(80), url: z.string().trim().max(500), events: eventList.default(EVENT_NAMES) });
export const targetPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(), events: eventList.optional(), active: z.boolean().optional(),
  priorities: z.array(z.enum(['critical', 'high', 'medium', 'low'])).max(4).optional(),
});
export const alertParams = z.object({ projectId: oid('Project'), alertId: oid('Alert') });
export const webhookParams = z.object({ projectId: oid('Project'), webhookId: oid('Webhook') });
export const gitlabTokenSchema = z.object({ token: z.string().trim().min(10, 'Paste the token').max(300), baseUrl: z.string().trim().max(200).optional() });

// Platform (E14).
const wsName = z.string().trim().min(1, 'Name the workspace').max(80, 'At most 80 characters');
export const workspaceNameSchema = z.object({ name: wsName });
export const workspaceParams = z.object({ workspaceId: oid('Workspace') });
export const workspaceMemberParams = z.object({ workspaceId: oid('Workspace'), userId: oid('Person') });
export const workspaceMemberSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')), role: z.enum(['owner', 'admin', 'member']).default('member') });
export const workspaceRoleSchema = z.object({ role: z.enum(['owner', 'admin', 'member']) });
export const projectWorkspaceSchema = z.object({ workspaceId: oid('Workspace').nullable() });
export const fromWorkspaceSchema = z.object({ role: z.enum(['admin', 'manager', 'developer', 'viewer']).default('developer') });
export const importFields = z.object({
  key: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,5}$/, 'Key is 2 to 6 letters or digits and starts with a letter').optional()),
  name: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(80).optional()),
});
export const storageQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) });
export const cleanupSchema = z.object({ attachmentIds: z.array(oid('File')).min(1, 'Pick at least one file').max(200) });
