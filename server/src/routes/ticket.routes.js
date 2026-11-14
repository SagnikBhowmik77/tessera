import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/requireProject.js';
import multer from 'multer';
import * as ctrl from '../controllers/ticket.controller.js';
import * as comments from '../controllers/comment.controller.js';
import { MAX_FILE_BYTES } from '../services/attachment.service.js';
import {
  commentParams, attachmentParams, createCommentSchema, editCommentSchema, logQuery,
} from '../schemas/comment.schemas.js';
import * as bugs from '../controllers/bug.controller.js';
import * as outside from '../controllers/outside.controller.js';
import * as follow from '../controllers/follow.controller.js';
import * as relations from '../controllers/relations.controller.js';
import * as sprints from '../controllers/sprint.controller.js';
import { ticketSprintBody, ticketMilestoneBody } from '../schemas/sprint.schemas.js';
import {
  ticketParams, createTicketSchema, updateTicketSchema, moveTicketSchema, parseErrorSchema, similarSchema, snoozeSchema, muteErrorSchema, reproStepsSchema, reproAttemptSchema, reproAttemptParams,
  epicBody, parentBody, subtaskBody, blockerBody, blockerParams, flagBody, bulkSchema, importQuery,
} from '../schemas/ticket.schemas.js';
import { HttpError } from '../errors.js';
import { listTicketsQuery } from '../schemas/filter.schemas.js';
import { mergeSchema, roadmapFlagSchema } from '../schemas/outside.schemas.js';
import { findTicket } from '../services/ticket.service.js';
import { listTrackers, mergeDuplicate } from '../services/tracking.service.js';
import { setOnRoadmap } from '../services/publicboard.service.js';
import { harView, logView } from '../services/debug.service.js';

