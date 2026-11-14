import mongoose from 'mongoose';
import { z } from 'zod';
import { TICKET_TYPES, PRIORITIES } from '../models/index.js';

// "12" or "TES-12".
export const ticketParams = z.object({
  ref: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?\d{1,7}$/, 'A ticket is referred to by its number (12) or key (TES-12)'),
});

const title = z.string().trim().min(1, 'Title is required').max(200, 'Title must be at most 200 characters');
const description = z.string().max(20_000, 'Description must be at most 20,000 characters');
const type = z.enum(TICKET_TYPES, `Type must be one of: ${TICKET_TYPES.join(', ')}`);
const priority = z.enum(PRIORITIES, `Priority must be one of: ${PRIORITIES.join(', ')}`);
const status = z.string().regex(/^[a-z0-9_]{1,32}$/, 'Unknown status');
const labels = z
  .array(z.string().trim().toLowerCase().min(1, 'Labels cannot be empty').max(30, 'Labels are at most 30 characters'))
  .max(20, 'At most 20 labels')
  .transform((l) => [...new Set(l)]);
// A calendar date with no time: stored as UTC midnight, sent back as YYYY-MM-DD.
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must look like 2026-11-30')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date')
  .transform((s) => new Date(`${s}T00:00:00Z`))
  .nullable();
const storyPoints = z.number().min(0, 'Story points cannot be negative').max(100, 'At most 100 story points').nullable();
const assigneeId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Assignee is not a valid user id').nullable();

