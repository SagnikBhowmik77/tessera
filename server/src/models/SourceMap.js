import mongoose from 'mongoose';

// An uploaded source map (E6B): which release and which built script it belongs to. The map
// itself is in GridFS (bucket "sourcemaps"), since maps are often megabytes.
const sourceMapSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    release: { type: String, required: true, maxlength: 100 },
    // The built script it maps, by file name: "checkout.4f9a2c1e.js".
    file: { type: String, required: true, maxlength: 300 },
    // The uploaded file's own name: "checkout.4f9a2c1e.js.map".
    name: { type: String, required: true, maxlength: 300 },
    size: { type: Number, required: true },
    gridId: { type: mongoose.Schema.Types.ObjectId, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// Uploading the same script's map again for a release replaces it.
sourceMapSchema.index({ project: 1, release: 1, file: 1 }, { unique: true });
sourceMapSchema.index({ project: 1, file: 1 });

export const SourceMap = mongoose.models.SourceMap || mongoose.model('SourceMap', sourceMapSchema);
