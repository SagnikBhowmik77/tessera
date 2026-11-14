import mongoose from 'mongoose';

// What each role may do is enforced by the permission middleware (step 3):
// admin: everything incl. members and deleting the project; manager: members (not admins) and any ticket;
// developer: create tickets and edit their own or assigned ones; viewer: read and comment only.
export const ROLES = ['admin', 'manager', 'developer', 'viewer'];

// Every status belongs to one of three categories, so analytics (cycle time, "done") work
// even after a team renames or adds columns.
export const STATUS_CATEGORIES = ['todo', 'in_progress', 'done'];
// The accent colours a public report page can wear (the client holds each one's light and dark step).
export const PORTAL_ACCENTS = ['violet', 'rose', 'amber', 'green', 'teal', 'blue', 'orange', 'graphite'];

// The brief's three Kanban columns. Teams can add their own (e.g. "In Review") later.
export const DEFAULT_STATUSES = [
  { key: 'todo', name: 'To Do', category: 'todo' },
  { key: 'in_progress', name: 'In Progress', category: 'in_progress' },
  { key: 'done', name: 'Done', category: 'done' },
];

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const statusSchema = new mongoose.Schema(
  {
    // Stable id used on tickets; renaming a column changes `name` only.
    key: { type: String, required: true, match: /^[a-z0-9_]{1,32}$/ },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    category: { type: String, enum: STATUS_CATEGORIES, required: true },
    // Most tickets allowed in this column at once (flow analytics, step 9); null = no limit.
    wipLimit: { type: Number, min: 1, default: null },
  },
  { _id: false },
);

// A custom field (E4B). `key` is stable (ticket values are stored under it); the name can change.
const customFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, match: /^[a-z0-9_]{1,32}$/ },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    type: { type: String, enum: ['text', 'number', 'select', 'date', 'checkbox', 'url'], required: true },
    options: { type: [{ type: String, trim: true, maxlength: 40 }], default: [] },
  },
  { _id: false },
);

