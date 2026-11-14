import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requireDb } from '../db.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/outside.controller.js';
import { portalReportSchema, portalTokenParams, roadmapItemParams, roadmapParams, sharedParams, trackAnswerSchema, trackMessageSchema, trackParams, voterHeader } from '../schemas/outside.schemas.js';
import * as tracking from '../services/tracking.service.js';
import * as board from '../services/publicboard.service.js';
import { handleGitlab } from '../services/gitlab.service.js';

// The public bug-report page. No login: the unguessable token in the link is the access.
export function portalRouter() {
  const router = Router();
  router.use(requireDb);
  const limit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.rateLimit.portalMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many reports from this network. Try again in an hour.')),
  });
  const p = validate({ params: portalTokenParams });
  router.get('/:token', p, ctrl.portalInfo);
  router.get('/:token/logo', p, ctrl.publicLogo);
  router.post('/:token/reports', p, limit, validate({ body: portalReportSchema }), ctrl.portalReport);
  return router;
}

// Incoming webhooks. Mounted before the JSON body parser: the GitHub signature is checked
// against the exact bytes GitHub sent.
export function hooksRouter() {
  const router = Router();
  router.use(requireDb);
  router.post('/github/:projectId', express.raw({ type: '*/*', limit: '2mb' }), ctrl.githubHook);
  router.post('/gitlab/:projectId', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    res.json(await handleGitlab(req.params.projectId, req.headers, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
  });
  return router;
}

const hourly = (limit, message) => rateLimit({
  windowMs: 60 * 60 * 1000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', message)),
});

// A reporter's private tracking page (E11). The token in the link is the access.
export function trackRouter() {
  const router = Router();
  router.use(requireDb);
  const p = validate({ params: trackParams });
  const limit = hourly(60, 'Too many messages from this network. Try again in an hour.');
  router.get('/:token', p, async (req, res) => res.json({ report: await tracking.trackView(req.valid.params.token) }));
  router.post('/:token/messages', p, limit, validate({ body: trackMessageSchema }), async (req, res) => res.status(201).json({ report: await tracking.reporterMessage(req.valid.params.token, req.valid.body.body) }));
  router.post('/:token/answer', p, limit, validate({ body: trackAnswerSchema }), async (req, res) => res.json({ report: await tracking.reporterAnswer(req.valid.params.token, req.valid.body.answer) }));
  return router;
}

// The public roadmap (E11). Votes belong to a random id the browser sends in a header.
export function roadmapRouter() {
  const router = Router();
  router.use(requireDb);
  const voter = (req, required) => {
    const v = req.get('x-roadmap-voter');
    if (!v && !required) return null;
    const r = voterHeader.safeParse(v);
    if (!r.success) throw new HttpError(400, 'invalid_voter', 'Missing or invalid voter id');
    return r.data;
  };
  router.get('/:token', validate({ params: roadmapParams }), async (req, res) => res.json(await board.publicRoadmap(req.valid.params.token, voter(req, false))));
  router.post('/:token/items/:number/vote', validate({ params: roadmapItemParams }), hourly(300, 'Too many votes from this network. Try again in an hour.'),
    async (req, res) => res.json(await board.toggleVote(req.valid.params.token, req.valid.params.number, voter(req, true))));
  return router;
}

// A read-only board shared by link (E11).
export function sharedRouter() {
  const router = Router();
  router.use(requireDb);
  router.get('/:token', validate({ params: sharedParams }), hourly(600, 'Too many requests. Try again in an hour.'), async (req, res) => res.json(await board.sharedBoard(req.valid.params.token)));
  return router;
}
