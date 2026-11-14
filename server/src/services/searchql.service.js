import { config } from '../config.js';
import { addDays, dayToDate, startOfDayIn, todayIn } from '../dates.js';
import { PRIORITIES, Sprint, Ticket, TICKET_TYPES, User } from '../models/index.js';
import { slaFilter } from './sla.service.js';

// The search language (E4D): filters typed into the search box, mixed with ordinary words.
//   type:bug assignee:me due:<7d checkout
//   priority:>=high -label:wontfix status:"in review" is:open created:<30d
// Values can be comma separated (type:bug,feature means either), quoted when they contain spaces,
// and a leading "-" means "not". Anything that isn't a known filter stays ordinary search text.
export const SEARCH_KEYS = ['type', 'priority', 'status', 'assignee', 'reporter', 'label', 'is', 'due', 'created', 'updated', 'sprint', 'epic', 'sla'];

const TOKEN = /(^|\s)(-?)([a-z]+):(?:"([^"]*)"|(\S*))/gi;

// Splits the query into filter tokens and the remaining words. Pure, so it is easy to test.
export function tokenize(q) {
  const tokens = [];
  const text = q.replace(TOKEN, (whole, lead, neg, key, quoted, plain) => {
    const k = key.toLowerCase();
    if (!SEARCH_KEYS.includes(k)) return whole;
    const raw = quoted ?? plain ?? '';
    tokens.push({ key: k, negate: neg === '-', raw, values: (quoted !== undefined ? [raw] : raw.split(',')).map((v) => v.trim()).filter(Boolean) });
    return lead;
  }).replace(/\s+/g, ' ').trim();
  return { tokens, text };
}

export const hasFilters = (q) => tokenize(q).tokens.length > 0;

