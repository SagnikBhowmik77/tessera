import mongoose from 'mongoose';

// Client-facing (E11).
const { ObjectId } = mongoose.Schema.Types;

// One outside reporter's private link to their report. The token is the whole access: it shows
// that report's progress and their own conversation with the team, nothing else. When reports are
// merged, the tracker moves to the surviving ticket, so the link keeps working.
const trackerSchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    ticket: { type: ObjectId, ref: 'Ticket', required: true },
    token: { type: String, required: true },
    name: { type: String, maxlength: 80, default: null },
    email: { type: String, maxlength: 254, default: null },
    // What they called it (the ticket may be renamed or merged into another one).
    title: { type: String, maxlength: 200, required: true },
    mergedFrom: { type: Number, default: null },
    answer: { type: new mongoose.Schema({ value: { type: String, enum: ['fixed', 'broken'] }, at: Date }, { _id: false }), default: null },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
trackerSchema.index({ token: 1 }, { unique: true });
trackerSchema.index({ ticket: 1, createdAt: 1 });
trackerSchema.index({ project: 1 });
export const Tracker = mongoose.models.Tracker || mongoose.model('Tracker', trackerSchema);

// A vote on the public roadmap. People have no account there, so a vote belongs to a random id
// their browser made, stored only as a hash; one vote per item per browser.
const roadmapVoteSchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    ticket: { type: ObjectId, ref: 'Ticket', required: true },
    voter: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
roadmapVoteSchema.index({ ticket: 1, voter: 1 }, { unique: true });
roadmapVoteSchema.index({ project: 1 });
export const RoadmapVote = mongoose.models.RoadmapVote || mongoose.model('RoadmapVote', roadmapVoteSchema);

// The logo on a project's public report page. Kept apart from the project so the image never rides
// along when a project is loaded; one per project. Only PNG, JPEG and WebP (checked by their first
// bytes, never by the name or the type the browser claims), so no script can hide in it.
const portalLogoSchema = new mongoose.Schema(
  {
    project: { type: ObjectId, ref: 'Project', required: true },
    type: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
    data: { type: Buffer, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
portalLogoSchema.index({ project: 1 }, { unique: true });
export const PortalLogo = mongoose.models.PortalLogo || mongoose.model('PortalLogo', portalLogoSchema);
