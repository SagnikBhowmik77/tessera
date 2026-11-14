import mongoose from 'mongoose';

// A file on a ticket (screenshot, screen recording, log, PDF). The bytes live in MongoDB
// GridFS (bucket "attachments"); this row is the metadata the app lists and checks.
const attachmentSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, required: true, maxlength: 200 },
    // Worked out from the file's own bytes, never trusted from the browser.
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // HAR files (E12): what was stripped before storing, e.g. { cookies: 12, headers: 3, ... }.
    cleaned: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.project;
        delete ret.fileId;
        ret.ticket = String(ret.ticket);
        return ret;
      },
    },
  },
);

attachmentSchema.index({ ticket: 1, createdAt: 1 });
attachmentSchema.index({ project: 1 });

export const Attachment = mongoose.models.Attachment || mongoose.model('Attachment', attachmentSchema);
