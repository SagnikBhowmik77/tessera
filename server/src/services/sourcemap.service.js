import mongoose from 'mongoose';
import { SourceMapConsumer } from 'source-map-js';
import { HttpError } from '../errors.js';
import { ErrorOccurrence, SourceMap, Ticket, TicketEvent } from '../models/index.js';
import { fingerprintOf } from '../bugs/stacktrace.js';

// Source maps (E6B): a team uploads the .map files of a release (from Settings, or from CI with
// an upload token), and crashes from that release's minified scripts are shown with the original
// files, lines and function names. Nothing is guessed: a frame is only changed when a map for
// that exact script says where it came from; otherwise it stays as it was sent.

export const MAX_MAP_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 20;
export const MAX_MAPS_PER_PROJECT = 300;
const BUCKET = 'sourcemaps';
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

const basename = (f) => String(f ?? '').split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop();
// Built files whose name carries a content hash are unique to one build, so they can be matched
// even when a crash doesn't say which release it came from.
const HASHED = /[.-][0-9a-zA-Z_-]{8,}\.(?:m?js|cjs)$/;

// ---------- upload ----------

// Reads and checks one .map file. Returns { file, raw }.
export function readMap(buf, uploadName) {
  const name = basename(uploadName) || 'map';
  let raw;
  try { raw = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'not_a_map', `${name} is not a source map (it isn't JSON)`); }
  if (raw?.version !== 3 || (typeof raw.mappings !== 'string' && !Array.isArray(raw.sections))) {
    throw new HttpError(400, 'not_a_map', `${name} is not a version 3 source map`);
  }
  try { new SourceMapConsumer(raw); } catch (e) { throw new HttpError(400, 'not_a_map', `${name} could not be read: ${e.message}`); }
  const file = basename(raw.file) || name.replace(/\.map$/i, '');
  if (!/\.(?:m?js|cjs)$/i.test(file)) {
    throw new HttpError(400, 'unknown_script', `${name}: can't tell which script it belongs to. Name it like app.4f9a2c1e.js.map, or keep the "file" field in the map.`);
  }
  return { file, raw };
}

