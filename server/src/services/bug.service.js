import { parseError, parseUserAgent } from '../bugs/stacktrace.js';
import { redactSecrets } from '../bugs/redact.js';
import { rankSimilar } from '../bugs/similar.js';
import { Ticket } from '../models/index.js';
import { applySourceMaps } from './sourcemap.service.js';
import { impactInputs, impactScore, muteJson, relatedFixes, topBrowser } from './errorinsights.service.js';

const keyOf = (project, number) => `${project.key}-${number}`;
const fence = (text) => `\`\`\`text\n${text.replace(/```/g, '`​``')}\n\`\`\``;

// The top frame from your own code, as "fn (file:line:col)".
function where(error) {
  const f = error.frames.find((x) => x.inApp) ?? error.frames[0];
  if (!f) return null;
  const pos = [f.file, f.line, f.column].filter((x) => x !== null && x !== undefined).join(':');
  return f.fn ? `${f.fn} (${pos})` : pos;
}

// Everything the "paste an error" box shows before the ticket is created.
// Secrets and emails are removed first, so nothing below (title, description, stored error) ever sees them.
export function analyzeError(rawText, userAgent) {
  const { text, removed } = redactSecrets(rawText);
  const error = parseError(text);
  const environment = parseUserAgent(userAgent);
  const headline = [error.type, error.message].filter(Boolean).join(': ') || 'Error';
  const title = headline.length > 200 ? `${headline.slice(0, 197)}…` : headline;
  const place = where(error);
  const env = environment ? [environment.browser, environment.os].filter(Boolean).join(' on ') : null;
  const description = [
    `**Error:** \`${headline.replace(/`/g, "'")}\``,
    place && `**Where:** \`${place.replace(/`/g, "'")}\``,
    error.causes.length > 0 && `**Caused by:** ${error.causes.map((c) => `\`${c.type}${c.message ? `: ${c.message}` : ''}\``).join(' → ')}`,
    env && `**Environment:** ${env}`,
    '',
    fence(String(text).trim().slice(0, 15_000)),
  ].filter((x) => typeof x === 'string').join('\n');
  return { error: { ...error, environment }, suggested: { title, description, type: 'bug' }, redacted: removed };
}

// Shape stored on the ticket (what was parsed, plus when and how often it was seen).
export function errorRecord(analysis, at = new Date()) {
  const { language, type, message, frames, causes, fingerprint, environment, unminified } = analysis.error;
  return { language, type, message, frames, causes, fingerprint, environment, unminified: unminified ?? null, occurrences: 1, firstSeenAt: at, lastSeenAt: at };
}

// Uploaded source maps turn minified frames back into original code (E6B). The fingerprint is
// recomputed from the original frames, so the same crash groups across builds, and the suggested
// description says where it came from in the original source.
export async function withSourceMaps(project, analysis, release = null) {
  const { error, mapped } = await applySourceMaps(project, analysis.error, { release });
  if (!mapped) return analysis;
  const top = error.frames.find((f) => f.inApp && f.minified) ?? error.frames.find((f) => f.minified);
  const place = `${top.fn ?? 'anonymous'} (${top.file}:${top.line}:${top.column})`.replace(/`/g, "'");
  const line = `**Original source:** \`${place}\` (from the source maps of release ${error.unminified.releases.join(', ')})`;
  const fence = '\n\n```text';
  const { description } = analysis.suggested;
  return {
    ...analysis,
    error,
    suggested: { ...analysis.suggested, description: description.includes(fence) ? description.replace(fence, `\n${line}${fence}`) : description },
  };
}

export function findByFingerprint(project, fingerprint) {
  return Ticket.findOne({ project: project._id, 'error.fingerprint': fingerprint, deletedAt: null }).sort({ number: 1 });
}

const brief = (project, t) => ({
  number: t.number, key: keyOf(project, t.number), title: t.title, status: t.status, type: t.type,
});

// Paste box: parsed error, a suggested title/description, and whether it's been seen before.
export async function previewError(project, { text, userAgent }) {
  const analysis = await withSourceMaps(project, analyzeError(text, userAgent));
  const existing = await findByFingerprint(project, analysis.error.fingerprint);
  return {
    ...analysis,
    seenBefore: existing ? { ...brief(project, existing), occurrences: existing.error.occurrences, muted: muteJson(existing.error)?.active ?? false } : null,
    // Fix memory: finished tickets for crashes that look like this one, with their commits/PRs.
    fixedBefore: existing ? [] : await relatedFixes(project, analysis.error),
  };
}

// Duplicate warning while typing a new ticket.
export async function similarTickets(project, { title, description, exclude }) {
  const tickets = await Ticket.find(
    { project: project._id, deletedAt: null, ...(exclude && { number: { $ne: exclude } }) },
    { number: 1, title: 1, labels: 1, description: 1, status: 1, type: 1 },
  ).sort({ number: -1 }).limit(5000).lean();
  return rankSimilar(tickets, { title, description }).map((m) => ({
    ...brief(project, m.ticket), score: m.score, because: m.because,
  }));
}

// The project's errors, grouped by fingerprint: one ticket per distinct crash.
export async function errorGroups(project) {
  const rows = await Ticket.find({ project: project._id, deletedAt: null, error: { $ne: null } })
    .sort({ 'error.lastSeenAt': -1 })
    .limit(500)
    .lean();
  const done = new Set(project.statuses.filter((s) => s.category === 'done').map((s) => s.key));
  const inputs = await impactInputs(project._id, rows.map((t) => t._id));
  return rows.map((t) => ({
    ...brief(project, t),
    resolved: done.has(t.status),
    language: t.error.language,
    errorType: t.error.type,
    message: t.error.message,
    occurrences: t.error.occurrences,
    firstSeenAt: t.error.firstSeenAt,
    lastSeenAt: t.error.lastSeenAt,
    impact: (({ score, level }) => ({ score, level }))(impactScore({ ...(inputs.get(String(t._id)) ?? { recent: 0, people: 0, comebacks: 0 }), priority: t.priority })),
    recent: inputs.get(String(t._id))?.recent ?? 0,
    topBrowser: topBrowser(inputs.get(String(t._id))?.browsers ?? []),
    muted: muteJson(t.error)?.active ?? false,
  }));
}
