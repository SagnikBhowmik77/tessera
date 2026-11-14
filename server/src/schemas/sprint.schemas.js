import mongoose from 'mongoose';
import { z } from 'zod';
import { projectParams } from './project.schemas.js';

const objectId = (label) => z.string().refine((v) => mongoose.isValidObjectId(v), `${label} is not a valid id`);

// A calendar day: stored as UTC midnight.
const day = (label) => z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must look like 2026-11-30`)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date')
  .transform((s) => new Date(`${s}T00:00:00Z`))
  .nullable();

const name = z.string().trim().min(1, 'Name is required').max(60, 'Names are at most 60 characters');
const goal = z.string().trim().max(300, 'The goal is at most 300 characters');
const atLeastOne = (b) => Object.values(b).some((v) => v !== undefined);

export const sprintParams = projectParams.extend({ sprintId: objectId('Sprint') });
export const milestoneParams = projectParams.extend({ milestoneId: objectId('Milestone') });

export const createSprintSchema = z.object({
  name: name.optional(),
  goal: goal.optional(),
  startDate: day('First day').optional(),
  endDate: day('Last day').optional(),
});
export const updateSprintSchema = z
  .object({ name: name.optional(), goal: goal.optional(), startDate: day('First day').optional(), endDate: day('Last day').optional() })
  .refine(atLeastOne, 'Send at least one field to change');
// Where unfinished tickets go when the sprint is completed.
export const completeSprintSchema = z.object({
  carryTo: z.union([z.literal('backlog'), z.literal('new'), objectId('Sprint')]).default('backlog'),
});

export const createMilestoneSchema = z.object({
  name,
  description: z.string().trim().max(500, 'At most 500 characters').optional(),
  dueDate: day('Due date').optional(),
});
export const updateMilestoneSchema = z
  .object({
    name: name.optional(),
    description: z.string().trim().max(500, 'At most 500 characters').optional(),
    dueDate: day('Due date').optional(),
    closed: z.boolean().optional(),
  })
  .refine(atLeastOne, 'Send at least one field to change');

export const ticketSprintBody = z.object({ sprint: objectId('Sprint').nullable() });
export const ticketMilestoneBody = z.object({ milestone: objectId('Milestone').nullable() });
