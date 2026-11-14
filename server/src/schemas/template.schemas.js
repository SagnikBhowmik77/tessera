import mongoose from 'mongoose';
import { z } from 'zod';
import { TICKET_TYPES, PRIORITIES } from '../models/index.js';
import { projectParams } from './project.schemas.js';

const objectId = (label) => z.string().refine((v) => mongoose.isValidObjectId(v), `${label} is not a valid id`);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-11-30')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');
const atLeastOne = (b) => Object.values(b).some((v) => v !== undefined);

// ---- Custom fields
const fieldDef = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
  name: z.string().trim().min(1, 'Field name is required').max(40, 'Field names are at most 40 characters'),
  type: z.enum(['text', 'number', 'select', 'date', 'checkbox', 'url'], 'Type is one of: text, number, select, date, checkbox, url'),
  options: z.array(z.string().trim().min(1, 'Options cannot be empty').max(40, 'Options are at most 40 characters')).max(30, 'At most 30 options')
    .transform((o) => [...new Set(o)]).default([]),
});
export const customFieldsSchema = z.object({ fields: z.array(fieldDef).max(20, 'At most 20 custom fields') });

// ---- Templates
const templateFields = {
  name: z.string().trim().min(1, 'Name is required').max(60, 'Names are at most 60 characters'),
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
  description: z.string().max(20_000).default(''),
  type: z.enum(TICKET_TYPES).default('task'),
  priority: z.enum(PRIORITIES).default('medium'),
  labels: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20).transform((l) => [...new Set(l)]).default([]),
  storyPoints: z.number().min(0).max(100).nullable().default(null),
  subtasks: z.array(z.string().trim().min(1, 'Sub-task titles cannot be empty').max(200)).max(20, 'At most 20 sub-tasks').default([]),
};
export const templateParams = projectParams.extend({ templateId: objectId('Template') });
export const createTemplateSchema = z.object(templateFields);
export const updateTemplateSchema = z
  .object({
    name: templateFields.name.optional(),
    title: templateFields.title.optional(),
    description: z.string().max(20_000).optional(),
    type: z.enum(TICKET_TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    labels: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20).transform((l) => [...new Set(l)]).optional(),
    storyPoints: z.number().min(0).max(100).nullable().optional(),
    subtasks: z.array(z.string().trim().min(1, 'Sub-task titles cannot be empty').max(200)).max(20, 'At most 20 sub-tasks').optional(),
  })
  .refine(atLeastOne, 'Send at least one field to change');

// ---- Recurring tickets
export const recurringParams = projectParams.extend({ recurringId: objectId('Recurring ticket') });
export const createRecurringSchema = z.object({
  templateId: objectId('Template'),
  assigneeId: objectId('Assignee').nullable().default(null),
  every: z.enum(['day', 'week', 'month'], 'Repeat every day, week or month'),
  interval: z.number().int().min(1, 'At least 1').max(12, 'At most 12').default(1),
  firstDay: day,
  dueInDays: z.number().int().min(0).max(90).nullable().default(null),
});
export const updateRecurringSchema = z
  .object({
    templateId: objectId('Template').optional(),
    assigneeId: objectId('Assignee').nullable().optional(),
    every: z.enum(['day', 'week', 'month']).optional(),
    interval: z.number().int().min(1).max(12).optional(),
    firstDay: day.optional(),
    dueInDays: z.number().int().min(0).max(90).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(atLeastOne, 'Send at least one field to change');
