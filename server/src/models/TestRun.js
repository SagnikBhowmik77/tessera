import mongoose from 'mongoose';

// One CI (or hand-uploaded) test run from a JUnit XML report (E12). Only the last 200 runs of a
// project are kept, which is plenty to spot flaky tests and stays small on the free database.
const caseSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 500 },
  suite: { type: String, maxlength: 300, default: '' },
  name: { type: String, maxlength: 300, required: true },
  status: { type: String, enum: ['passed', 'failed', 'skipped'], required: true },
  duration: { type: Number, default: null },
  message: { type: String, maxlength: 2000, default: null },
}, { _id: false });

const testRunSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, maxlength: 120, default: null },
    branch: { type: String, maxlength: 200, default: null },
    commit: { type: String, maxlength: 64, default: null },
    source: { type: String, enum: ['upload', 'ci'], required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, required: true },
    totals: { tests: Number, passed: Number, failed: Number, skipped: Number, duration: Number },
    cases: [caseSchema],
  },
  { timestamps: true, versionKey: false },
);
testRunSchema.index({ project: 1, at: -1 });
export const TestRun = mongoose.models.TestRun || mongoose.model('TestRun', testRunSchema);
