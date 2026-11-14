import { emitTicketEvents } from './hooks.js';
import { config } from '../config.js';
import { addDays, dayToDate, todayIn } from '../dates.js';
import { HttpError } from '../errors.js';
import { PRIORITIES, Rule, TicketEvent } from '../models/index.js';
import { afterStatusChange } from './blocking.service.js';
import { applyStatus, assignable, bottomRank, checkWip, notifyFromEvents, ticketKey } from './ticket.service.js';

// Automation rules (E4C). See models/Rule.js for the shape.
const MAX_RULES = 30;
const ruleNotFound = () => new HttpError(404, 'rule_not_found', 'Rule not found');
const invalid = (message) => new HttpError(400, 'rule_invalid', message);

const memberOf = (project, id) => project.members.find((m) => String(m.user) === String(id));

// Checks a rule against the project as it is now (columns, members). Used when saving.
function checkRule(project, rule) {
  const column = (key) => {
    if (!project.statuses.some((s) => s.key === key)) throw invalid(`This project has no column "${key}"`);
  };
  const { trigger, actions } = rule;
  if (trigger.type === 'moved' && trigger.status) column(trigger.status);
  if (trigger.type === 'label_added' && !trigger.label) throw invalid('Choose which label starts the rule');
  for (const a of actions) {
    if (a.type === 'assign' && a.value !== null) {
      const m = memberOf(project, a.value);
      if (!m) throw invalid('The person to assign must be a member of this project');
      if (m.role === 'viewer') throw invalid("Viewers can't be assigned tickets");
    }
    if (a.type === 'add_watcher' && !memberOf(project, a.value)) throw invalid('The watcher must be a member of this project');
    if (a.type === 'move') column(a.value);
    if (a.type === 'move' && trigger.type === 'moved' && trigger.status === a.value) {
      throw invalid('A rule started by moving into a column can\'t move the ticket into that same column');
    }
  }
}

export async function listRules(project) {
  return (await Rule.find({ project: project._id }).sort({ order: 1, createdAt: 1 })).map((r) => r.toJSON());
}

async function findRule(project, id) {
  const rule = await Rule.findOne({ _id: id, project: project._id });
  if (!rule) throw ruleNotFound();
  return rule;
}

export async function createRule(project, user, body) {
  if (await Rule.countDocuments({ project: project._id }) >= MAX_RULES) {
    throw new HttpError(409, 'too_many_rules', `A project can have up to ${MAX_RULES} rules`);
  }
  checkRule(project, body);
  const last = await Rule.findOne({ project: project._id }).sort({ order: -1 }).select('order').lean();
  const rule = await Rule.create({ ...body, project: project._id, createdBy: user._id, order: (last?.order ?? -1) + 1 });
  return rule.toJSON();
}

export async function updateRule(project, id, body) {
  const rule = await findRule(project, id);
  const next = {
    trigger: body.trigger ?? rule.trigger.toObject(),
    actions: body.actions ?? rule.actions.map((a) => a.toObject()),
  };
  checkRule(project, next);
  for (const k of ['name', 'enabled', 'trigger', 'conditions', 'actions']) if (body[k] !== undefined) rule[k] = body[k];
  // Editing a rule is a fresh start: an old problem no longer describes it.
  if (body.trigger || body.actions || body.conditions) rule.lastError = null;
  await rule.save();
  return rule.toJSON();
}

export async function deleteRule(project, id) {
  const rule = await findRule(project, id);
  await Rule.deleteOne({ _id: rule._id });
  return rule.name;
}

// The new order, top to bottom: every rule of the project, once.
export async function reorderRules(project, ids) {
  const rules = await Rule.find({ project: project._id }, { _id: 1 }).lean();
  const have = new Set(rules.map((r) => String(r._id)));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((id) => have.has(id))) {
    throw new HttpError(400, 'rule_order', 'List every rule of this project once');
  }
  await Rule.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id }, update: { $set: { order } } } })));
  return listRules(project);
}

// ---- Running rules

function triggered(trigger, events, ticket) {
  return events.some((e) => {
    switch (trigger.type) {
      case 'created': return e.type === 'created';
      case 'moved': return e.type === 'status_changed' && (!trigger.status || e.to === trigger.status);
      case 'priority_changed': return e.type === 'updated' && e.field === 'priority' && (!trigger.priority || e.to === trigger.priority);
      case 'assigned': return e.type === 'assigned' && Boolean(e.to);
      // A ticket created with the label counts as the label being added.
      case 'label_added':
        return (e.type === 'created' && ticket.labels.includes(trigger.label))
          || (e.type === 'updated' && e.field === 'labels' && (e.to ?? []).includes(trigger.label) && !(e.from ?? []).includes(trigger.label));
      case 'sla_breached': return e.type === 'sla_breached' && (!trigger.kind || e.field === trigger.kind);
      default: return false;
    }
  });
}

function conditionsHold(c, ticket) {
  if (c.types?.length && !c.types.includes(ticket.type)) return false;
  if (c.priorities?.length && !c.priorities.includes(ticket.priority)) return false;
  if (c.labels?.length && !c.labels.some((l) => ticket.labels.includes(l))) return false;
  if (c.unassigned === true && ticket.assignee) return false;
  if (c.unassigned === false && !ticket.assignee) return false;
  return true;
}

