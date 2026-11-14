import mongoose from 'mongoose';
import { z } from 'zod';

const day = (label) => z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must look like 2026-11-30`)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date')
  .transform((s) => new Date(`${s}T00:00:00Z`));

export const leaveBody = z.object({
  from: day('First day'),
  to: day('Last day'),
  note: z.string().trim().max(100, 'The note is at most 100 characters').optional(),
});
export const leaveParams = z.object({ leaveId: z.string().refine((v) => mongoose.isValidObjectId(v), 'Not a valid leave id') });
export const leaveRangeQuery = z.object({ from: day('from'), to: day('to') });
