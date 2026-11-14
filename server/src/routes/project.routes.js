import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requireDb } from '../db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireProject } from '../middleware/requireProject.js';
import * as ctrl from '../controllers/project.controller.js';
import * as ticketCtrl from '../controllers/ticket.controller.js';
import * as bugCtrl from '../controllers/bug.controller.js';
import * as flowCtrl from '../controllers/flow.controller.js';
import * as followCtrl from '../controllers/follow.controller.js';
import * as outCtrl from '../controllers/outside.controller.js';
import { MAX_LOGO_BYTES } from '../services/portal.service.js';
import * as sprintCtrl from '../controllers/sprint.controller.js';
import { projectLeave } from '../services/leave.service.js';
import * as tpl from '../services/template.service.js';
import { setCustomFields } from '../services/fields.service.js';
import {
  customFieldsSchema, templateParams, createTemplateSchema, updateTemplateSchema,
  recurringParams, createRecurringSchema, updateRecurringSchema,
} from '../schemas/template.schemas.js';
import { publish } from '../realtime.js';
import * as rules from '../services/automation.service.js';
import { setSla, slaReport } from '../services/sla.service.js';
import { auditTrail, listAudit } from '../services/audit.service.js';
import * as setup from '../services/setup.service.js';
import {
  ruleParams, createRuleSchema, updateRuleSchema, reorderRulesSchema, slaSchema, slaReportQuery, auditQuery,
} from '../schemas/automation.schemas.js';
import { leaveRangeQuery } from '../schemas/leave.schemas.js';
import {
  sprintParams, milestoneParams, createSprintSchema, updateSprintSchema, completeSprintSchema,
  createMilestoneSchema, updateMilestoneSchema,
} from '../schemas/sprint.schemas.js';
import { portalSettingsSchema, releaseNotesQuery, roadmapSettingsSchema, shareLinkSchema } from '../schemas/outside.schemas.js';
import * as pubboard from '../services/publicboard.service.js';
import multer from 'multer';
import * as debug from '../services/debug.service.js';
import * as outbound from '../services/outbound.service.js';
import * as gitlab from '../services/gitlab.service.js';
import * as workspaces from '../services/workspace.service.js';
import { exportProject, importProject } from '../services/backup.service.js';
import { cleanupAttachments, storageReport, storageSummary } from '../services/storage.service.js';
import { ticketRouter } from './ticket.routes.js';
import { filterRouter } from './filter.routes.js';
import {
  projectParams, memberParams, inviteIdParams, inviteTokenParams, listProjectsQuery, createProjectSchema,
  updateProjectSchema, deleteProjectSchema, changeRoleSchema, createInviteSchema,
  statusesSchema, analyticsQuery, boardAtQuery, suggestedLabelsSchema, cardLayoutSchema, sourceSchema, ingestKeySchema, ingestKeyParams, githubTokenSchema, githubOptionsSchema, todoTicketSchema, deploySettingsSchema, forecastQuery, compareDatesQuery, roundParams, retroParams, shareLinkParams, testRunFields, testRunParams, testTicketSchema, testReportQuery, alertSchema, webhookSchema, targetPatchSchema, alertParams, webhookParams, gitlabTokenSchema, projectWorkspaceSchema, fromWorkspaceSchema, importFields, storageQuery, cleanupSchema, retroItemParams, incidentParams, pokerStartSchema, pokerVoteSchema, pokerAcceptSchema, retroCreateSchema, retroItemSchema, incidentStartSchema, incidentPatchSchema, incidentResolveSchema,
} from '../schemas/project.schemas.js';
import { compareQuery } from '../schemas/ticket.schemas.js';
import * as ingest from '../services/ingest.service.js';
import * as maps from '../services/sourcemap.service.js';
import * as deep from '../services/githubdeep.service.js';
import * as deploys from '../services/deploy.service.js';
import * as flow2 from '../services/flow2.service.js';
import * as live from '../services/live.service.js';
import { mapsUpload } from './ingest.routes.js';

// Invites send email from your Gmail account, so they are capped per network to stop abuse.
const inviteLimiter = () => rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimit.inviteMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many invites sent. Try again in an hour.')),
});

