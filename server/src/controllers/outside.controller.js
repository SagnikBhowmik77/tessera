import * as portal from '../services/portal.service.js';
import * as github from '../services/github.service.js';
import { releaseNotes } from '../services/release.service.js';
import { acceptTriage, findTicket } from '../services/ticket.service.js';
import { publish } from '../realtime.js';

// Portal settings (managers) ------------------------------------------------------------
export const getPortal = (req, res) => res.json({ portal: portal.portalSettings(req.project) });
export async function updatePortal(req, res) {
  res.json({ portal: await portal.updatePortal(req.project, req.valid.body) });
}
// The page's logo. Served as the image it was checked to be, never sniffed as anything else, with
// no permission to run or load anything, and cacheable for good when asked for by its version.
function sendLogo(req, res, logo) {
  res.set({
    'Content-Type': logo.type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    // The app may live on another site than the API, so its <img> must be allowed to show it.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ETag: `"${logo.hash}"`,
    'Cache-Control': req.query.v === logo.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  });
  if (req.get('if-none-match') === `"${logo.hash}"`) return res.status(304).end();
  return res.send(logo.data);
}
export async function setPortalLogo(req, res) {
  res.json({ portal: await portal.setPortalLogo(req.project, req.file) });
}
export async function removePortalLogo(req, res) {
  res.json({ portal: await portal.removePortalLogo(req.project) });
}
export async function projectLogo(req, res) {
  sendLogo(req, res, await portal.projectLogo(req.project));
}
export async function publicLogo(req, res) {
  sendLogo(req, res, await portal.publicLogo(req.valid.params.token));
}
export async function rotatePortal(req, res) {
  res.json({ portal: await portal.rotatePortal(req.project) });
}

// The public page (no login) ----------------------------------------------------------
export async function portalInfo(req, res) {
  res.json(await portal.portalInfo(req.valid.params.token));
}
export async function portalReport(req, res) {
  const { projectId, ticket, ...result } = await portal.submitReport(req.valid.params.token, req.valid.body, { ip: req.ip, userAgent: req.get('user-agent') });
  // The team's open boards and triage inbox refresh live.
  publish(projectId, 'ticket', { action: result.alreadyKnown ? 'updated' : 'created', actorId: null, ticket });
  res.status(201).json(result);
}

// Triage inbox: accept a portal report onto the board.
export async function accept(req, res) {
  const ticket = await acceptTriage(req.project, req.membership, await findTicket(req.project, req.valid.params.ref));
  publish(String(req.project._id), 'ticket', { action: 'updated', actorId: String(req.user._id), ticket });
  res.json({ ticket });
}

// GitHub (admins manage; managers can see whether it's connected) ---------------------
export const getGithub = (req, res) => res.json({ github: github.githubSettings(req.project, { withSecret: req.membership.role === 'admin' }) });
export async function connectGithub(req, res) {
  res.json({ github: await github.connectGithub(req.project) });
}
export async function disconnectGithub(req, res) {
  res.json({ github: await github.disconnectGithub(req.project) });
}
export async function githubHook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.json(await github.handleGithub(req.params.projectId, req.headers, raw));
}

// Release notes -----------------------------------------------------------------------
export async function notes(req, res) {
  res.json(await releaseNotes(req.project, req.valid.query));
}
