import mongoose from 'mongoose';

// The project audit log (E4C): who changed the project's setup, and when. Ticket edits are not
// here (every ticket has its own history); this covers members, invites, columns, fields,
// templates, schedules, rules, SLA targets, sprints, integrations, and bulk work, imports and
// exports. Entries are only ever added. They are kept for a year.
const auditEntrySchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // e.g. 'member.role_changed', 'rule.created' (see services/audit.service.js).
    action: { type: String, required: true, maxlength: 60 },
    // What it was done to, in words ("Weekly dependency update", "asha@…").
    target: { type: String, maxlength: 200, default: null },
    // Small facts about the change (new role, columns, counts). Never secrets.
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, default: Date.now, required: true },
  },
  {
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.project;
        return ret;
      },
    },
  },
);

auditEntrySchema.index({ project: 1, at: -1 });
auditEntrySchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

export const AuditEntry = mongoose.models.AuditEntry || mongoose.model('AuditEntry', auditEntrySchema);
