import path from 'node:path';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { Attachment, TicketEvent } from '../models/index.js';
import { roleAtLeast } from './project.service.js';
import { HarError, sanitizeHar } from '../debug/har.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PER_TICKET = 20;
const BUCKET = 'attachments';

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.json', '.csv', '.md', '.har', '.xml', '.yaml', '.yml']);

// Decides what a file really is from its first bytes. The browser's claimed type and the
// extension are not trusted (a "screenshot.png" could be HTML). SVG is refused on purpose:
// it can carry scripts. Returns { contentType } or null.
export function sniff(buf, name) {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg' };
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return { contentType: 'image/gif' };
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return { contentType: 'image/webp' };
  if (startsWith(buf, ascii('%PDF-'))) return { contentType: 'application/pdf' };
  if (startsWith(buf, ascii('ftyp'), 4)) return { contentType: 'video/mp4' };
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { contentType: 'video/webm' };

  // Logs and other text: must be valid UTF-8 with no NUL bytes. Always downloaded, never rendered.
  const ext = path.extname(name).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) || buf.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  return { contentType: ext === '.json' || ext === '.har' ? 'application/json' : 'text/plain; charset=utf-8' };
}

// Keeps just the file name, without folders or control characters.
function cleanName(raw) {
  const base = path.basename(String(raw || 'file').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (base || 'file').slice(0, 200);
}

const ticketDeleted = () => new HttpError(409, 'ticket_deleted', 'This ticket is deleted. Restore it first.');

export async function listAttachments(ticket) {
  const rows = await Attachment.find({ ticket: ticket._id }).sort({ createdAt: 1 }).populate('uploader', 'name email');
  return rows.map((a) => a.toJSON());
}

export async function uploadAttachment(project, membership, ticket, file) {
  if (ticket.deletedAt) throw ticketDeleted();
  if (!file || !file.buffer?.length) throw new HttpError(400, 'file_required', 'Choose a file to attach (form field "file")');
  const name = cleanName(file.originalname);
  const kind = sniff(file.buffer, name);
  if (!kind) {
    throw new HttpError(415, 'unsupported_type',
      'Attach images (PNG, JPEG, GIF, WebP), PDFs, videos (MP4, WebM) or text logs (.txt, .log, .json, .csv, .md, .har)');
  }
  // A HAR records cookies, tokens and response bodies: only a cleaned copy is ever stored (E12).
  let buffer = file.buffer;
  let cleaned = null;
  if (name.toLowerCase().endsWith('.har')) {
    try { ({ buffer, removed: cleaned } = sanitizeHar(file.buffer)); } catch (e) {
      if (e instanceof HarError) throw new HttpError(422, 'bad_har', e.message);
      throw e;
    }
  }
  if (await Attachment.countDocuments({ ticket: ticket._id }) >= MAX_PER_TICKET) {
    throw new HttpError(409, 'too_many_attachments', `A ticket can have at most ${MAX_PER_TICKET} attachments`);
  }
  // The free database is shared, so each project has a storage allowance.
  const [{ used = 0 } = {}] = await Attachment.aggregate([
    { $match: { project: project._id } },
    { $group: { _id: null, used: { $sum: '$size' } } },
  ]);
  if (used + buffer.length > config.attachments.projectQuotaBytes) {
    const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
    throw new HttpError(413, 'quota_exceeded',
      `This project has used ${mb(used)} MB of its ${mb(config.attachments.projectQuotaBytes)} MB for attachments. Delete some to make room.`);
  }

  const fileId = new mongoose.Types.ObjectId();
  await new Promise((resolve, reject) => {
    const stream = bucket().openUploadStreamWithId(fileId, name, {
      metadata: { project: project._id, ticket: ticket._id, contentType: kind.contentType },
    });
    stream.once('finish', resolve).once('error', reject);
    stream.end(buffer);
  });

  const attachment = await Attachment.create({
    project: project._id, ticket: ticket._id, uploader: membership.user,
    name, contentType: kind.contentType, size: buffer.length, fileId, cleaned,
  });
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor: membership.user, type: 'attachment_added',
    to: { attachment: attachment._id, name }, at: attachment.createdAt,
  });
  await attachment.populate('uploader', 'name email');
  return attachment.toJSON();
}

async function findAttachment(ticket, attachmentId) {
  const attachment = await Attachment.findOne({ _id: attachmentId, ticket: ticket._id });
  if (!attachment) throw new HttpError(404, 'attachment_not_found', 'Attachment not found');
  return attachment;
}

// The whole file in memory (attachments are at most 10 MB), for the log viewer and HAR analysis.
export async function readAttachment(ticket, attachmentId) {
  const attachment = await findAttachment(ticket, attachmentId);
  const chunks = [];
  await new Promise((resolve, reject) => {
    bucket().openDownloadStream(attachment.fileId).on('data', (c) => chunks.push(c)).once('error', reject).once('end', resolve);
  });
  return { attachment, buffer: Buffer.concat(chunks) };
}

// Streams the file. Images, PDFs and videos may show in the browser; text always downloads.
// The sandbox policy stops anything inside a file from running as part of the app.
export async function sendAttachment(ticket, attachmentId, res) {
  const attachment = await findAttachment(ticket, attachmentId);
  const inline = !attachment.contentType.startsWith('text/') && attachment.contentType !== 'application/json';
  res.set({
    'Content-Type': attachment.contentType,
    'Content-Length': String(attachment.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
    'Cache-Control': 'private, no-store',
  });
  await new Promise((resolve, reject) => {
    bucket().openDownloadStream(attachment.fileId).once('error', reject).once('end', resolve).pipe(res);
  });
}

// The uploader removes their own; managers and admins can remove any.
export async function deleteAttachment(project, membership, ticket, attachmentId) {
  const attachment = await findAttachment(ticket, attachmentId);
  const mine = attachment.uploader && String(attachment.uploader) === String(membership.user);
  if (!mine && !roleAtLeast(membership.role, 'manager')) {
    throw new HttpError(403, 'forbidden', 'You can remove files you attached. Managers can remove any file.');
  }
  await bucket().delete(attachment.fileId).catch((err) => {
    if (!/FileNotFound/i.test(err.message)) throw err;
  });
  await Attachment.deleteOne({ _id: attachment._id });
  await TicketEvent.create({
    project: project._id, ticket: ticket._id, actor: membership.user, type: 'attachment_removed',
    from: { attachment: attachment._id, name: attachment.name },
  });
}

// Used when whole projects are deleted.
export async function purgeAttachments(projectIds) {
  const files = await Attachment.find({ project: { $in: projectIds } }, { fileId: 1 }).lean();
  const ids = files.map((f) => f.fileId);
  if (ids.length) {
    const db = mongoose.connection.db;
    await db.collection(`${BUCKET}.chunks`).deleteMany({ files_id: { $in: ids } });
    await db.collection(`${BUCKET}.files`).deleteMany({ _id: { $in: ids } });
  }
  await Attachment.deleteMany({ project: { $in: projectIds } });
}