// Custom field values: { fieldKey: value | null }. Checked against the project's fields in the service.
const fieldValues = z
  .record(z.string().regex(/^[a-z0-9_]{1,32}$/, 'Unknown field'), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((v) => Object.keys(v).length <= 20, 'At most 20 fields');
const templateId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Not a valid template id');

// A pasted error or stack trace (bug intelligence). Up to ~50 KB of text.
const errorText = z
  .string()
  .max(50_000, 'Errors are at most 50,000 characters; paste the top of the trace')
  .refine((s) => s.trim().length > 0, 'Paste an error or stack trace');
const userAgent = z.string().max(500).optional();

// The title can be left out when an error is pasted: it comes from the error itself.
export const createTicketSchema = z
  .object({
    title: title.optional(),
    type: type.optional(),
    description: description.default(''),
    priority: priority.default('medium'),
    status: status.optional(),
    assigneeId: assigneeId.optional(),
    labels: labels.default([]),
    dueDate: dueDate.optional(),
    startDate: dueDate.optional(),
    storyPoints: storyPoints.optional(),
    errorText: errorText.optional(),
    userAgent,
    overrideWip: z.boolean().optional(),
    fields: fieldValues.optional(),
    // Fill the rest from a template (and create its sub-tasks).
    templateId: templateId.optional(),
  })
  .refine((b) => b.title !== undefined || b.errorText !== undefined || b.templateId !== undefined, { message: 'Title is required', path: ['title'] })
  .refine((b) => !(b.startDate && b.dueDate) || b.startDate <= b.dueDate, { message: 'The start date must be on or before the due date', path: ['startDate'] });

// Snooze until a moment (ISO date-time with an offset, e.g. 2026-11-10T09:00:00+05:30).
export const snoozeSchema = z.object({
  until: z.iso.datetime({ offset: true, message: 'until must be a date and time' }),
});

export const parseErrorSchema = z.object({ text: errorText, userAgent });

// Reproduction tracking and comparing crashes (E5B).
export const reproStepsSchema = z.object({ steps: z.string().max(5000, 'At most 5,000 characters') });
export const reproAttemptSchema = z.object({
  result: z.enum(['reproduced', 'not_reproduced'], { message: 'result is reproduced or not_reproduced' }),
  environment: z.string().trim().max(100, 'At most 100 characters').optional(),
  note: z.string().trim().max(500, 'At most 500 characters').optional(),
});
export const reproAttemptParams = ticketParams.extend({ attemptId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Attempt is not a valid id') });

// Muting a known error (E5A).
export const muteErrorSchema = z.object({
  for: z.enum(['1h', '1d', '7d', '30d', 'forever'], { message: 'Mute for 1h, 1d, 7d, 30d or forever' }),
  reason: z.string().trim().max(200, 'At most 200 characters').optional(),
});

export const similarSchema = z.object({
  title: z.string().trim().min(1, 'Type a title first').max(200),
  description: z.string().max(20_000).optional(),
  // The ticket being edited, so it doesn't match itself.
  exclude: z.number().int().positive().optional(),
});

export const updateTicketSchema = z
  .object({
    title: title.optional(),
    type: type.optional(),
    description: description.optional(),
    priority: priority.optional(),
    status: status.optional(),
    assigneeId: assigneeId.optional(),
    labels: labels.optional(),
    dueDate: dueDate.optional(),
    startDate: dueDate.optional(),
    storyPoints: storyPoints.optional(),
    fields: fieldValues.optional(),
    // Managers may move a card into a column that is at its WIP limit.
    overrideWip: z.boolean().optional(),
    // Context for the new assignee when a ticket changes hands (saved as a handoff comment).
    handoffNote: z.string().trim().max(2000, 'Handoff notes are at most 2,000 characters').optional(),
    // The ticket's updatedAt when the editor started (E10): someone else's change to the same field is not overwritten.
    expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((b) => Object.entries(b).some(([k, v]) => !['overrideWip', 'handoffNote', 'expectedUpdatedAt'].includes(k) && v !== undefined), 'Send at least one field to change');

// A Kanban drop: the target column plus the numbers of the cards it landed between
// (`after` = the card above, `before` = the card below; leave out for top/bottom/empty column).
const neighbour = z.number().int().positive().nullable().optional();
export const moveTicketSchema = z.object({ status, after: neighbour, before: neighbour, overrideWip: z.boolean().optional() });

// ---- E4A: bulk edit and CSV import ----
const label = z.string().trim().toLowerCase().min(1, 'Labels cannot be empty').max(30, 'Labels are at most 30 characters');
const objectIdOrNull = (what) => z.string().refine((v) => mongoose.isValidObjectId(v), `${what} is not a valid id`).nullable();
export const bulkSchema = z
  .object({
    // Ticket numbers (from the list's checkboxes), at most 200 at a time.
    tickets: z.array(z.number().int().positive()).min(1, 'Pick at least one ticket').max(200, 'At most 200 tickets at a time')
      .transform((t) => [...new Set(t)]),
    action: z.enum(['update', 'delete', 'restore']).default('update'),
    changes: z.object({
      status: status.optional(),
      priority: priority.optional(),
      type: type.optional(),
      assigneeId: assigneeId.optional(),
      dueDate: dueDate.optional(),
      addLabels: z.array(label).max(20).optional(),
      removeLabels: z.array(label).max(20).optional(),
      sprint: objectIdOrNull('Sprint').optional(),
      milestone: objectIdOrNull('Milestone').optional(),
      overrideWip: z.boolean().optional(),
    }).default({}),
  })
  .refine((b) => b.action !== 'update' || Object.entries(b.changes).some(([k, v]) => k !== 'overrideWip' && v !== undefined && !(Array.isArray(v) && !v.length)),
    { message: 'Choose something to change', path: ['changes'] });
export const importQuery = z.object({
  dryRun: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  skipInvalid: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

// The list/search query lives in filter.schemas.js (shared with saved filters).

// ---- E3: planning links (a ticket is named by its key "SC-12" or number "12") ----
const ticketRef = z.string().trim().regex(/^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?\d{1,7}$/, 'Name a ticket like SC-12');
export const epicBody = z.object({ epic: ticketRef.nullable() });
export const parentBody = z.object({ parent: ticketRef.nullable() });
export const subtaskBody = z.object({ title, assigneeId: assigneeId.optional() });
export const blockerBody = z.object({ ticket: ticketRef });
export const blockerParams = ticketParams.extend({ blocker: ticketRef });
export const flagBody = z.object({ reason: z.string().trim().min(1, 'Say what it is waiting for').max(200, 'At most 200 characters') });

export const compareQuery = z.object({ a: ticketRef, b: ticketRef });
