import mongoose from 'mongoose';
import { z } from 'zod';
import { ticketParams } from './ticket.schemas.js';

const objectId = (label) => z.string().refine((v) => mongoose.isValidObjectId(v), `${label} is not a valid id`);

const body = z
  .string()
  .max(10_000, 'Comments are at most 10,000 characters')
  .refine((s) => s.trim().length > 0, 'Write something first');

export const commentParams = ticketParams.extend({ commentId: objectId('Comment') });
export const attachmentParams = ticketParams.extend({ attachmentId: objectId('Attachment') });
// The log viewer (E12).
export const logQuery = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug'], 'Level is error, warn, info or debug').optional(),
  q: z.string().max(200).default(''),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createCommentSchema = z.object({
  body,
  parentId: objectId('Parent comment').nullable().optional(),
  // 'reporter' also emails the comment to the person who reported the ticket from the public page.
  visibility: z.enum(['internal', 'reporter'], 'Visibility is internal or reporter').default('internal'),
  // Which outside reporter a 'reporter' comment is for (E11); the first one when left out.
  trackerId: objectId('Reporter').optional(),
});
export const editCommentSchema = z.object({ body });
