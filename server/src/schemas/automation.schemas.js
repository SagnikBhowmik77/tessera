import mongoose from 'mongoose';
import { z } from 'zod';
import { PRIORITIES, RULE_TRIGGERS, TICKET_TYPES } from '../models/index.js';
import { projectParams } from './project.schemas.js';

const objectId = (label) => z.string().refine((v) => mongoose.isValidObjectId(v), `${label} is not a valid id`);
const statusKey = z.string().regex(/^[a-z0-9_]{1,32}$/, 'Pick a column');
const label = z.string().trim().toLowerCase().min(1, 'Labels cannot be empty').max(30, 'Labels are at most 30 characters');

// ---- Automation rules (E4C)
// Only the setting that belongs to the trigger is kept (e.g. a column for "moved").
const KEEP = { moved: 'status', priority_changed: 'priority', label_added: 'label', sla_breached: 'kind' };
const trigger = z
  .object({
    type: z.enum(RULE_TRIGGERS, 'Pick what starts the rule'),
    status: statusKey.nullable().default(null),
    priority: z.enum(PRIORITIES).nullable().default(null),
    label: label.nullable().default(null),
    kind: z.enum(['response', 'resolve']).nullable().default(null),
  })
  .transform((t) => ({ type: t.type, status: null, priority: null, label: null, kind: null, ...(KEEP[t.type] && { [KEEP[t.type]]: t[KEEP[t.type]] }) }));
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign'), value: objectId('Person').nullable() }),
  z.object({ type: z.literal('set_priority'), value: z.enum(PRIORITIES, 'Pick a priority') }),
  z.object({ type: z.literal('add_label'), value: label }),
  z.object({ type: z.literal('remove_label'), value: label }),
  z.object({ type: z.literal('move'), value: statusKey }),
  z.object({ type: z.literal('due_in'), value: z.number().int('Whole days only').min(0, 'At least 0 days').max(365, 'At most 365 days') }),
  z.object({ type: z.literal('add_watcher'), value: objectId('Person') }),
], 'Pick an action');
const conditions = z.object({
  types: z.array(z.enum(TICKET_TYPES)).max(4).default([]),
  priorities: z.array(z.enum(PRIORITIES)).max(4).default([]),
  labels: z.array(label).max(10, 'At most 10 labels').default([]),
  unassigned: z.boolean().nullable().default(null),
});
const ruleName = z.string().trim().min(1, 'Name the rule').max(80, 'Rule names are at most 80 characters');
const actions = z.array(action).min(1, 'Add at least one action').max(5, 'At most 5 actions');

export const ruleParams = projectParams.extend({ ruleId: objectId('Rule') });
export const createRuleSchema = z.object({
  name: ruleName, enabled: z.boolean().default(true), trigger, conditions: conditions.default({ types: [], priorities: [], labels: [], unassigned: null }), actions,
});
export const updateRuleSchema = z
  .object({ name: ruleName.optional(), enabled: z.boolean().optional(), trigger: trigger.optional(), conditions: conditions.optional(), actions: actions.optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change');
export const reorderRulesSchema = z.object({ ids: z.array(objectId('Rule')).max(30) });

// ---- Service levels
const hours = z.number().int('Whole hours only').min(1, 'At least 1 hour').max(2160, 'At most 2160 hours (90 days)').nullable().default(null);
export const slaSchema = z.object({
  enabled: z.boolean(),
  targets: z.array(z.object({ priority: z.enum(PRIORITIES), responseHours: hours, resolveHours: hours })).max(4),
});
export const slaReportQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) });

// ---- Audit log
export const auditQuery = z.object({
  before: z.coerce.date().optional(),
  area: z.enum(['people', 'setup', 'automation', 'planning', 'tickets']).optional(),
});