const idOf = (v) => (v && v._id ? v._id : v);
const dayOf = (d) => (d ? d.toISOString().slice(0, 10) : null);

// Applies one action to the ticket in memory. Returns a history event, true for a change with no
// history line (watchers), or null when there was nothing to do. Throws HttpError when it can't.
async function applyAction(project, ticket, action, at) {
  const v = action.value;
  switch (action.type) {
    case 'assign': {
      let to;
      try {
        to = assignable(project, v);
      } catch {
        throw new HttpError(409, 'rule_assignee', 'The person this rule assigns is no longer a member who can be assigned.');
      }
      if (String(to) === String(idOf(ticket.assignee) ?? null)) return null;
      const from = idOf(ticket.assignee) ?? null;
      ticket.assignee = to;
      return { type: 'assigned', from, to };
    }
    case 'set_priority': {
      if (!PRIORITIES.includes(v) || ticket.priority === v) return null;
      const from = ticket.priority;
      ticket.priority = v;
      // A new priority means a new target: alert again if that one is missed too.
      ticket.slaAlerted = { response: null, resolve: null };
      return { type: 'updated', field: 'priority', from, to: v };
    }
    case 'add_label': {
      if (ticket.labels.includes(v)) return null;
      if (ticket.labels.length >= 20) throw new HttpError(409, 'rule_labels', 'The ticket already has 20 labels.');
      const from = [...ticket.labels];
      ticket.labels = [...from, v];
      return { type: 'updated', field: 'labels', from, to: [...ticket.labels] };
    }
    case 'remove_label': {
      if (!ticket.labels.includes(v)) return null;
      const from = [...ticket.labels];
      ticket.labels = from.filter((l) => l !== v);
      return { type: 'updated', field: 'labels', from, to: [...ticket.labels] };
    }
    case 'move': {
      if (!project.statuses.some((s) => s.key === v)) throw new HttpError(409, 'rule_column', `The column "${v}" no longer exists.`);
      if (ticket.status === v) return null;
      await checkWip(project, null, v, ticket._id, false);
      const from = ticket.status;
      ticket.rank = await bottomRank(project._id, v, ticket._id);
      applyStatus(ticket, project, v, at);
      return { type: 'status_changed', from, to: v };
    }
    case 'due_in': {
      const day = addDays(todayIn(config.timeZone), v);
      if (dayOf(ticket.dueDate) === day) return null;
      if (ticket.startDate && dayOf(ticket.startDate) > day) {
        throw new HttpError(409, 'rule_dates', `The due date would be ${day}, before the ticket's start date.`);
      }
      const from = dayOf(ticket.dueDate);
      ticket.dueDate = dayToDate(day);
      return { type: 'updated', field: 'dueDate', from, to: day };
    }
    case 'add_watcher': {
      if (!memberOf(project, v)) throw new HttpError(409, 'rule_watcher', 'The watcher this rule adds is no longer a member.');
      if ((ticket.watchers ?? []).some((w) => String(idOf(w)) === String(v))) return null;
      ticket.watchers = [...(ticket.watchers ?? []), v];
      return true;
    }
    default: return null;
  }
}

async function applyRule(project, ticket, rule) {
  const at = new Date();
  const events = [];
  const problems = [];
  let changed = false;
  for (const action of rule.actions) {
    try {
      const result = await applyAction(project, ticket, action, at);
      if (result) changed = true;
      if (result && result !== true) events.push(result);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      problems.push(err.message);
    }
  }
  if (changed) {
    await ticket.save();
    if (events.length) {
      await TicketEvent.insertMany(events.map((e) => ({
        project: project._id, ticket: ticket._id, actor: null, source: 'automation',
        rule: { id: String(rule._id), name: rule.name }, at, ...e,
      })));
    }
    if (events.some((e) => e.type === 'status_changed')) await afterStatusChange(project, ticket, null, at);
    await notifyFromEvents(project, ticket, null, events, { note: `Automation rule: ${rule.name}` });
  }
  const key = ticketKey(project, ticket.number);
  const set = {};
  if (changed) set.lastRun = { at, ticketKey: key };
  if (problems.length) set.lastError = { at, ticketKey: key, message: problems.join(' ') };
  if (changed || problems.length) await Rule.updateOne({ _id: rule._id }, { ...(changed && { $inc: { runs: 1 } }), $set: set });
}

// Runs the project's enabled rules for something that just happened to a ticket (`events`, as
// written to its history). Never throws: a rule that can't run must not undo the change that
// started it; it records the problem on the rule instead.
export async function runRules(project, ticket, events) {
  try {
    if (!events?.length || ticket.deletedAt) return;
    // Integrations hear about every change that rules hear about (GitHub issues, alerts, webhooks).
    emitTicketEvents(project, ticket, events);
    const rules = await Rule.find({ project: project._id, enabled: true }).sort({ order: 1, createdAt: 1 }).lean();
    for (const rule of rules) {
      if (triggered(rule.trigger, events, ticket) && conditionsHold(rule.conditions ?? {}, ticket)) {
        await applyRule(project, ticket, rule);
      }
    }
  } catch (err) {
    console.error('Automation rules failed:', err);
  }
}