export function projectRouter() {
  const router = Router();
  router.use(requireDb, requireAuth);
  // Every successful change to a project's setup goes into its audit log (E4C).
  router.use(auditTrail());
  const p = validate({ params: projectParams });

  router.get('/', validate({ query: listProjectsQuery }), ctrl.list);
  router.post('/', validate({ body: createProjectSchema }), ctrl.create);
  // Starting templates for a new project (columns and labels only).
  router.get('/setup-templates', (_req, res) => res.json({ templates: setup.listSetupTemplates() }));

  router.get('/:projectId', p, requireProject('viewer'), ctrl.get);
  router.patch('/:projectId', p, requireProject('manager', { write: true }), validate({ body: updateProjectSchema }), ctrl.update);
  router.post('/:projectId/archive', p, requireProject('admin'), ctrl.archive);
  router.post('/:projectId/unarchive', p, requireProject('admin'), ctrl.unarchive);
  router.delete('/:projectId', p, requireProject('admin'), validate({ body: deleteProjectSchema }), ctrl.remove);

  // Members. Anyone can leave (DELETE their own id); managing others needs manager or admin (checked in the service).
  const m = validate({ params: memberParams });
  router.get('/:projectId/members', p, requireProject('viewer'), ctrl.members);
  router.patch('/:projectId/members/:userId', m, requireProject('viewer', { write: true }), validate({ body: changeRoleSchema }), ctrl.changeRole);
  router.delete('/:projectId/members/:userId', m, requireProject('viewer'), ctrl.removeMember);

  // Tickets (roles are checked per route inside).
  router.use('/:projectId/tickets', p, requireProject('viewer'), ticketRouter());
  router.get('/:projectId/labels', p, requireProject('viewer'), ticketCtrl.labels);
  router.get('/:projectId/workload', p, requireProject('viewer'), ticketCtrl.workload);
  router.get('/:projectId/errors', p, requireProject('viewer'), bugCtrl.errors);
  router.get('/:projectId/errors/compare', p, requireProject('viewer'), validate({ query: compareQuery }), bugCtrl.compare);

  // Flow (step 9): edit columns and WIP limits, analytics, board time travel.
  router.put('/:projectId/statuses', p, requireProject('manager', { write: true }), validate({ body: statusesSchema }), flowCtrl.statuses);
  // Cards in progress longer than the team's usual (85th percentile) cycle time.
  router.get('/:projectId/ageing', p, requireProject('viewer'), followCtrl.ageing);
  router.get('/:projectId/analytics', p, requireProject('viewer'), validate({ query: analyticsQuery }), flowCtrl.analytics);
  router.get('/:projectId/board-at', p, requireProject('viewer'), validate({ query: boardAtQuery }), flowCtrl.board);

  // Planning (E3B): sprints, the retro report, milestones. Anyone can look; managers plan.
  const sp = validate({ params: sprintParams });
  const ms = validate({ params: milestoneParams });
  const plan = requireProject('manager', { write: true });
  router.get('/:projectId/sprints', p, requireProject('viewer'), sprintCtrl.list);
  router.post('/:projectId/sprints', p, plan, validate({ body: createSprintSchema }), sprintCtrl.create);
  router.patch('/:projectId/sprints/:sprintId', sp, plan, validate({ body: updateSprintSchema }), sprintCtrl.update);
  router.delete('/:projectId/sprints/:sprintId', sp, plan, sprintCtrl.remove);
  router.post('/:projectId/sprints/:sprintId/start', sp, plan, sprintCtrl.start);
  router.post('/:projectId/sprints/:sprintId/complete', sp, plan, validate({ body: completeSprintSchema }), sprintCtrl.complete);
  router.get('/:projectId/sprints/:sprintId/report', sp, requireProject('viewer'), sprintCtrl.report);
  // Customisation (E4B): custom fields, ticket templates, recurring tickets. Managers set them up;
  // everyone can see them, and developers use templates when creating tickets.
  const changed = (req) => publish(String(req.project._id), 'project', { action: 'updated', actorId: String(req.user._id) });
  router.put('/:projectId/fields', p, plan, validate({ body: customFieldsSchema }), async (req, res) => {
    const fields = await setCustomFields(req.project, req.valid.body.fields);
    changed(req);
    res.json({ fields });
  });
  const tp = validate({ params: templateParams });
  router.get('/:projectId/templates', p, requireProject('viewer'), async (req, res) => res.json({ templates: await tpl.listTemplates(req.project) }));
  router.post('/:projectId/templates', p, plan, validate({ body: createTemplateSchema }), async (req, res) => {
    res.status(201).json({ template: await tpl.createTemplate(req.project, req.user, req.valid.body) });
  });
  router.patch('/:projectId/templates/:templateId', tp, plan, validate({ body: updateTemplateSchema }), async (req, res) => {
    res.json({ template: await tpl.updateTemplate(req.project, req.valid.params.templateId, req.valid.body) });
  });
  router.delete('/:projectId/templates/:templateId', tp, plan, async (req, res) => {
    await tpl.deleteTemplate(req.project, req.valid.params.templateId);
    res.status(204).end();
  });
  const rp = validate({ params: recurringParams });
  router.get('/:projectId/recurring', p, requireProject('viewer'), async (req, res) => res.json({ recurring: await tpl.listRecurring(req.project) }));
  router.post('/:projectId/recurring', p, plan, validate({ body: createRecurringSchema }), async (req, res) => {
    res.status(201).json({ recurring: await tpl.createRecurring(req.project, req.user, req.valid.body) });
  });
  router.patch('/:projectId/recurring/:recurringId', rp, plan, validate({ body: updateRecurringSchema }), async (req, res) => {
    res.json({ recurring: await tpl.updateRecurring(req.project, req.user, req.valid.params.recurringId, req.valid.body) });
  });
  router.delete('/:projectId/recurring/:recurringId', rp, plan, async (req, res) => {
    await tpl.deleteRecurring(req.project, req.valid.params.recurringId);
    res.status(204).end();
  });
  router.post('/:projectId/recurring/:recurringId/run', rp, plan, async (req, res) => {
    const ticket = await tpl.runNow(req.project, req.user, req.valid.params.recurringId);
    publish(String(req.project._id), 'ticket', { action: 'created', actorId: String(req.user._id), ticket });
    res.status(201).json({ ticket });
  });

  // Automation (E4C): rules, service levels, and the audit log. Everyone can see the rules and
  // targets; managers set them up. The audit log is for managers and admins.
  const rl = validate({ params: ruleParams });
  router.get('/:projectId/rules', p, requireProject('viewer'), async (req, res) => res.json({ rules: await rules.listRules(req.project) }));
  router.post('/:projectId/rules', p, plan, validate({ body: createRuleSchema }), async (req, res) => {
    res.status(201).json({ rule: await rules.createRule(req.project, req.user, req.valid.body) });
  });
  router.put('/:projectId/rules/order', p, plan, validate({ body: reorderRulesSchema }), async (req, res) => {
    res.json({ rules: await rules.reorderRules(req.project, req.valid.body.ids) });
  });
  router.patch('/:projectId/rules/:ruleId', rl, plan, validate({ body: updateRuleSchema }), async (req, res) => {
    res.json({ rule: await rules.updateRule(req.project, req.valid.params.ruleId, req.valid.body) });
  });
  router.delete('/:projectId/rules/:ruleId', rl, plan, async (req, res) => {
    await rules.deleteRule(req.project, req.valid.params.ruleId);
    res.status(204).end();
  });
  router.put('/:projectId/sla', p, plan, validate({ body: slaSchema }), async (req, res) => {
    const sla = await setSla(req.project, req.valid.body);
    changed(req);
    res.json({ sla });
  });
  router.get('/:projectId/sla/report', p, requireProject('viewer'), validate({ query: slaReportQuery }), async (req, res) => {
    res.json(await slaReport(req.project, req.valid.query));
  });
  router.get('/:projectId/audit', p, requireProject('manager'), validate({ query: auditQuery }), async (req, res) => {
    res.json(await listAudit(req.project, req.valid.query));
  });

  // Project setup (E4D): the label list, what cards show, the setup checklist.
  router.put('/:projectId/labels', p, plan, validate({ body: suggestedLabelsSchema }), async (req, res) => {
    const labels = await setup.setSuggestedLabels(req.project, req.valid.body.labels);
    changed(req);
    res.json({ labels });
  });
  // Crash capture keys (E6A): managers make, list and revoke them.
  router.get('/:projectId/ingest-keys', p, requireProject('manager'), (req, res) => res.json(ingest.listKeys(req.project)));
  router.post('/:projectId/ingest-keys', p, plan, validate({ body: ingestKeySchema }), async (req, res) => {
    res.status(201).json(await ingest.createKey(req.project, req.user._id, req.valid.body));
  });
  router.delete('/:projectId/ingest-keys/:keyId', validate({ params: ingestKeyParams }), requireProject('manager', { write: true }), async (req, res) => {
    res.json({ ingestKey: await ingest.revokeKey(req.project, req.valid.params.keyId) });
  });

  // Source maps (E6B): managers upload and delete; developers and up can see what is there.
  router.get('/:projectId/sourcemaps', p, requireProject('developer'), async (req, res) => res.json(await maps.listMaps(req.project)));
  router.post('/:projectId/sourcemaps', p, plan, mapsUpload, async (req, res) => {
    res.status(201).json(await maps.uploadMaps(req.project, req.user._id, req.body?.release, req.files));
  });
  router.delete('/:projectId/sourcemaps', p, plan, async (req, res) => {
    res.json(await maps.deleteRelease(req.project, String(req.query.release ?? '')));
  });

  // Live collaboration II (E10): planning poker, retro boards, incidents.
  const w = requireProject('viewer', { write: true });
  const pokerP = validate({ params: roundParams });
  router.get('/:projectId/poker', p, requireProject('viewer'), async (req, res) => res.json({ rounds: await live.listPoker(req.project, req.user._id) }));
  router.post('/:projectId/poker', p, w, validate({ body: pokerStartSchema }), async (req, res) => res.status(201).json({ round: await live.startPoker(req.project, req.membership, req.user, req.valid.body.ticket) }));
  router.put('/:projectId/poker/:roundId/vote', pokerP, w, validate({ body: pokerVoteSchema }), async (req, res) => res.json({ round: await live.vote(req.project, req.membership, req.user, req.valid.params.roundId, req.valid.body.value) }));
  router.post('/:projectId/poker/:roundId/reveal', pokerP, w, async (req, res) => res.json({ round: await live.reveal(req.project, req.membership, req.user, req.valid.params.roundId) }));
  router.post('/:projectId/poker/:roundId/revote', pokerP, w, async (req, res) => res.json({ round: await live.revote(req.project, req.membership, req.user, req.valid.params.roundId) }));
  router.post('/:projectId/poker/:roundId/accept', pokerP, w, validate({ body: pokerAcceptSchema }), async (req, res) => res.json({ round: await live.accept(req.project, req.membership, req.user, req.valid.params.roundId, req.valid.body.points) }));
  const rr = validate({ params: retroParams });
  const ri = validate({ params: retroItemParams });
  router.get('/:projectId/retros', p, requireProject('viewer'), async (req, res) => res.json({ retros: await live.listRetros(req.project) }));
  router.post('/:projectId/retros', p, w, validate({ body: retroCreateSchema }), async (req, res) => res.status(201).json({ retro: await live.createRetro(req.project, req.membership, req.user, req.valid.body) }));
  router.get('/:projectId/retros/:retroId', rr, requireProject('viewer'), async (req, res) => res.json({ retro: await live.showRetro(req.project, req.valid.params.retroId, req.user._id) }));
  router.post('/:projectId/retros/:retroId/items', rr, w, validate({ body: retroItemSchema }), async (req, res) => res.status(201).json({ retro: await live.addRetroItem(req.project, req.membership, req.user, req.valid.params.retroId, req.valid.body) }));
  router.post('/:projectId/retros/:retroId/items/:itemId/vote', ri, w, async (req, res) => res.json({ retro: await live.voteRetroItem(req.project, req.user, req.valid.params.retroId, req.valid.params.itemId) }));
  router.delete('/:projectId/retros/:retroId/items/:itemId', ri, w, async (req, res) => res.json({ retro: await live.removeRetroItem(req.project, req.membership, req.user, req.valid.params.retroId, req.valid.params.itemId) }));
  router.post('/:projectId/retros/:retroId/items/:itemId/ticket', ri, w, async (req, res) => res.json({ retro: await live.ticketFromRetroItem(req.project, req.membership, req.user, req.valid.params.retroId, req.valid.params.itemId) }));
  router.post('/:projectId/retros/:retroId/close', rr, w, async (req, res) => res.json({ retro: await live.closeRetro(req.project, req.membership, req.user, req.valid.params.retroId) }));
  const ip = validate({ params: incidentParams });
  router.get('/:projectId/incidents', p, requireProject('viewer'), async (req, res) => res.json({ incidents: await live.listIncidents(req.project) }));
  router.post('/:projectId/incidents', p, w, validate({ body: incidentStartSchema }), async (req, res) => res.status(201).json({ incident: await live.startIncident(req.project, req.membership, req.user, req.valid.body) }));
  router.get('/:projectId/incidents/:incidentId', ip, requireProject('viewer'), async (req, res) => res.json({ incident: await live.showIncident(req.project, req.valid.params.incidentId) }));
  router.patch('/:projectId/incidents/:incidentId', ip, w, validate({ body: incidentPatchSchema }), async (req, res) => res.json({ incident: await live.updateIncident(req.project, req.membership, req.user, req.valid.params.incidentId, req.valid.body) }));
  router.post('/:projectId/incidents/:incidentId/resolve', ip, w, validate({ body: incidentResolveSchema }), async (req, res) => res.json({ incident: await live.resolveIncident(req.project, req.membership, req.user, req.valid.params.incidentId, req.valid.body) }));
  router.get('/:projectId/incidents/:incidentId/postmortem', ip, requireProject('viewer'), async (req, res) => res.json({ markdown: await live.postmortem(req.project, req.valid.params.incidentId) }));

  // Flow analytics II (E9): forecast and what-if, next best ticket, insights, standup, compare, mosaic.
  const v = requireProject('viewer');
  router.get('/:projectId/flow/forecast', p, v, validate({ query: forecastQuery }), async (req, res) => res.json(await flow2.forecast(req.project, req.valid.query)));
  router.get('/:projectId/flow/next', p, requireProject('developer'), async (req, res) => res.json({ next: await flow2.nextBest(req.project, req.user) }));
  router.get('/:projectId/flow/insights', p, v, async (req, res) => res.json(await flow2.insights(req.project)));
  router.get('/:projectId/flow/standup', p, v, async (req, res) => res.json(await flow2.standup(req.project)));
  router.get('/:projectId/flow/compare', p, v, validate({ query: compareDatesQuery }), async (req, res) => res.json(await flow2.compareDates(req.project, req.valid.query.from, req.valid.query.to)));
  router.get('/:projectId/flow/mosaic', p, v, async (req, res) => res.json({ tiles: await flow2.mosaic(req.project) }));

  // Deployments (E8): history + DORA for everyone, a deploy recorded by hand, settings.
  router.get('/:projectId/deploys', p, requireProject('viewer'), async (req, res) => res.json(await deploys.listDeployments(req.project)));
  router.post('/:projectId/deploys', p, plan, validate({ body: deploys.deploySchema }), async (req, res) => {
    res.status(201).json(await deploys.recordDeployment(req.project, req.valid.body, { source: 'manual', by: req.user._id }));
  });
  router.put('/:projectId/deploys/settings', p, plan, validate({ body: deploySettingsSchema }), async (req, res) => {
    res.json({ settings: await deploys.updateDeploySettings(req.project, req.valid.body) });
  });

  // GitHub deep integration (E7). The token is write-only: it is never sent back.
  router.get('/:projectId/github', p, requireProject('manager'), (req, res) => res.json({ github: deep.tokenSettings(req.project) }));
  router.put('/:projectId/github/token', p, requireProject('admin', { write: true }), validate({ body: githubTokenSchema }), async (req, res) => {
    const github = await deep.connectToken(req.project, req.valid.body.token);
    changed(req);
    res.json({ github });
  });
  router.delete('/:projectId/github/token', p, requireProject('admin', { write: true }), async (req, res) => res.json({ github: await deep.removeToken(req.project) }));
  router.put('/:projectId/github/options', p, plan, validate({ body: githubOptionsSchema }), async (req, res) => res.json({ github: await deep.updateGithubOptions(req.project, req.valid.body) }));
  router.post('/:projectId/github/issues/import', p, plan, async (req, res) => res.json(await deep.importIssues(req.project)));
  router.get('/:projectId/github/insights', p, requireProject('developer'), async (req, res) => res.json(await deep.insights(req.project)));
  router.post('/:projectId/github/knowledge', p, plan, async (req, res) => res.json({ knowledge: await deep.analyseKnowledge(req.project) }));
  router.post('/:projectId/github/todos', p, plan, async (req, res) => res.json({ todos: await deep.scanTodos(req.project) }));
  router.post('/:projectId/github/todos/ticket', p, requireProject('developer', { write: true }), validate({ body: todoTicketSchema }), async (req, res) => {
    res.status(201).json({ ticket: await deep.ticketFromTodo(req.project, req.user, req.valid.body) });
  });

  // Where the code lives, for links from stack frames (E5B).
  router.put('/:projectId/source', p, plan, validate({ body: sourceSchema }), async (req, res) => {
    const { repo, branch, pathPrefix } = req.valid.body;
    req.project.source = repo ? { repo, branch, pathPrefix, learnedFrom: 'manual' } : { repo: null, branch: 'main', pathPrefix: '', learnedFrom: null };
    await req.project.save();
    changed(req);
    res.json({ source: req.project.source });
  });
  router.put('/:projectId/card-layout', p, plan, validate({ body: cardLayoutSchema }), async (req, res) => {
    const fields = await setup.setCardLayout(req.project, req.valid.body.fields);
    changed(req);
    res.json({ fields });
  });
  router.get('/:projectId/setup', p, requireProject('viewer'), async (req, res) => res.json(await setup.setupChecklist(req.project)));
  router.post('/:projectId/setup/dismiss', p, plan, async (req, res) => res.json(await setup.dismissChecklist(req.project, true)));
  router.delete('/:projectId/setup/dismiss', p, plan, async (req, res) => res.json(await setup.dismissChecklist(req.project, false)));

  // Who in the project is on leave between two days (calendar, assignee picker).
  router.get('/:projectId/leave', p, requireProject('viewer'), validate({ query: leaveRangeQuery }), async (req, res) => {
    res.json({ leave: await projectLeave(req.project, req.valid.query) });
  });
  router.get('/:projectId/milestones', p, requireProject('viewer'), sprintCtrl.milestones);
  router.post('/:projectId/milestones', p, plan, validate({ body: createMilestoneSchema }), sprintCtrl.createMilestone);
  router.patch('/:projectId/milestones/:milestoneId', ms, plan, validate({ body: updateMilestoneSchema }), sprintCtrl.updateMilestone);
  router.delete('/:projectId/milestones/:milestoneId', ms, plan, sprintCtrl.removeMilestone);

  // Outside-in (step 10): public portal, GitHub, release notes.
  router.get('/:projectId/portal', p, requireProject('manager'), outCtrl.getPortal);
  router.put('/:projectId/portal', p, requireProject('manager', { write: true }), validate({ body: portalSettingsSchema }), outCtrl.updatePortal);
  router.post('/:projectId/portal/rotate', p, requireProject('manager', { write: true }), outCtrl.rotatePortal);
  // The page's logo: one PNG, JPEG or WebP, at most 256 KB (checked again by its bytes in the service).
  const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 2 } }).single('file');
  const takeLogo = (req, res, next) => logoUpload(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'too_large', 'The logo can be up to 256 KB. Try a smaller image.'));
    return next(err);
  });
  router.get('/:projectId/portal/logo', p, requireProject('manager'), outCtrl.projectLogo);
  router.put('/:projectId/portal/logo', p, requireProject('manager', { write: true }), takeLogo, outCtrl.setPortalLogo);
  router.delete('/:projectId/portal/logo', p, requireProject('manager', { write: true }), outCtrl.removePortalLogo);
  // Platform (E14): workspaces, backup and import, storage.
  const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 3 } }).single('file');
  router.post('/import', backupUpload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'file_required', 'Choose a Tessera backup file (form field "file")');
    const fields = importFields.safeParse(req.body ?? {});
    if (!fields.success) throw new HttpError(400, 'validation_failed', fields.error.issues[0].message);
    let backup;
    try { backup = JSON.parse(req.file.buffer.toString('utf8')); } catch { throw new HttpError(422, 'not_json', 'This file is not JSON. Choose the .json file Tessera exported.'); }
    res.status(201).json(await importProject(req.user, backup, fields.data));
  });
  router.get('/:projectId/export', p, requireProject('admin'), async (req, res) => {
    const backup = await exportProject(req.project);
    res.set('Content-Disposition', `attachment; filename="${req.project.key}-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type('application/json').send(JSON.stringify(backup, null, 2));
  });
  router.put('/:projectId/workspace', p, requireProject('admin', { write: true }), validate({ body: projectWorkspaceSchema }), async (req, res) => res.json(await workspaces.setProjectWorkspace(req.user, req.project, req.membership, req.valid.body.workspaceId)));
  router.post('/:projectId/members/from-workspace', p, requireProject('manager', { write: true }), validate({ body: fromWorkspaceSchema }), async (req, res) => res.json(await workspaces.addWorkspaceMembers(req.project, req.membership, req.valid.body.role)));
  router.get('/:projectId/storage', p, requireProject('manager'), validate({ query: storageQuery }), async (req, res) => res.json(await storageReport(req.project, req.valid.query)));
  router.get('/:projectId/storage/summary', p, requireProject('viewer'), async (req, res) => res.json(await storageSummary(req.project)));
  router.post('/:projectId/storage/cleanup', p, requireProject('manager', { write: true }), validate({ body: cleanupSchema }), async (req, res) => res.json(await cleanupAttachments(req.project, req.membership, req.valid.body.attachmentIds)));

  // Slack / Discord alerts, outgoing webhooks, GitLab (E13).
  const mgr = requireProject('manager');
  const mgrW = requireProject('manager', { write: true });
  router.get('/:projectId/integrations/outbound', p, mgr, async (req, res) => res.json(await outbound.listIntegrations(req.project)));
  router.post('/:projectId/integrations/alerts', p, mgrW, validate({ body: alertSchema }), async (req, res) => res.status(201).json({ alert: await outbound.addAlert(req.project, req.valid.body) }));
  router.patch('/:projectId/integrations/alerts/:alertId', validate({ params: alertParams }), mgrW, validate({ body: targetPatchSchema }), async (req, res) => res.json({ alert: await outbound.updateTarget(req.project, 'alert', req.valid.params.alertId, req.valid.body) }));
  router.delete('/:projectId/integrations/alerts/:alertId', validate({ params: alertParams }), mgrW, async (req, res) => { await outbound.removeTarget(req.project, 'alert', req.valid.params.alertId); res.status(204).end(); });
  router.post('/:projectId/integrations/alerts/:alertId/test', validate({ params: alertParams }), mgrW, async (req, res) => res.json({ delivery: await outbound.sendTest(req.project, 'alert', req.valid.params.alertId, req.user) }));
  router.post('/:projectId/integrations/webhooks', p, mgrW, validate({ body: webhookSchema }), async (req, res) => res.status(201).json({ webhook: await outbound.addWebhook(req.project, req.valid.body) }));
  router.patch('/:projectId/integrations/webhooks/:webhookId', validate({ params: webhookParams }), mgrW, validate({ body: targetPatchSchema }), async (req, res) => res.json({ webhook: await outbound.updateTarget(req.project, 'webhook', req.valid.params.webhookId, req.valid.body) }));
  router.delete('/:projectId/integrations/webhooks/:webhookId', validate({ params: webhookParams }), mgrW, async (req, res) => { await outbound.removeTarget(req.project, 'webhook', req.valid.params.webhookId); res.status(204).end(); });
  router.post('/:projectId/integrations/webhooks/:webhookId/test', validate({ params: webhookParams }), mgrW, async (req, res) => res.json({ delivery: await outbound.sendTest(req.project, 'webhook', req.valid.params.webhookId, req.user) }));
  router.get('/:projectId/integrations/gitlab', p, mgr, (req, res) => res.json({ gitlab: gitlab.gitlabSettings(req.project, { withSecret: req.membership.role === 'admin' }) }));
  router.put('/:projectId/integrations/gitlab', p, requireProject('admin', { write: true }), async (req, res) => res.json({ gitlab: await gitlab.connectGitlab(req.project) }));
  router.delete('/:projectId/integrations/gitlab', p, requireProject('admin'), async (req, res) => res.json({ gitlab: await gitlab.disconnectGitlab(req.project) }));
  router.put('/:projectId/integrations/gitlab/token', p, requireProject('admin', { write: true }), validate({ body: gitlabTokenSchema }), async (req, res) => res.json({ gitlab: await gitlab.setGitlabToken(req.project, req.valid.body) }));
  router.delete('/:projectId/integrations/gitlab/token', p, requireProject('admin'), async (req, res) => res.json({ gitlab: await gitlab.removeGitlabToken(req.project) }));

  // CI test results (E12): JUnit XML uploads, flaky and failing tests, a ticket for one.
  const junitUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } }).single('file');
  router.get('/:projectId/tests', p, requireProject('viewer'), validate({ query: testReportQuery }), async (req, res) => res.json(await debug.testReport(req.project, req.valid.query)));
  router.post('/:projectId/tests', p, requireProject('developer', { write: true }), junitUpload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'file_required', 'Choose a JUnit XML file (form field "file")');
    const fields = testRunFields.safeParse(req.body ?? {});
    if (!fields.success) throw new HttpError(400, 'validation_failed', fields.error.issues[0].message);
    res.status(201).json({ run: await debug.importTestRun(req.project, { ...fields.data, xml: req.file.buffer.toString('utf8'), source: 'upload', user: req.user }) });
  });
  router.delete('/:projectId/tests/:runId', validate({ params: testRunParams }), requireProject('manager', { write: true }), async (req, res) => { await debug.deleteTestRun(req.project, req.valid.params.runId); res.status(204).end(); });
  router.post('/:projectId/tests/ticket', p, requireProject('developer', { write: true }), validate({ body: testTicketSchema }), async (req, res) => res.status(201).json(await debug.ticketFromTest(req.project, req.membership, req.user, req.valid.body.key)));

  // Public roadmap and read-only board links (E11).
  router.get('/:projectId/roadmap', p, requireProject('viewer'), async (req, res) => res.json({ roadmap: { ...pubboard.roadmapSettings(req.project), ...(req.membership.role === 'viewer' && { url: null }) }, items: await pubboard.roadmapItems(req.project) }));
  router.put('/:projectId/roadmap', p, requireProject('manager', { write: true }), validate({ body: roadmapSettingsSchema }), async (req, res) => res.json({ roadmap: await pubboard.updateRoadmap(req.project, req.valid.body) }));
  router.get('/:projectId/share-links', p, requireProject('manager'), (req, res) => res.json({ links: pubboard.listShareLinks(req.project) }));
  router.post('/:projectId/share-links', p, requireProject('manager', { write: true }), validate({ body: shareLinkSchema }), async (req, res) => res.status(201).json({ link: await pubboard.createShareLink(req.project, req.user, req.valid.body) }));
  router.delete('/:projectId/share-links/:linkId', validate({ params: shareLinkParams }), requireProject('manager', { write: true }), async (req, res) => res.json({ link: await pubboard.revokeShareLink(req.project, req.valid.params.linkId) }));
  router.get('/:projectId/integrations/github', p, requireProject('manager'), outCtrl.getGithub);
  router.put('/:projectId/integrations/github', p, requireProject('admin', { write: true }), outCtrl.connectGithub);
  router.delete('/:projectId/integrations/github', p, requireProject('admin'), outCtrl.disconnectGithub);
  router.get('/:projectId/release-notes', p, requireProject('viewer'), validate({ query: releaseNotesQuery }), outCtrl.notes);
  router.use('/:projectId/filters', p, requireProject('viewer'), filterRouter());

  // Invites by email.
  const limit = inviteLimiter();
  router.get('/:projectId/invites', p, requireProject('manager'), ctrl.listInvites);
  router.post('/:projectId/invites', p, requireProject('manager', { write: true }), limit, validate({ body: createInviteSchema }), ctrl.createInvite);
  router.delete('/:projectId/invites/:inviteId', validate({ params: inviteIdParams }), requireProject('manager'), ctrl.revokeInvite);

  return router;
}

// The link from the invite email. Viewing and declining work signed out (the token is the proof);
// accepting needs the account the invite was sent to.
export function inviteRouter() {
  const router = Router();
  router.use(requireDb);
  const t = validate({ params: inviteTokenParams });
  router.get('/:token', t, ctrl.previewInvite);
  router.post('/:token/accept', t, requireAuth, ctrl.acceptInvite);
  router.post('/:token/decline', t, ctrl.declineInvite);
  return router;
}