const DAY = 24 * 3600 * 1000;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
// "7d", "2w", "1m" -> days
function spanDays(v) {
  const m = /^(\d{1,4})([dwm])$/i.exec(v);
  if (!m) return null;
  return Number(m[1]) * { d: 1, w: 7, m: 30 }[m[2].toLowerCase()];
}
// "<7d" -> { op: '<', value: '7d' }
const comparison = (v) => {
  const m = /^(<=|>=|<|>|=)?(.*)$/.exec(v);
  return { op: m[1] && m[1] !== '=' ? m[1] : '=', value: m[2] };
};
const OPS = { '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };
const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const list = (values) => values.join(' or ');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Turns tokens into MongoDB conditions plus a plain-words description of each, and problems for
// anything it couldn't understand (those tokens are left out, never guessed).
export async function compileSearch(project, user, q, now = new Date()) {
  const { tokens, text } = tokenize(q);
  const conds = [];
  const understood = [];
  const problems = [];
  const today = todayIn(config.timeZone, now);
  const done = project.statuses.filter((s) => s.category === 'done').map((s) => s.key);
  let people = null;
  const members = async () => {
    people ??= await User.find({ _id: { $in: project.members.map((m) => m.user) } }, { name: 1, email: 1 }).lean();
    return people;
  };

  for (const t of tokens) {
    const add = (cond, words) => {
      conds.push(t.negate ? { $nor: [cond] } : cond);
      understood.push(`${t.negate ? 'not ' : ''}${words}`);
    };
    const fail = (message) => problems.push(`${t.negate ? '-' : ''}${t.key}:${t.raw}: ${message}`);
    if (!t.values.length) { fail('needs a value'); continue; }
    switch (t.key) {
      case 'type': {
        const v = t.values.map((x) => x.toLowerCase().replace(/s$/, ''));
        if (v.some((x) => !TICKET_TYPES.includes(x))) { fail(`type is one of ${TICKET_TYPES.join(', ')}`); break; }
        add({ type: { $in: v } }, `type is ${list(v)}`);
        break;
      }
      case 'priority': {
        const order = ['low', 'medium', 'high', 'critical'];
        const { op, value } = comparison(t.values[0].toLowerCase());
        if (op !== '=' && t.values.length === 1) {
          const i = order.indexOf(value);
          if (i < 0) { fail(`priority is one of ${order.join(', ')}`); break; }
          const set = order.filter((_, j) => ({ '<': j < i, '<=': j <= i, '>': j > i, '>=': j >= i })[op]);
          if (!set.length) { fail('no priority matches that'); break; }
          add({ priority: { $in: set } }, `priority is ${list(set)}`);
          break;
        }
        const v = t.values.map((x) => x.toLowerCase());
        if (v.some((x) => !PRIORITIES.includes(x))) { fail(`priority is one of ${order.join(', ')}`); break; }
        add({ priority: { $in: v } }, `priority is ${list(v)}`);
        break;
      }
      case 'status': {
        const keys = new Set();
        const names = new Set();
        let ok = true;
        for (const v of t.values) {
          const n = norm(v);
          const byColumn = project.statuses.filter((s) => norm(s.key) === n || norm(s.name) === n);
          const found = byColumn.length ? byColumn : project.statuses.filter((s) => norm(s.category) === n);
          if (!found.length) { fail(`no column called "${v}" (columns: ${project.statuses.map((s) => s.name).join(', ')})`); ok = false; break; }
          for (const s of found) { keys.add(s.key); names.add(s.name); }
        }
        if (ok) add({ status: { $in: [...keys] } }, `in ${list([...names])}`);
        break;
      }
      case 'assignee':
      case 'reporter': {
        const ids = [];
        const names = [];
        let ok = true;
        for (const v of t.values) {
          const n = v.toLowerCase();
          if (n === 'me') { ids.push(user._id); names.push('me'); continue; }
          if (n === 'none' && t.key === 'assignee') { ids.push(null); names.push('nobody'); continue; }
          const found = (await members()).filter((u) => u.name.toLowerCase().includes(n) || u.email.toLowerCase().startsWith(n));
          if (!found.length) { fail(`no member matches "${v}"`); ok = false; break; }
          for (const u of found) { ids.push(u._id); names.push(u.name); }
        }
        if (ok) add({ [t.key]: { $in: ids } }, `${t.key === 'assignee' ? 'assigned to' : 'reported by'} ${list(names)}`);
        break;
      }
      case 'label': {
        const v = t.values.map((x) => x.toLowerCase());
        add({ labels: { $in: v } }, `labelled ${list(v)}`);
        break;
      }
      case 'is': {
        const IS = {
          open: [{ status: { $nin: done } }, 'open'],
          done: [{ status: { $in: done } }, 'done'],
          closed: [{ status: { $in: done } }, 'done'],
          unassigned: [{ assignee: null }, 'unassigned'],
          assigned: [{ assignee: { $ne: null } }, 'assigned'],
          blocked: [{ blockedSince: { $ne: null } }, 'blocked'],
          overdue: [{ dueDate: { $lt: dayToDate(today) }, status: { $nin: done } }, 'overdue'],
          watched: [{ watchers: user._id }, 'watched by me'],
          reproduced: [{ 'repro.attempts.result': 'reproduced' }, 'reproduced'],
          unreproduced: [{ 'repro.attempts.0': { $exists: true }, 'repro.attempts.result': { $ne: 'reproduced' } }, 'tried but not reproduced'],
        };
        if (t.values.some((v) => !IS[v.toLowerCase()])) { fail(`is: takes ${Object.keys(IS).join(', ')}`); break; }
        const parts = t.values.map((v) => IS[v.toLowerCase()]);
        add(parts.length === 1 ? parts[0][0] : { $or: parts.map((p) => p[0]) }, list(parts.map((p) => p[1])));
        break;
      }
      case 'due': {
        const v = t.values[0].toLowerCase();
        const start = dayToDate(today);
        const words = {
          overdue: [{ dueDate: { $lt: start }, status: { $nin: done } }, 'overdue'],
          today: [{ dueDate: start }, 'due today'],
          week: [{ dueDate: { $gte: start, $lt: dayToDate(addDays(today, 7)) } }, 'due in the next 7 days'],
          none: [{ dueDate: null }, 'no due date'],
          any: [{ dueDate: { $ne: null } }, 'has a due date'],
        };
        if (words[v]) { add(...words[v]); break; }
        const { op, value } = comparison(v);
        const days = spanDays(value);
        const day = days !== null ? addDays(today, days) : isDay(value) ? value : null;
        if (!day) { fail('try due:<7d, due:>2w, due:2026-11-30, due:overdue, due:today, due:week or due:none'); break; }
        const label = days !== null ? `${days} day${days === 1 ? '' : 's'} from today (${day})` : day;
        if (op === '=') add({ dueDate: dayToDate(day) }, `due on ${label}`);
        else add({ dueDate: { [OPS[op]]: dayToDate(day), $ne: null } }, `due ${op.startsWith('<') ? 'before' : 'after'}${op.length === 2 ? ' or on' : ''} ${label}`);
        break;
      }
      case 'created':
      case 'updated': {
        const field = t.key === 'created' ? 'createdAt' : 'updatedAt';
        const { op, value } = comparison(t.values[0].toLowerCase());
        const days = spanDays(value);
        if (days !== null && op !== '=') {
          // "created:<7d": less than 7 days ago (newer); "created:>30d": more than 30 days ago.
          const at = new Date(now - days * DAY);
          const newer = op.startsWith('<');
          add({ [field]: newer ? { $gte: at } : { $lt: at } }, `${t.key} ${newer ? 'in the last' : 'more than'} ${days} day${days === 1 ? '' : 's'}${newer ? '' : ' ago'}`);
          break;
        }
        if (!isDay(value)) { fail(`try ${t.key}:<7d, ${t.key}:>30d or ${t.key}:>=2026-11-01`); break; }
        const from = startOfDayIn(value);
        const to = startOfDayIn(addDays(value, 1));
        const range = { '=': { $gte: from, $lt: to }, '<': { $lt: from }, '<=': { $lt: to }, '>': { $gte: to }, '>=': { $gte: from } }[op];
        add({ [field]: range }, `${t.key} ${{ '=': 'on', '<': 'before', '<=': 'on or before', '>': 'after', '>=': 'on or after' }[op]} ${value}`);
        break;
      }
      case 'sprint': {
        const v = t.values[0];
        if (['none', 'backlog'].includes(v.toLowerCase())) { add({ sprint: null }, 'in the backlog'); break; }
        const sprint = v.toLowerCase() === 'active'
          ? await Sprint.findOne({ project: project._id, state: 'active' }, { name: 1 }).lean()
          : await Sprint.findOne({ project: project._id, name: new RegExp(`^${escapeRegex(v)}$`, 'i') }, { name: 1 }).lean();
        if (!sprint) { fail(v.toLowerCase() === 'active' ? 'no sprint is running' : `no sprint called "${v}"`); break; }
        add({ sprint: sprint._id }, `in sprint ${sprint.name}`);
        break;
      }
      case 'epic': {
        const m = /^(?:([a-z][a-z0-9]{1,5})-)?(\d+)$/i.exec(t.values[0]);
        const epic = m && (!m[1] || m[1].toUpperCase() === project.key)
          ? await Ticket.findOne({ project: project._id, number: Number(m[2]), type: 'epic' }, { number: 1 }).lean()
          : null;
        if (!epic) { fail(`name an epic like epic:${project.key}-12`); break; }
        add({ epic: epic._id }, `in epic ${project.key}-${epic.number}`);
        break;
      }
      case 'sla': {
        const v = t.values[0].toLowerCase().replace('-', '_');
        if (!['breached', 'late', 'at_risk', 'soon'].includes(v)) { fail('sla: takes breached or at_risk'); break; }
        if (!project.sla?.enabled) { fail('service levels are off in this project'); break; }
        const state = v === 'late' ? 'breached' : v === 'soon' ? 'at_risk' : v;
        add(slaFilter(project, state, now), state === 'breached' ? 'past an SLA target' : 'SLA due soon');
        break;
      }
      default: break;
    }
  }
  return { conds, understood, problems, text };
}
