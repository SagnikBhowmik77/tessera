import { HttpError } from '../errors.js';
import { DEFAULT_STATUSES, ProjectInvite, Recurrence, Rule, Template, Ticket } from '../models/index.js';

// Project setup (E4D): starting templates, the team's label list, what board cards show, and
// the setup checklist.

// Starting points for a new project: columns (with WIP limits where they help) and labels.
// Nothing else: no example tickets, people or dates.
export const SETUP_TEMPLATES = {
  kanban: {
    name: 'Software Kanban',
    description: 'Continuous flow with a review step and WIP limits on the busy columns.',
    columns: [
      { key: 'backlog', name: 'Backlog', category: 'todo' },
      { key: 'todo', name: 'To Do', category: 'todo' },
      { key: 'in_progress', name: 'In Progress', category: 'in_progress', wipLimit: 5 },
      { key: 'in_review', name: 'In Review', category: 'in_progress', wipLimit: 3 },
      { key: 'done', name: 'Done', category: 'done' },
    ],
    labels: ['frontend', 'backend', 'tech-debt', 'docs'],
  },
  scrum: {
    name: 'Scrum',
    description: 'Sprint work with testing before done. Plan sprints in the Sprints tab.',
    columns: [
      { key: 'todo', name: 'To Do', category: 'todo' },
      { key: 'in_progress', name: 'In Progress', category: 'in_progress' },
      { key: 'testing', name: 'Testing', category: 'in_progress' },
      { key: 'done', name: 'Done', category: 'done' },
    ],
    labels: ['story', 'spike', 'tech-debt'],
  },
  bugs: {
    name: 'Bug tracking',
    description: 'Reports come in, get confirmed, fixed and verified.',
    columns: [
      { key: 'new', name: 'New', category: 'todo' },
      { key: 'confirmed', name: 'Confirmed', category: 'todo' },
      { key: 'fixing', name: 'Fixing', category: 'in_progress', wipLimit: 5 },
      { key: 'verifying', name: 'Verifying', category: 'in_progress' },
      { key: 'fixed', name: 'Fixed', category: 'done' },
      { key: 'wont_fix', name: "Won't fix", category: 'done' },
    ],
    labels: ['crash', 'ui', 'performance', 'regression', 'needs-info'],
  },
  support: {
    name: 'Support desk',
    description: 'Customer requests (pairs well with the public bug page), with a step for waiting on the customer.',
    columns: [
      { key: 'new', name: 'New', category: 'todo' },
      { key: 'working', name: 'Working on it', category: 'in_progress' },
      { key: 'waiting', name: 'Waiting on customer', category: 'in_progress' },
      { key: 'solved', name: 'Solved', category: 'done' },
    ],
    labels: ['question', 'billing', 'account', 'feature-request'],
  },
  content: {
    name: 'Content calendar',
    description: 'Ideas through drafting and editing to published.',
    columns: [
      { key: 'ideas', name: 'Ideas', category: 'todo' },
      { key: 'drafting', name: 'Drafting', category: 'in_progress', wipLimit: 4 },
      { key: 'editing', name: 'Editing', category: 'in_progress' },
      { key: 'scheduled', name: 'Scheduled', category: 'in_progress' },
      { key: 'published', name: 'Published', category: 'done' },
    ],
    labels: ['blog', 'social', 'newsletter', 'video'],
  },
};

export const listSetupTemplates = () => Object.entries(SETUP_TEMPLATES).map(([key, t]) => ({ key, ...t }));

// The fields of a project created from a template.
export function fromTemplate(key) {
  if (!key) return {};
  const t = SETUP_TEMPLATES[key];
  if (!t) throw new HttpError(400, 'unknown_template', 'There is no such project template');
  return {
    statuses: t.columns.map((c) => ({ wipLimit: null, ...c })),
    suggestedLabels: [...t.labels],
    setupTemplate: key,
  };
}

// The team's own label list: offered when labelling tickets, even before any ticket uses them.
export async function setSuggestedLabels(project, labels) {
  project.suggestedLabels = [...new Set(labels)];
  await project.save();
  return project.suggestedLabels;
}

// What board cards show. Built-in parts, plus up to 3 custom fields as "field:<key>".
export const CARD_PARTS = ['key', 'type', 'priority', 'labels', 'due', 'assignee', 'points', 'subtasks', 'epic', 'sla', 'blocked', 'age', 'errors', 'links'];
export const DEFAULT_CARD = CARD_PARTS.filter((p) => p !== 'points');

export async function setCardLayout(project, fields) {
  const custom = new Set((project.customFields ?? []).map((f) => `field:${f.key}`));
  const bad = fields.filter((f) => !CARD_PARTS.includes(f) && !custom.has(f));
  if (bad.length) throw new HttpError(400, 'card_layout', `Unknown card parts: ${bad.join(', ')}`);
  if (fields.filter((f) => f.startsWith('field:')).length > 3) throw new HttpError(400, 'card_layout', 'Cards can show up to 3 custom fields');
  project.cardFields = [...new Set(fields)];
  await project.save();
  return project.cardFields;
}

const sameAsDefault = (statuses) => statuses.length === DEFAULT_STATUSES.length
  && statuses.every((s, i) => s.key === DEFAULT_STATUSES[i].key && s.name === DEFAULT_STATUSES[i].name && !s.wipLimit);

// The setup checklist, worked out from what the project really has, so it can't drift.
export async function setupChecklist(project) {
  const p = project._id;
  const [invites, assigned, finished, rule, template, recurring, labelled] = await Promise.all([
    ProjectInvite.countDocuments({ project: p, acceptedAt: null, expiresAt: { $gt: new Date() } }),
    Ticket.exists({ project: p, deletedAt: null, assignee: { $ne: null } }),
    Ticket.exists({ project: p, deletedAt: null, resolvedAt: { $ne: null } }),
    Rule.exists({ project: p }),
    Template.exists({ project: p }),
    Recurrence.exists({ project: p }),
    Ticket.exists({ project: p, deletedAt: null, 'labels.0': { $exists: true } }),
  ]);
  const steps = [
    { key: 'columns', title: 'Set up your columns', hint: 'Rename, add or reorder columns and set WIP limits to match how your team works.', to: 'settings', done: Boolean(project.setupTemplate) || !sameAsDefault(project.statuses) },
    { key: 'labels', title: 'Add the labels you use', hint: 'Offered whenever someone labels a ticket, such as "frontend" or "billing".', to: 'settings', done: (project.suggestedLabels?.length ?? 0) > 0 || Boolean(labelled) },
    { key: 'invite', title: 'Invite your team', hint: 'Send an invite from Settings.', to: 'settings', done: project.members.length > 1 || invites > 0 },
    { key: 'ticket', title: 'Create the first ticket', hint: 'Use "New ticket" at the top of the board.', to: 'board', done: project.ticketCounter > 0 },
    { key: 'assign', title: 'Assign a ticket to someone', hint: 'So everyone knows who is on what.', to: 'board', done: Boolean(assigned) },
    { key: 'automate', title: 'Save a routine step', hint: 'A ticket template, a recurring ticket or an automation rule, in Settings.', to: 'settings', done: Boolean(rule || template || recurring) },
    { key: 'finish', title: 'Finish a ticket', hint: 'Move one into a done column.', to: 'board', done: Boolean(finished) },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, dismissedAt: project.checklistDismissedAt ?? null };
}

export async function dismissChecklist(project, dismissed) {
  project.checklistDismissedAt = dismissed ? new Date() : null;
  await project.save();
  return setupChecklist(project);
}
