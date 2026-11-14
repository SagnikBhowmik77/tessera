import { HttpError } from '../errors.js';
import { Ticket } from '../models/index.js';

// Custom fields (E4B): a project defines up to 20 extra fields (text, number, dropdown, date,
// checkbox, link) and every ticket can hold a value for each. Values are stored on the ticket
// under the field's key, which never changes, so renaming a field keeps every value.

export const FIELD_TYPES = ['text', 'number', 'select', 'date', 'checkbox', 'url'];
export const MAX_FIELDS = 20;

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'field';

// Replaces the project's field list. Existing fields keep their key and type (changing a type
// would make stored values meaningless, so that needs a new field). Values of removed fields,
// and values that used a removed dropdown option, are cleared from every ticket.
export async function setCustomFields(project, input) {
  const current = new Map((project.customFields ?? []).map((f) => [f.key, f]));
  const names = input.map((f) => f.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new HttpError(400, 'duplicate_field', 'Two fields have the same name');
  const taken = new Set(current.keys());
  const next = input.map((f) => {
    const options = f.type === 'select' ? f.options : [];
    if (f.key) {
      const old = current.get(f.key);
      if (!old) throw new HttpError(400, 'unknown_field', `This project has no field "${f.key}"`);
      if (old.type !== f.type) throw new HttpError(400, 'field_type_change', `"${old.name}" is a ${old.type} field. To change the type, remove it and add a new field.`);
      return { key: f.key, name: f.name, type: f.type, options };
    }
    const base = slug(f.name);
    let key = base;
    for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
    taken.add(key);
    return { key, name: f.name, type: f.type, options };
  });
  if (next.some((f) => f.type === 'select' && !f.options.length)) throw new HttpError(400, 'field_options', 'A dropdown needs at least one option');

  const unset = {};
  for (const key of current.keys()) if (!next.some((f) => f.key === key)) unset[`fields.${key}`] = '';
  if (Object.keys(unset).length) await Ticket.updateMany({ project: project._id }, { $unset: unset });
  for (const f of next) {
    const old = current.get(f.key);
    const dropped = old?.type === 'select' ? old.options.filter((o) => !f.options.includes(o)) : [];
    if (dropped.length) {
      await Ticket.updateMany({ project: project._id, [`fields.${f.key}`]: { $in: dropped } }, { $unset: { [`fields.${f.key}`]: '' } });
    }
  }
  project.customFields = next;
  await project.save();
  return project.toJSON().customFields;
}

// Checks values against the project's fields: { key: value | null } -> the same, cleaned up.
// null (or '') clears a value. Throws with the field's name when a value doesn't fit.
export function cleanFieldValues(project, values) {
  const defs = new Map((project.customFields ?? []).map((f) => [f.key, f]));
  const out = {};
  for (const [key, raw] of Object.entries(values)) {
    const def = defs.get(key);
    if (!def) throw new HttpError(400, 'unknown_field', `This project has no field "${key}"`);
    const bad = (why) => new HttpError(400, 'field_invalid', `${def.name}: ${why}`);
    if (raw === null || raw === '') { out[key] = null; continue; }
    const text = String(raw).trim();
    switch (def.type) {
      case 'text':
        if (typeof raw !== 'string') throw bad('expected text');
        if (text.length > 500) throw bad('at most 500 characters');
        out[key] = text;
        break;
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(text);
        if (!Number.isFinite(n) || Math.abs(n) > 1e12 || text === '') throw bad('expected a number');
        out[key] = n;
        break;
      }
      case 'select': {
        const match = def.options.find((o) => o.toLowerCase() === text.toLowerCase());
        if (!match) throw bad(`choose one of ${def.options.join(', ')}`);
        out[key] = match;
        break;
      }
      case 'date': {
        const d = new Date(`${text}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(d.getTime()) || !d.toISOString().startsWith(text)) throw bad('expected a date like 2026-11-30');
        out[key] = text;
        break;
      }
      case 'checkbox': {
        const lower = text.toLowerCase();
        const v = typeof raw === 'boolean' ? raw : ['true', 'yes', '1', 'y'].includes(lower) ? true : ['false', 'no', '0', 'n'].includes(lower) ? false : null;
        if (v === null) throw bad('expected yes or no');
        out[key] = v;
        break;
      }
      case 'url': {
        let u = null;
        try { u = new URL(text); } catch { u = null; }
        if (!u || !['http:', 'https:'].includes(u.protocol) || u.href.length > 500) throw bad('expected a link starting with https://');
        out[key] = u.href;
        break;
      }
      default:
        throw bad('unknown field type');
    }
  }
  return out;
}

// Applies values to a ticket document; returns history events for what changed.
export function applyFieldValues(project, ticket, values) {
  const clean = cleanFieldValues(project, values);
  const fields = { ...(ticket.fields ?? {}) };
  const events = [];
  for (const [key, value] of Object.entries(clean)) {
    const before = fields[key] ?? null;
    if (before === value) continue;
    events.push({ type: 'updated', field: `fields.${key}`, from: before, to: value });
    if (value === null) delete fields[key]; else fields[key] = value;
  }
  if (events.length) {
    ticket.fields = fields;
    ticket.markModified?.('fields');
  }
  return events;
}

// How a value reads in a CSV cell.
export function fieldText(def, value) {
  if (value === null || value === undefined) return '';
  if (def.type === 'checkbox') return value ? 'yes' : 'no';
  return String(value);
}
