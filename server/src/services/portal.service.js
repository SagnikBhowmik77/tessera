import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { PortalLogo, Project } from '../models/index.js';
import { createTicket } from './ticket.service.js';
import { emailReporterReceipt, notify, trackUrl } from './notification.service.js';
import { createTracker } from './tracking.service.js';

const newToken = () => randomBytes(24).toString('base64url');
export const portalUrl = (token) => `${config.appUrl}/report/${token}`;

// Managers turn the public page on or off and set the message shown on it.
// The first time it's turned on, it gets its link.
export async function updatePortal(project, { enabled, intro, widget, brand }) {
  if (enabled !== undefined) project.portal.enabled = enabled;
  if (intro !== undefined) project.portal.intro = intro;
  if (brand?.name !== undefined) project.portal.brand.name = brand.name;
  if (brand?.accent !== undefined) project.portal.brand.accent = brand.accent;
  if (widget !== undefined) {
    const origins = widget.origins ?? project.portal.widget?.origins ?? [];
    const on = widget.enabled ?? project.portal.widget?.enabled ?? false;
    if (on && !origins.length) throw new HttpError(400, 'origins_required', 'List the websites the report button may be used on');
    project.portal.widget = { enabled: on, origins };
  }
  if (project.portal.enabled && !project.portal.token) project.portal.token = newToken();
  await project.save();
  return portalSettings(project);
}

// A new link; the old one stops working at once (e.g. after spam).
export async function rotatePortal(project) {
  project.portal.token = newToken();
  await project.save();
  return portalSettings(project);
}

export function portalSettings(project) {
  const { enabled, token, intro, widget, brand } = project.portal;
  return {
    enabled, intro,
    brand: { name: brand?.name ?? '', accent: brand?.accent ?? null, logo: brand?.logo ?? null }, url: token ? portalUrl(token) : null, turnstile: Boolean(config.turnstile.secret && config.turnstile.siteKey),
    widget: { enabled: Boolean(widget?.enabled), origins: widget?.origins ?? [], scriptUrl: `${config.apiUrl}/sdk/widget.js`, token: enabled ? token : null },
  };
}

async function findPortal(token) {
  const project = await Project.findOne({ 'portal.token': token, 'portal.enabled': true, archivedAt: null });
  if (!project) throw new HttpError(404, 'portal_not_found', 'This report page does not exist or has been turned off');
  return project;
}

// What the public page shows. Nothing about the team or its tickets.
export async function portalInfo(token) {
  const project = await findPortal(token);
  return {
    project: { name: project.name, key: project.key },
    intro: project.portal.intro,
    // The name, colour and logo the team chose for this page (the logo address carries its version,
    // so it can be cached for good and still change the moment a new one is uploaded).
    brand: {
      name: project.portal.brand?.name || project.name,
      accent: project.portal.brand?.accent ?? null,
      logo: project.portal.brand?.logo ? `/api/portal/${token}/logo?v=${project.portal.brand.logo}` : null,
    },
    turnstileSiteKey: config.turnstile.secret && config.turnstile.siteKey ? config.turnstile.siteKey : null,
  };
}

async function verifyTurnstile(token, ip) {
  if (!config.turnstile.secret || !config.turnstile.siteKey) return;
  if (!token) throw new HttpError(400, 'captcha_required', 'Please complete the "I am human" check');
  const res = await fetch(config.turnstile.verifyUrl, {
    method: 'POST',
    body: new URLSearchParams({ secret: config.turnstile.secret, response: token, ...(ip && { remoteip: ip }) }),
  }).catch(() => null);
  const body = res?.ok ? await res.json().catch(() => null) : null;
  if (!body?.success) throw new HttpError(400, 'captcha_failed', 'The "I am human" check failed. Please try again.');
}

// A report from someone without an account. It lands in the triage inbox (not on the board),
// the project's managers and admins are told, and the reporter gets a receipt if they left an email.
export async function submitReport(token, body, { ip, userAgent }) {
  const project = await findPortal(token);
  if (body.website) throw new HttpError(400, 'rejected', 'This report could not be accepted');
  await verifyTurnstile(body.turnstileToken, ip);

  const contact = body.name || body.email ? { name: body.name || null, email: body.email || null } : null;
  const input = {
    title: body.title,
    description: body.description,
    type: body.type,
    priority: 'medium',
    labels: ['portal'],
    ...(body.errorText?.trim() && { errorText: body.errorText, userAgent }),
  };
  const { ticket, grouped, willEmail } = await createTicket(project, null, input, { source: 'portal', triage: true, contact });

  const leads = project.members.filter((m) => m.role === 'admin' || m.role === 'manager').map((m) => m.user);
  await notify(leads.map((user) => ({
    user, project: project._id, ticket: ticket.id, actor: null, type: 'portal_report',
    ticketKey: ticket.key, ticketTitle: ticket.title, excerpt: body.description ? body.description.slice(0, 200) : null,
  })));
  // Every reporter gets a private page to follow it, also when it joined an existing report (E11).
  const tracker = await createTracker(project, ticket.id, { name: body.name, email: body.email, title: body.title });
  if (tracker.email) emailReporterReceipt(project, { number: ticket.number }, tracker);
  // The reporter only learns the reference, nothing else about the project.
  // (projectId and ticket are for the live update to the team; the controller drops them.)
  return { received: true, reference: ticket.key, alreadyKnown: grouped, willEmail: Boolean(willEmail), trackUrl: trackUrl(tracker.token), projectId: String(project._id), ticket };
}

// ---- The page's logo (portal branding)
export const MAX_LOGO_BYTES = 256 * 1024;
// What a file really is, read from its first bytes: the name and the type the browser claims can
// say anything. SVG is not accepted, because an SVG can carry script.
const IMAGE_SIGNATURES = [
  ['image/png', (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];

export async function setPortalLogo(project, file) {
  if (!file?.buffer?.length) throw new HttpError(400, 'file_required', 'Choose an image for the logo (form field "file")');
  const type = IMAGE_SIGNATURES.find(([, is]) => is(file.buffer))?.[0];
  if (!type) throw new HttpError(400, 'bad_image', 'The logo must be a PNG, JPEG or WebP image');
  const hash = createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
  await PortalLogo.findOneAndUpdate({ project: project._id }, { type, data: file.buffer, hash }, { upsert: true });
  project.portal.brand.logo = hash;
  await project.save();
  return portalSettings(project);
}

export async function removePortalLogo(project) {
  await PortalLogo.deleteOne({ project: project._id });
  project.portal.brand.logo = null;
  await project.save();
  return portalSettings(project);
}

// The logo for the team's own settings page (the portal may still be off).
export async function projectLogo(project) {
  const logo = project.portal.brand?.logo ? await PortalLogo.findOne({ project: project._id }).lean() : null;
  if (!logo) throw new HttpError(404, 'no_logo', 'This page has no logo yet');
  // A lean read gives Mongo's Binary, which Express would send as JSON; hand back the bytes.
  return { ...logo, data: Buffer.from(logo.data.buffer ?? logo.data) };
}

// The logo on the public page: only while the page is on.
export async function publicLogo(token) {
  return projectLogo(await findPortal(token));
}
