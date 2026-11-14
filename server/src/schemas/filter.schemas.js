import mongoose from 'mongoose';
import { z } from 'zod';
import { TICKET_TYPES, PRIORITIES } from '../models/index.js';
import { projectParams } from './project.schemas.js';

const objectIdString = z.string().refine((v) => mongoose.isValidObjectId(v), 'Not a valid user id');
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-11-30')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');

// "a,b,c" -> ['a','b','c'], each checked.
const csv = (item, label) => z
  .string()
  .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
  .pipe(z.array(item).min(1, `Pick at least one ${label}`).max(20, `At most 20 ${label} values`));

const person = z.union([z.literal('me'), z.literal('none'), objectIdString]);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const SORTS = ['rank', 'newest', 'oldest', 'updated', 'priority', 'due', 'number', 'relevance'];
const sort = z.enum(SORTS, `sort is one of: ${SORTS.join(', ')}`);

// The filters a view is made of (also what a saved filter stores).
export const filterFields = {
  status: csv(z.string().regex(/^[a-z0-9_]{1,32}$/, 'Unknown status'), 'status').optional(),
  priority: csv(z.enum(PRIORITIES, `Priority is one of: ${PRIORITIES.join(', ')}`), 'priority').optional(),
  type: csv(z.enum(TICKET_TYPES, `Type is one of: ${TICKET_TYPES.join(', ')}`), 'type').optional(),
  assignee: csv(person, 'assignee').optional(),
  reporter: csv(z.union([z.literal('me'), objectIdString]), 'reporter').optional(),
  label: csv(z.string().toLowerCase().max(30), 'label').optional(),
  open: bool.optional(),
  // true = the triage inbox (public-portal reports not yet accepted onto the board).
  triage: bool.optional(),
  due: z.enum(['overdue', 'today', 'week', 'none', 'any'], 'due is one of: overdue, today, week, none, any').optional(),
  // true: tickets with a start or due date (the timeline); false: neither.
  scheduled: bool.optional(),
  // Service levels (E4C): open tickets past a target, or with under a quarter of the time left.
  sla: z.enum(['breached', 'at_risk']).optional(),
  dueFrom: day.optional(),
  dueTo: day.optional(),
  // Planning (E3B): a sprint id, 'active' (the running sprint) or 'none' (the backlog); a milestone id or 'none'.
  sprint: z.union([z.literal('active'), z.literal('none'), objectIdString]).optional(),
  milestone: z.union([z.literal('none'), objectIdString]).optional(),
  q: z.string().trim().max(200, 'Search is at most 200 characters').optional(),
  sort: sort.optional(),
};
export const SAVABLE_KEYS = Object.keys(filterFields);

export const listTicketsQuery = z
  .object({
    ...filterFields,
    sort: sort.default('rank'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    // The bin: deleted tickets that can still be restored.
    deleted: bool.default(false),
  })
  .refine((f) => !(f.dueFrom && f.dueTo) || f.dueFrom <= f.dueTo, { message: 'dueFrom must be on or before dueTo', path: ['dueTo'] });

export const myTicketsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // true: only the tickets you snoozed (with when they come back) instead of your active list.
  snoozed: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

// A saved filter's query: the same filter fields, as the strings a URL would carry.
const savedQuery = z
  .record(z.string(), z.string().max(400))
  .refine((q) => Object.keys(q).every((k) => SAVABLE_KEYS.includes(k)), `Saved filters can use: ${SAVABLE_KEYS.join(', ')}`)
  .refine((q) => z.object(filterFields).safeParse(q).success, 'Some filter values are invalid');

const name = z.string().trim().min(1, 'Name is required').max(60, 'Names are at most 60 characters');

export const filterParams = projectParams.extend({
  filterId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Not a valid filter id'),
});
export const createFilterSchema = z.object({ name, query: savedQuery, shared: z.boolean().default(false) });
export const updateFilterSchema = z
  .object({ name: name.optional(), query: savedQuery.optional(), shared: z.boolean().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field to change');