// A service-level target (E4C): hours from creation to first response / to resolution.
const slaTargetSchema = new mongoose.Schema(
  {
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
    responseHours: { type: Number, min: 1, default: null },
    resolveHours: { type: Number, min: 1, default: null },
  },
  { _id: false },
);

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Short prefix for ticket numbers: TES-12. Unique per owner, not globally,
    // so one team's choice never blocks another's.
    key: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z][A-Z0-9]{1,5}$/ },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: {
      type: [memberSchema],
      validate: { validator: (m) => m.length > 0, message: 'A project needs at least one member' },
    },
    statuses: {
      type: [statusSchema],
      default: () => DEFAULT_STATUSES.map((s) => ({ ...s })),
      validate: [
        { validator: (s) => s.length >= 2, message: 'A project needs at least two statuses' },
        { validator: (s) => new Set(s.map((x) => x.key)).size === s.length, message: 'Status keys must be unique' },
        { validator: (s) => s.some((x) => x.category === 'done'), message: 'At least one status must count as done' },
      ],
    },
    customFields: {
      type: [customFieldSchema],
      default: [],
      validate: { validator: (f) => f.length <= 20, message: 'At most 20 custom fields' },
    },
    // Project setup (E4D): the template it was created from, the team's label list (offered when
    // labelling), what board cards show, and when the setup checklist was put away.
    setupTemplate: { type: String, default: null },
    suggestedLabels: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],
      default: [],
      validate: { validator: (l) => l.length <= 50, message: 'At most 50 labels' },
    },
    cardFields: {
      type: [String],
      default: () => ['key', 'type', 'priority', 'labels', 'due', 'assignee', 'subtasks', 'epic', 'sla', 'blocked', 'age', 'errors', 'links'],
    },
    checklistDismissedAt: { type: Date, default: null },
    sla: {
      enabled: { type: Boolean, default: false },
      targets: { type: [slaTargetSchema], default: [] },
    },
    // Last ticket number handed out; incremented atomically when a ticket is created.
    ticketCounter: { type: Number, default: 0, min: 0 },
    archivedAt: { type: Date, default: null },
    // The team or company this project belongs to (E14), if any.
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
    // Public bug-report page (step 10). The token is the unguessable part of the public link;
    // rotating it retires the old link.
    portal: {
      enabled: { type: Boolean, default: false },
      token: { type: String, default: null },
      intro: { type: String, trim: true, maxlength: 500, default: '' },
      // How the page looks to reporters: the name to show (the project's when empty), one of the
      // curated accent colours (each checked for contrast in the client), and the logo's version
      // (the image itself is a PortalLogo, so it never rides along when a project is loaded).
      brand: {
        name: { type: String, trim: true, maxlength: 60, default: '' },
        accent: { type: String, enum: [...PORTAL_ACCENTS, null], default: null },
        logo: { type: String, default: null },
      },
      // The report button on the team's own websites (E6C): off until turned on, only on these sites.
      widget: {
        enabled: { type: Boolean, default: false },
        origins: { type: [String], default: [] },
      },
    },
    // Public roadmap people can vote on (E11).
    roadmap: {
      enabled: { type: Boolean, default: false },
      token: { type: String, default: null },
      intro: { type: String, trim: true, maxlength: 500, default: '' },
    },
    // Read-only board links (E11). Revoking one forgets its token.
    shareLinks: {
      type: [new mongoose.Schema({
        name: { type: String, maxlength: 80, required: true },
        token: { type: String, default: null },
        showPeople: { type: Boolean, default: false },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdAt: { type: Date, default: Date.now },
        revokedAt: { type: Date, default: null },
        lastUsedAt: { type: Date, default: null },
      })],
      default: [],
    },
    // Slack / Discord alerts and outgoing webhooks (E13). Chat URLs and signing secrets are sealed.
    alerts: {
      type: [new mongoose.Schema({
        kind: { type: String, enum: ['slack', 'discord'], required: true },
        name: { type: String, maxlength: 80, required: true },
        url: { type: String, required: true },
        hint: { type: String, maxlength: 120 },
        events: [String],
        priorities: [String],
        active: { type: Boolean, default: true },
        failures: { type: Number, default: 0 },
        lastDelivery: { type: mongoose.Schema.Types.Mixed, default: null },
        createdAt: { type: Date, default: Date.now },
      })],
      default: [],
    },
    webhooks: {
      type: [new mongoose.Schema({
        name: { type: String, maxlength: 80, required: true },
        url: { type: String, maxlength: 500, required: true },
        secret: { type: String, required: true },
        events: [String],
        active: { type: Boolean, default: true },
        failures: { type: Number, default: 0 },
        lastDelivery: { type: mongoose.Schema.Types.Mixed, default: null },
        createdAt: { type: Date, default: Date.now },
      })],
      default: [],
    },
    // GitLab webhook (E13): the shared secret GitLab sends back, and an optional sealed access token.
    gitlab: {
      secret: { type: String, default: null },
      connectedAt: { type: Date, default: null },
      token: { type: String, default: null },
      tokenLogin: { type: String, default: null },
      baseUrl: { type: String, default: null },
    },
    // GitHub webhook: the shared secret GitHub signs every delivery with.
    github: {
      secret: { type: String, default: null },
      connectedAt: { type: Date, default: null },
      // A token for reading the repository and syncing issues (E7), stored encrypted.
      token: { type: String, default: null },
      tokenLogin: { type: String, default: null },
      tokenRepo: { type: String, default: null },
      canWrite: { type: Boolean, default: false },
      // Columns a ticket moves to when a branch / a pull request for it appears (null = don't move).
      moves: { branch: { type: String, default: null }, pr: { type: String, default: null } },
      issues: {
        sync: { type: Boolean, default: false },
        lastError: { type: new mongoose.Schema({ message: String, at: Date }, { _id: false }), default: null },
      },
    },
    // Crash capture keys (E6A). Only a hash of each key is kept; the key is shown once.
    ingestKeys: [new mongoose.Schema({
      name: { type: String, required: true, trim: true, maxlength: 60 },
      prefix: { type: String, required: true },
      keyHash: { type: String, required: true },
      origins: { type: [String], default: [] },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      createdAt: { type: Date, default: Date.now },
      lastUsedAt: { type: Date, default: null },
      revokedAt: { type: Date, default: null },
      received: { type: Number, default: 0 },
      // 'ingest' (tsk_, sends crashes) or 'upload' (tsu_, uploads source maps from CI), E6B.
      kind: { type: String, enum: ['ingest', 'upload', 'deploy'], default: 'ingest' },
    })],
    // Deployments (E8): which environment is production, and whether reporter "fixed" emails wait for a deploy.
    deploys: {
      production: { type: String, default: 'production', maxlength: 60 },
      emailAfterDeploy: { type: Boolean, default: false },
    },
    // Public status page and README badge (E8), off until turned on.
    statusPage: {
      enabled: { type: Boolean, default: false },
      token: { type: String, default: null },
      showCrashes: { type: Boolean, default: false },
    },
    // Where the code lives (E5B), for links from stack frames to the file and line on GitHub.
    // Set by a manager, or learned from the first GitHub webhook delivery when empty.
    source: {
      repo: { type: String, default: null },
      branch: { type: String, default: 'main' },
      pathPrefix: { type: String, default: '' },
      learnedFrom: { type: String, enum: ['manual', 'github', null], default: null },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// "Projects I'm in" is the most common query.
projectSchema.index({ 'members.user': 1, archivedAt: 1 });
projectSchema.index({ owner: 1, key: 1 }, { unique: true });
// Crash reports find their project by the hash of the ingest key.
projectSchema.index({ 'ingestKeys.keyHash': 1 }, { sparse: true });
projectSchema.index({ 'portal.token': 1 }, { unique: true, partialFilterExpression: { 'portal.token': { $type: 'string' } } });

export const Project = mongoose.models.Project || mongoose.model('Project', projectSchema);