export async function uploadMaps(project, actor, release, files) {
  const rel = String(release ?? '').trim();
  if (!rel || rel.length > 100) throw new HttpError(400, 'release_required', 'Say which release these maps are for (form field "release", at most 100 characters)');
  if (!files?.length) throw new HttpError(400, 'files_required', 'Choose the .map files to upload (form field "files")');
  if (files.length > MAX_FILES_PER_UPLOAD) throw new HttpError(400, 'too_many_files', `At most ${MAX_FILES_PER_UPLOAD} maps per upload`);
  // All checked before anything is stored: an upload either works completely or not at all.
  const read = files.map((f) => ({ ...readMap(f.buffer, f.originalname), name: basename(f.originalname).slice(0, 300), buffer: f.buffer }));
  const dupes = read.map((r) => r.file).filter((f, i, all) => all.indexOf(f) !== i);
  if (dupes.length) throw new HttpError(400, 'duplicate_script', `Two maps are for the same script: ${dupes[0]}`);
  const replacing = await SourceMap.countDocuments({ project: project._id, release: rel, file: { $in: read.map((r) => r.file) } });
  const total = await SourceMap.countDocuments({ project: project._id });
  if (total - replacing + read.length > MAX_MAPS_PER_PROJECT) {
    throw new HttpError(400, 'too_many_maps', `A project keeps at most ${MAX_MAPS_PER_PROJECT} maps. Delete an old release first.`);
  }

  const saved = [];
  for (const r of read) {
    const gridId = new mongoose.Types.ObjectId();
    await new Promise((resolve, reject) => {
      const stream = bucket().openUploadStreamWithId(gridId, r.name, { metadata: { project: project._id, release: rel } });
      stream.once('finish', resolve).once('error', reject);
      stream.end(r.buffer);
    });
    const old = await SourceMap.findOneAndUpdate(
      { project: project._id, release: rel, file: r.file },
      { $set: { name: r.name, size: r.buffer.length, gridId, uploadedBy: actor, uploadedAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
    if (old?.gridId) await bucket().delete(old.gridId).catch(() => {});
    if (old?._id) forget(old._id);
    saved.push({ file: r.file, name: r.name, size: r.buffer.length, replaced: Boolean(old) });
  }
  return { release: rel, maps: saved };
}

export async function listMaps(project) {
  const rows = await SourceMap.find({ project: project._id }).sort({ uploadedAt: -1 }).populate('uploadedBy', 'name').lean();
  const releases = new Map();
  for (const m of rows) {
    if (!releases.has(m.release)) releases.set(m.release, { release: m.release, size: 0, uploadedAt: m.uploadedAt, maps: [] });
    const r = releases.get(m.release);
    r.size += m.size;
    r.maps.push({ id: String(m._id), file: m.file, name: m.name, size: m.size, uploadedAt: m.uploadedAt, uploadedBy: m.uploadedBy?.name ?? null });
  }
  return { releases: [...releases.values()], count: rows.length, limit: MAX_MAPS_PER_PROJECT };
}

export async function deleteRelease(project, release) {
  const rows = await SourceMap.find({ project: project._id, release }).lean();
  if (!rows.length) throw new HttpError(404, 'release_not_found', 'No maps for that release');
  for (const m of rows) { await bucket().delete(m.gridId).catch(() => {}); forget(m._id); }
  await SourceMap.deleteMany({ project: project._id, release });
  return { release, deleted: rows.length };
}

export async function purgeSourceMaps(projectIds) {
  const rows = await SourceMap.find({ project: { $in: projectIds } }, { gridId: 1 }).lean();
  if (rows.length) {
    const ids = rows.map((r) => r.gridId);
    const { db } = mongoose.connection;
    await db.collection(`${BUCKET}.chunks`).deleteMany({ files_id: { $in: ids } });
    await db.collection(`${BUCKET}.files`).deleteMany({ _id: { $in: ids } });
  }
  await SourceMap.deleteMany({ project: { $in: projectIds } });
}

// ---------- unminifying ----------

// A few recently used maps stay parsed in memory.
const cache = new Map();
const forget = (id) => cache.delete(String(id));
async function consumerFor(doc) {
  const key = String(doc._id);
  if (cache.has(key)) {
    const c = cache.get(key);
    cache.delete(key);
    cache.set(key, c);
    return c;
  }
  const chunks = [];
  await new Promise((resolve, reject) => {
    bucket().openDownloadStream(doc.gridId).on('data', (c) => chunks.push(c)).once('error', reject).once('end', resolve);
  });
  const consumer = new SourceMapConsumer(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  cache.set(key, consumer);
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return consumer;
}

// "webpack://shop/./src/cart.js" and "../../src/cart.ts" are both "src/cart…" in the repository.
export const cleanSource = (s) => String(s ?? '')
  .replace(/^webpack:\/\/[^/]*\//, '')
  .replace(/^[a-z]+:\/\/\/?/i, '')
  .replace(/^(?:\.\.?\/)+/, '')
  .replace(/^\/+/, '');

function contextOf(consumer, source, line) {
  const text = consumer.sourceContentFor(source, true);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const cut = (l) => (l ?? '').slice(0, 200);
  return {
    pre: lines.slice(Math.max(0, line - 3), line - 1).map(cut),
    line: cut(lines[line - 1]),
    post: lines.slice(line, line + 2).map(cut),
  };
}

// Returns { error, mapped }. Frames come back with the original file, line and column, the
// minified ones kept under `minified`, and up to 5 frames of your code with surrounding lines.
// A frame's original function name comes from its caller's call site (the name being called),
// which is how a source map can tell it; the outermost frame keeps the name it was sent with.
export async function applySourceMaps(project, error, { release = null } = {}) {
  if (error.language !== 'javascript' || !error.frames?.length) return { error, mapped: 0 };
  const names = [...new Set(error.frames.map((f) => basename(f.file)).filter(Boolean))];
  if (!names.length) return { error, mapped: 0 };
  const docs = await SourceMap.find({ project: project._id, file: { $in: names } }).sort({ uploadedAt: -1 }).lean();
  if (!docs.length) return { error, mapped: 0 };
  const pick = (name) => docs.find((d) => d.file === name && release && d.release === release)
    ?? (HASHED.test(name) ? docs.find((d) => d.file === name) : null);

  // Original position of every frame, and the original name of whatever each frame was calling.
  const positions = [];
  for (const f of error.frames) {
    const doc = pick(basename(f.file));
    if (!doc || !f.line) { positions.push(null); continue; }
    const consumer = await consumerFor(doc);
    // Stack columns count from 1, source map columns from 0.
    const pos = consumer.originalPositionFor({ line: f.line, column: Math.max(0, (f.column ?? 1) - 1) });
    positions.push(pos?.source ? { pos, consumer, release: doc.release } : null);
  }
  let mapped = 0;
  let withContext = 0;
  const releases = new Set();
  const frames = error.frames.map((f, i) => {
    const hit = positions[i];
    if (!hit) return f;
    const file = cleanSource(hit.pos.source);
    const callerName = positions[i + 1]?.pos?.name;
    const frame = {
      fn: callerName || f.fn,
      file,
      line: hit.pos.line,
      column: hit.pos.column + 1,
      inApp: !/(?:^|\/)node_modules\//.test(file),
      minified: { fn: f.fn ?? null, file: f.file, line: f.line, column: f.column ?? null },
    };
    if (frame.inApp && withContext < 5) {
      const context = contextOf(hit.consumer, hit.pos.source, hit.pos.line);
      if (context) { frame.context = context; withContext += 1; }
    }
    mapped += 1;
    releases.add(hit.release);
    return frame;
  });
  if (!mapped) return { error, mapped: 0 };
  const next = { ...error, frames, unminified: { mapped, of: error.frames.length, releases: [...releases] } };
  next.fingerprint = fingerprintOf(next);
  return { error: next, mapped };
}

// The frames as they were sent (to map an older ticket again with newer maps).
export const sentFrames = (frames) => (frames ?? []).map((f) => (f.minified?.file ? { ...f.minified, inApp: true } : f));

// Maps a ticket's error again (after uploading maps it didn't have). Its fingerprint follows the
// original frames too, unless another ticket already has that one: then the two are left apart
// and the answer names the other ticket, so nobody's history is merged behind their back.
export async function remapTicket(project, ticket, actor) {
  if (!ticket.error) throw new HttpError(400, 'not_an_error', 'This ticket was not made from an error');
  const last = await ErrorOccurrence.findOne({ ticket: ticket._id, release: { $ne: null } }).sort({ at: -1 }).lean();
  const stored = ticket.error.toObject();
  const base = { ...stored, frames: sentFrames(stored.frames), unminified: null };
  const { error, mapped } = await applySourceMaps(project, base, { release: last?.release ?? null });
  if (!mapped) return { mapped: 0, sameAs: null };
  const clash = await Ticket.findOne({ project: project._id, _id: { $ne: ticket._id }, deletedAt: null, 'error.fingerprint': error.fingerprint }, { number: 1 }).lean();
  ticket.error.frames = error.frames;
  ticket.error.unminified = error.unminified;
  if (!clash) ticket.error.fingerprint = error.fingerprint;
  ticket.markModified('error');
  await ticket.save();
  await TicketEvent.create({ project: project._id, ticket: ticket._id, actor, type: 'error_unminified', to: { mapped, releases: error.unminified.releases } });
  return { mapped, sameAs: clash ? `${project.key}-${clash.number}` : null };
}
