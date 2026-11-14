import { z } from 'zod';
import { HttpError } from '../errors.js';
import { Project, Ticket } from '../models/index.js';
import { createTicket } from './ticket.service.js';
import { emailReporterReceipt, notify, trackUrl } from './notification.service.js';
import { createTracker } from './tracking.service.js';
import { uploadAttachment } from './attachment.service.js';
import { parseUserAgent } from '../bugs/stacktrace.js';

// The bug-report widget (E6C): a "Report a problem" button on a team's own website. It files the
// same kind of report as the public portal page (into the triage inbox), plus what only the page
// itself knows: its address, the screen size, a screenshot the person took and marked up, and,
// only if they tick the box after seeing them, the page's recent console errors.
// It works only when a manager turned it on and only from the websites they listed.

export const widgetSchema = z.object({
  title: z.string().trim().min(3, 'Give the problem a short title').max(200),
  description: z.string().trim().max(10_000).default(''),
  type: z.enum(['bug', 'feature']).default('bug'),
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).optional().or(z.literal('').transform(() => undefined)),
  page: z.object({
    url: z.string().max(2000).optional(),
    title: z.string().max(300).optional(),
    viewport: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  }).default({}),
  // Sent only when the person ticked "include console errors".
  consoleErrors: z.array(z.object({ message: z.string().max(2000), stack: z.string().max(10_000).optional() })).max(10).default([]),
  screenshot: z.string().max(4_000_000).optional(),
  website: z.string().max(200).optional(), // honeypot: people never fill it in
});

const pageOf = (url) => {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? `${u.origin}${u.pathname}` : null;
  } catch { return null; }
};

// "data:image/png;base64,...." -> Buffer, PNG or JPEG only, at most 3 MB.
function screenshotOf(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '');
  if (!m) throw new HttpError(400, 'bad_screenshot', 'The screenshot must be a PNG or JPEG image');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > 3 * 1024 * 1024) throw new HttpError(413, 'too_large', 'The screenshot is too big (3 MB at most)');
  return { buffer, ext: m[1] === 'png' ? 'png' : 'jpg' };
}

const code = (s) => s.replace(/`/g, "'");

export async function submitWidget(token, body, { origin, userAgent }) {
  const project = await Project.findOne({ 'portal.token': token, 'portal.enabled': true, archivedAt: null });
  if (!project || !project.portal.widget?.enabled) throw new HttpError(404, 'widget_off', 'The report button is not turned on for this project');
  if (!project.portal.widget.origins.includes(String(origin ?? '').toLowerCase())) {
    throw new HttpError(403, 'origin_not_allowed', 'The report button is not allowed on this website');
  }
  const parsed = widgetSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Check the report', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  const r = parsed.data;
  if (r.website) throw new HttpError(400, 'rejected', 'This report could not be accepted');
  const shot = r.screenshot ? screenshotOf(r.screenshot) : null;

  const env = parseUserAgent(userAgent);
  const page = r.page.url ? pageOf(r.page.url) : null;
  const facts = [
    page && `**Page:** ${page}${r.page.title ? ` (${r.page.title.slice(0, 120)})` : ''}`,
    env && `**Browser:** ${[env.browser, env.os].filter(Boolean).join(' on ')}`,
    r.page.viewport && `**Window:** ${r.page.viewport}`,
    r.consoleErrors.length > 0 && `**Console errors (shared by the reporter):**\n${r.consoleErrors.map((e) => `- \`${code(e.message.slice(0, 300))}\``).join('\n')}`,
  ].filter(Boolean);
  const description = [r.description, facts.length ? `---\n_Sent with the report button:_\n${facts.join('\n')}` : ''].filter(Boolean).join('\n\n');
  // The first console error is parsed like a pasted one, so it groups with the same crash.
  const first = r.consoleErrors[0];
  const errorText = first ? (first.stack?.includes(first.message) ? first.stack : [first.message, first.stack].filter(Boolean).join('\n')) : null;

  const contact = r.name || r.email ? { name: r.name || null, email: r.email || null } : null;
  const { ticket, grouped, willEmail } = await createTicket(project, null, {
    title: r.title, description, type: r.type, priority: 'medium', labels: ['widget'],
    ...(errorText && { errorText, userAgent }),
  }, { source: 'portal', triage: true, contact, occurrence: { page } });

  let screenshot = false;
  if (shot) {
    const doc = await Ticket.findById(ticket.id);
    await uploadAttachment(project, { user: null, role: 'viewer' }, doc, { originalname: `screenshot.${shot.ext}`, buffer: shot.buffer });
    screenshot = true;
  }

  const leads = project.members.filter((m) => m.role === 'admin' || m.role === 'manager').map((m) => m.user);
  await notify(leads.map((user) => ({
    user, project: project._id, ticket: ticket.id, actor: null, type: 'portal_report',
    ticketKey: ticket.key, ticketTitle: ticket.title, excerpt: r.description ? r.description.slice(0, 200) : null,
  })));
  const tracker = await createTracker(project, ticket.id, { name: r.name, email: r.email, title: r.title });
  if (tracker.email) emailReporterReceipt(project, { number: ticket.number }, tracker);
  return { received: true, reference: ticket.key, alreadyKnown: grouped, willEmail: Boolean(willEmail), trackUrl: trackUrl(tracker.token), screenshot, projectId: String(project._id), ticket };
}
