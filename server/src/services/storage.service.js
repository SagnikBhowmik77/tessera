import mongoose from 'mongoose';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Attachment, SourceMap, TestRun, Ticket, TicketEvent } from '../models/index.js';
import { ticketKey } from './ticket.service.js';

// Storage (E14): what a project's files take, a warning before the allowance runs out, and a list
// of what is safe to clear. The free database is small and shared, so this is worth watching.

const DAY = 86_400_000;
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'attachments' });
const sum = async (Model, match, field = '$size') => (await Model.aggregate([{ $match: match }, { $group: { _id: null, n: { $sum: field } } }]))[0]?.n ?? 0;

export async function storageSummary(project) {
  const p = project._id;
  const attachments = await sum(Attachment, { project: p });
  const sourceMaps = await sum(SourceMap, { project: p });
  // Test runs are documents, so their size is their stored size.
  const testRuns = await sum(TestRun, { project: p }, { $bsonSize: '$$ROOT' });
  const quota = config.attachments.projectQuotaBytes;
  const percent = Math.round((attachments / quota) * 1000) / 10;
  return {
    quota, used: { attachments, sourceMaps, testRuns, total: attachments + sourceMaps + testRuns },
    percent, level: percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : 'ok',
  };
}

// The biggest files, and files that are probably no longer needed: on tickets finished or
// deleted more than `days` days ago.
export async function storageReport(project, { days = 30 } = {}) {
  const summary = await storageSummary(project);
  const files = await Attachment.find({ project: project._id }, { name: 1, size: 1, ticket: 1, createdAt: 1, contentType: 1 }).sort({ size: -1 }).lean();
  const tickets = new Map((await Ticket.find({ _id: { $in: [...new Set(files.map((f) => String(f.ticket)))] } }, { number: 1, title: 1, resolvedAt: 1, deletedAt: 1 }).lean()).map((t) => [String(t._id), t]));
  const cutoff = Date.now() - days * DAY;
  const row = (f) => {
    const t = tickets.get(String(f.ticket));
    return { id: String(f._id), name: f.name, size: f.size, contentType: f.contentType, uploadedAt: f.createdAt, ticket: t ? { key: ticketKey(project, t.number), title: t.title } : null };
  };
  const stale = files.filter((f) => {
    const t = tickets.get(String(f.ticket));
    return !t || (t.deletedAt && t.deletedAt.getTime() < cutoff) || (t.resolvedAt && t.resolvedAt.getTime() < cutoff);
  });
  return {
    ...summary,
    files: files.length,
    largest: files.slice(0, 20).map(row),
    cleanup: { days, count: stale.length, bytes: stale.reduce((n, f) => n + f.size, 0), files: stale.slice(0, 100).map(row) },
  };
}

// Managers clear chosen files in one go (each one is recorded on its ticket).
export async function cleanupAttachments(project, membership, ids) {
  const files = await Attachment.find({ project: project._id, _id: { $in: ids } }).lean();
  if (!files.length) throw new HttpError(404, 'nothing_found', 'None of those files are in this project');
  for (const f of files) {
    await bucket().delete(f.fileId).catch((err) => { if (!/FileNotFound/i.test(err.message)) throw err; });
    await Attachment.deleteOne({ _id: f._id });
    await TicketEvent.create({ project: project._id, ticket: f.ticket, actor: membership.user, type: 'attachment_removed', from: { attachment: f._id, name: f.name, cleanup: true } });
  }
  return { removed: files.length, freed: files.reduce((n, f) => n + f.size, 0), storage: await storageSummary(project) };
}