// Mounted at /api/projects/:projectId/tickets after requireProject('viewer'),
// so req.project and req.membership are already set.
export function ticketRouter() {
  const router = Router({ mergeParams: true });
  const t = validate({ params: ticketParams });
  const work = requireRole('developer', { write: true });

  router.get('/', validate({ query: listTicketsQuery }), ctrl.list);
  router.post('/', work, validate({ body: createTicketSchema }), ctrl.create);

  // Bulk work (E4A): change many tickets at once, export the list as CSV, import a CSV.
  router.post('/bulk', work, validate({ body: bulkSchema }), ctrl.bulk);
  router.get('/export', validate({ query: listTicketsQuery }), ctrl.exportCsv);
  const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024, files: 1, fields: 2 },
    fileFilter: (_req, file, cb) => (/\.csv$/i.test(file.originalname) || /csv|text\/plain|ms-excel/.test(file.mimetype)
      ? cb(null, true) : cb(new HttpError(400, 'not_csv', 'Choose a .csv file'))),
  });
  router.post('/import', work, validate({ query: importQuery }), csvUpload.single('file'), ctrl.importCsv);

  // Bug intelligence: preview a pasted error, and "this looks like TES-12" while typing.
  router.post('/parse-error', validate({ body: parseErrorSchema }), bugs.parse);
  router.post('/similar', validate({ body: similarSchema }), bugs.similar);
  // Bug intelligence II (E5A): impact, timeline, environments, fix memory; mute a known error.
  router.get('/:ref/error/insights', t, bugs.insights);
  router.put('/:ref/error/mute', t, work, validate({ body: muteErrorSchema }), bugs.mute);
  router.delete('/:ref/error/mute', t, work, bugs.unmute);
  router.post('/:ref/error/unminify', t, work, bugs.unminify);
  // GitHub (E7): PR status now, suspect commit, a GitHub issue for this ticket.
  router.post('/:ref/github/refresh', t, work, bugs.githubRefresh);
  router.post('/:ref/github/suspect', t, work, bugs.githubSuspect);
  router.post('/:ref/github/issue', t, work, bugs.githubIssue);
  // Reproduction tracking (E5B).
  router.get('/:ref/repro', t, bugs.repro);
  router.put('/:ref/repro/steps', t, work, validate({ body: reproStepsSchema }), bugs.reproSteps);
  router.post('/:ref/repro/attempts', t, work, validate({ body: reproAttemptSchema }), bugs.reproAttempt);
  router.delete('/:ref/repro/attempts/:attemptId', validate({ params: reproAttemptParams }), work, bugs.reproRemove);

  router.get('/:ref', t, ctrl.get);
  router.get('/:ref/history', t, ctrl.history);
  router.patch('/:ref', t, work, validate({ body: updateTicketSchema }), ctrl.update);
  router.post('/:ref/move', t, work, validate({ body: moveTicketSchema }), ctrl.move);
  router.delete('/:ref', t, work, ctrl.remove);
  router.post('/:ref/restore', t, work, ctrl.restore);
  // Triage inbox: accept a public-portal report onto the board (rejecting = deleting it).
  router.post('/:ref/accept', t, work, outside.accept);

  // Following (any member, viewers too): what changed since my last visit, Watch, snooze.
  router.post('/:ref/visit', t, follow.visit);
  router.put('/:ref/watch', t, follow.watch);
  router.delete('/:ref/watch', t, follow.unwatch);
  router.put('/:ref/snooze', t, validate({ body: snoozeSchema }), follow.snooze);
  router.delete('/:ref/snooze', t, follow.unsnooze);

  // Planning: epic, sub-tasks, blockers, the blocked flag (E3).
  router.get('/:ref/relations', t, relations.get);
  router.put('/:ref/epic', t, work, validate({ body: epicBody }), relations.setEpic);
  router.put('/:ref/parent', t, work, validate({ body: parentBody }), relations.setParent);
  router.post('/:ref/subtasks', t, work, validate({ body: subtaskBody }), relations.addSubtask);
  router.post('/:ref/blockers', t, work, validate({ body: blockerBody }), relations.addBlocker);
  router.delete('/:ref/blockers/:blocker', validate({ params: blockerParams }), work, relations.removeBlocker);
  router.put('/:ref/flag', t, work, validate({ body: flagBody }), relations.setFlag);
  router.delete('/:ref/flag', t, work, relations.setFlag);
  router.put('/:ref/sprint', t, work, validate({ body: ticketSprintBody }), sprints.setTicketSprint);
  router.put('/:ref/milestone', t, work, validate({ body: ticketMilestoneBody }), sprints.setTicketMilestone);

  // Client-facing (E11): who reported it, merging duplicate reports, the public roadmap.
  router.get('/:ref/reporters', t, async (req, res) => res.json({ reporters: await listTrackers(req.project, req.membership, await findTicket(req.project, req.valid.params.ref)) }));
  router.post('/:ref/merge', t, work, validate({ body: mergeSchema }), async (req, res) => res.json(await mergeDuplicate(req.project, req.membership, req.user, await findTicket(req.project, req.valid.params.ref), req.valid.body.into)));
  router.put('/:ref/roadmap', t, requireRole('manager', { write: true }), validate({ body: roadmapFlagSchema }), async (req, res) => res.json(await setOnRoadmap(req.project, await findTicket(req.project, req.valid.params.ref), req.valid.body.onRoadmap)));

  // Comments: viewers can take part in the discussion too.
  const talk = requireRole('viewer', { write: true });
  const c = validate({ params: commentParams });
  router.get('/:ref/comments', t, comments.listComments);
  router.post('/:ref/comments', t, talk, validate({ body: createCommentSchema }), comments.addComment);
  router.patch('/:ref/comments/:commentId', c, talk, validate({ body: editCommentSchema }), comments.editComment);
  router.delete('/:ref/comments/:commentId', c, talk, comments.deleteComment);
  // Decisions: pin a comment to the top of the ticket (developers and up).
  router.put('/:ref/comments/:commentId/pin', c, work, comments.pin);
  router.delete('/:ref/comments/:commentId/pin', c, work, comments.pin);

  // Attachments: the file is read into memory (max 10 MB) and checked before it is stored.
  const a = validate({ params: attachmentParams });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 } });
  router.get('/:ref/attachments', t, comments.listAttachments);
  router.post('/:ref/attachments', t, work, upload.single('file'), comments.upload);
  router.get('/:ref/attachments/:attachmentId', a, comments.download);
  // Debug files (E12): read a log with levels and search; analyse a (cleaned) HAR.
  router.get('/:ref/attachments/:attachmentId/log', a, validate({ query: logQuery }), async (req, res) => res.json(await logView(await findTicket(req.project, req.valid.params.ref), req.valid.params.attachmentId, req.valid.query)));
  router.get('/:ref/attachments/:attachmentId/har', a, async (req, res) => res.json(await harView(await findTicket(req.project, req.valid.params.ref), req.valid.params.attachmentId)));
  router.delete('/:ref/attachments/:attachmentId', a, work, comments.removeAttachment);

  return router;
}
