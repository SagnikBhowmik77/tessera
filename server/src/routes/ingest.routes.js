import express, { Router } from 'express';
import { readFileSync } from 'node:fs';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requireDb } from '../db.js';
import { publish } from '../realtime.js';
import multer from 'multer';
import { findByKey, ingest } from '../services/ingest.service.js';
import { submitWidget } from '../services/widget.service.js';
import { badge, deploySchema, publicStatus, recordDeployment } from '../services/deploy.service.js';
import { MAX_FILES_PER_UPLOAD, MAX_MAP_BYTES, uploadMaps } from '../services/sourcemap.service.js';
import { Project } from '../models/index.js';
import { importTestRun } from '../services/debug.service.js';
import { testRunFields } from '../schemas/project.schemas.js';

// Crash capture (E6A). Mounted before the app's own CORS rules: any website may send crashes
// (the ingest key decides which project, and can be limited to some websites), and the SDK
// script can be loaded from any page.

export function ingestRouter() {
  const router = Router();
  // No cookies or logins here, so allowing every origin gives nothing away.
  router.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(requireDb);
  const limit = rateLimit({
    windowMs: 60 * 1000,
    limit: config.rateLimit.ingestMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many crash reports from this network. Try again in a minute.')),
  });
  // The SDK sends text/plain so browsers skip the extra preflight request; JSON works too.
  router.post('/', limit, express.text({ type: () => true, limit: '64kb' }), async (req, res) => {
    let body;
    try { body = JSON.parse(req.body || ''); } catch { throw new HttpError(400, 'bad_json', 'Send the crash as JSON'); }
    const result = await ingest(body, { origin: req.get('origin'), userAgent: req.get('user-agent') });
    if (result.ticket) publish(result.projectId, 'ticket', { action: result.grouped ? 'updated' : 'created', actorId: null, ticket: result.ticket });
    // Nothing about the project goes back to the sender.
    res.status(202).json({ received: result.received, ...(result.ignored && { ignored: result.ignored }) });
  });
  return router;
}

const SDK = readFileSync(new URL('../../sdk/tessera.js', import.meta.url), 'utf8');
const WIDGET = readFileSync(new URL('../../sdk/widget.js', import.meta.url), 'utf8');

export function sdkRouter() {
  const router = Router();
  router.get('/widget.js', (_req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.send(WIDGET);
  });
  router.get('/tessera.js', (_req, res) => {
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      // Loaded by <script> on other websites.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(SDK);
  });
  return router;
}

// Source maps (E6B). Multer's own errors become plain answers about maps.
export function mapsUpload(req, res, next) {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MAP_BYTES, files: MAX_FILES_PER_UPLOAD, fields: 5 } })
    .array('files', MAX_FILES_PER_UPLOAD)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'too_large', 'Each source map can be up to 5 MB'));
      if (err.name === 'MulterError') return next(new HttpError(400, 'bad_upload', `Send the maps in the form field "files" (at most ${MAX_FILES_PER_UPLOAD})`));
      return next(err);
    });
}

// From CI: "Authorization: Bearer tsu_...", multipart with "release" and "files".
export function sourcemapRouter() {
  const router = Router();
  router.use(requireDb);
  router.post('/', async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    req.upload = await findByKey(header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '', 'upload');
    next();
  }, mapsUpload, async (req, res) => {
    const { project, k } = req.upload;
    const result = await uploadMaps(project, null, req.body?.release, req.files);
    await Project.updateOne({ _id: project._id, 'ingestKeys._id': k._id }, { $set: { 'ingestKeys.$.lastUsedAt': new Date() }, $inc: { 'ingestKeys.$.received': result.maps.length } });
    res.status(201).json(result);
  });
  return router;
}

// The report button (E6C). Open CORS like crash capture; the portal's own website list decides.
export function widgetRouter() {
  const router = Router();
  router.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(requireDb);
  const limit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.rateLimit.portalMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many reports from this network. Try again in an hour.')),
  });
  router.post('/:token', limit, express.text({ type: () => true, limit: '5mb' }), async (req, res) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) throw new HttpError(404, 'widget_off', 'The report button is not turned on for this project');
    let body;
    try { body = JSON.parse(req.body || ''); } catch { throw new HttpError(400, 'bad_json', 'Send the report as JSON'); }
    const { projectId, ticket, ...result } = await submitWidget(req.params.token, body, { origin: req.get('origin'), userAgent: req.get('user-agent') });
    publish(projectId, 'ticket', { action: result.alreadyKnown ? 'updated' : 'created', actorId: null, ticket });
    res.status(201).json(result);
  });
  return router;
}

// Deploy hook (E8): "Authorization: Bearer tsd_...", JSON { release, sha?, environment?, status? }.
export function deployRouter() {
  const router = Router();
  router.use(requireDb);
  router.post('/', express.json({ limit: '20kb' }), async (req, res) => {
    const header = req.get('authorization') ?? '';
    const { project, k } = await findByKey(header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '', 'deploy');
    const parsed = deploySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Check the deploy');
    const result = await recordDeployment(project, parsed.data, { source: 'hook' });
    await Project.updateOne({ _id: project._id, 'ingestKeys._id': k._id }, { $set: { 'ingestKeys.$.lastUsedAt': new Date() }, $inc: { 'ingestKeys.$.received': 1 } });
    res.status(201).json(result);
  });
  return router;
}

// Public status page data and README badge (E8).
export function statusRouter() {
  const router = Router();
  router.use(requireDb);
  router.get('/:token/badge.svg', async (req, res) => {
    const svg = await badge(Project, req.params.token, String(req.query.show ?? 'status'));
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.send(svg);
  });
  router.get('/:token', async (req, res) => {
    const { project, ...status } = await publicStatus(Project, req.params.token);
    res.json(status);
  });
  return router;
}

// CI test results (E12): POST /api/test-results with "Authorization: Bearer tsu_..." and a
// multipart JUnit XML "file", plus optional branch, commit and name fields.
export function testResultsRouter() {
  const router = Router();
  router.use(requireDb);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } }).single('file');
  router.post('/', async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    req.upload = await findByKey(header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '', 'upload');
    next();
  }, upload, async (req, res) => {
    const { project, k } = req.upload;
    if (!req.file) throw new HttpError(400, 'file_required', 'Send the JUnit XML report as the multipart field "file"');
    const fields = testRunFields.safeParse(req.body ?? {});
    if (!fields.success) throw new HttpError(400, 'validation_failed', fields.error.issues[0].message);
    const run = await importTestRun(project, { ...fields.data, xml: req.file.buffer.toString('utf8'), source: 'ci' });
    await Project.updateOne({ _id: project._id, 'ingestKeys._id': k._id }, { $set: { 'ingestKeys.$.lastUsedAt': new Date() }, $inc: { 'ingestKeys.$.received': 1 } });
    res.status(201).json({ run });
  });
  return router;
}
