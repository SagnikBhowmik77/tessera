import mongoose from 'mongoose';

// Live collaboration II (E10): planning poker rounds, retro boards and incidents.
const { ObjectId } = mongoose.Schema.Types;

const pokerSchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    ticket: { type: ObjectId, ref: 'Ticket', required: true },
    status: { type: String, enum: ['voting', 'revealed', 'done', 'cancelled'], default: 'voting' },
    votes: [new mongoose.Schema({ user: { type: ObjectId, ref: 'User' }, value: String, at: Date }, { _id: false })],
    startedBy: { type: ObjectId, ref: 'User', default: null },
    accepted: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false },
);
pokerSchema.index({ project: 1, status: 1 });
export const PokerRound = mongoose.models.PokerRound || mongoose.model('PokerRound', pokerSchema);

export const RETRO_COLUMNS = [
  { key: 'went_well', name: 'Went well' },
  { key: 'to_improve', name: 'To improve' },
  { key: 'actions', name: 'Actions' },
];
const retroItemSchema = new mongoose.Schema({
  column: { type: String, enum: RETRO_COLUMNS.map((c) => c.key), required: true },
  text: { type: String, required: true, maxlength: 500 },
  author: { type: ObjectId, ref: 'User', default: null },
  votes: [{ type: ObjectId, ref: 'User' }],
  ticket: { type: Number, default: null },
  at: { type: Date, default: Date.now },
});
const retroSchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    sprint: { type: ObjectId, ref: 'Sprint', default: null },
    title: { type: String, required: true, maxlength: 120 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    votesPerPerson: { type: Number, default: 3, min: 1, max: 10 },
    items: [retroItemSchema],
    createdBy: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
);
retroSchema.index({ project: 1, createdAt: -1 });
export const Retro = mongoose.models.Retro || mongoose.model('Retro', retroSchema);

const incidentSchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    ticket: { type: ObjectId, ref: 'Ticket', required: true },
    title: { type: String, required: true, maxlength: 200 },
    severity: { type: String, enum: ['sev1', 'sev2', 'sev3'], default: 'sev2' },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    commander: { type: ObjectId, ref: 'User', default: null },
    startedAt: { type: Date, required: true },
    resolvedAt: { type: Date, default: null },
    timeline: [new mongoose.Schema({ at: Date, kind: { type: String, enum: ['started', 'note', 'commander', 'severity', 'resolved'] }, text: String, author: { type: ObjectId, ref: 'User', default: null } }, { _id: false })],
    rootCause: { type: String, maxlength: 5000, default: '' },
    lessons: { type: String, maxlength: 5000, default: '' },
    followUps: [{ type: Number }],
  },
  { timestamps: true, versionKey: false },
);
incidentSchema.index({ project: 1, status: 1, startedAt: -1 });
export const Incident = mongoose.models.Incident || mongoose.model('Incident', incidentSchema);
