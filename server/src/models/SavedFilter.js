import mongoose from 'mongoose';

// A named ticket view, e.g. "My open bugs". `query` holds the same filters the ticket
// list takes (as strings), so opening a saved filter is just running that query.
// Shared filters show up for everyone in the project.
const savedFilterSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    query: { type: mongoose.Schema.Types.Mixed, required: true },
    shared: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.project;
        return ret;
      },
    },
  },
);

savedFilterSchema.index({ project: 1, owner: 1, name: 1 }, { unique: true });
savedFilterSchema.index({ project: 1, shared: 1 });

export const SavedFilter = mongoose.models.SavedFilter || mongoose.model('SavedFilter', savedFilterSchema);
