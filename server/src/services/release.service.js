import { config } from '../config.js';
import { addDays, startOfDayIn } from '../dates.js';
import { Ticket } from '../models/index.js';
import { ticketUrl } from './notification.service.js';

const SECTIONS = [
  { type: 'feature', title: 'New features' },
  { type: 'bug', title: 'Bug fixes' },
  { type: 'task', title: 'Other changes' },
];

const prettyDay = (day) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${day}T00:00:00Z`));

// Escape characters that would change the meaning of a Markdown list line.
const md = (s) => String(s).replace(/([\\`*_[\]<>])/g, '\\$1');

// Release notes: everything finished (still done) between two days, grouped by type,
// as structured data and as Markdown ready to paste into GitHub Releases or a changelog.
export async function releaseNotes(project, { from, to, version }) {
  const tz = config.timeZone;
  const start = startOfDayIn(from, tz);
  const end = startOfDayIn(addDays(to, 1), tz);
  const done = project.statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const tickets = await Ticket.find({
    project: project._id, deletedAt: null, triage: { $ne: true }, status: { $in: done },
    resolvedAt: { $gte: start, $lt: end },
  }).sort({ resolvedAt: 1, number: 1 }).populate('assignee', 'name').lean();

  const sections = SECTIONS.map((s) => ({
    title: s.title,
    tickets: tickets.filter((t) => t.type === s.type).map((t) => ({
      key: `${project.key}-${t.number}`,
      title: t.title,
      type: t.type,
      labels: t.labels,
      resolvedAt: t.resolvedAt,
      assignee: t.assignee?.name ?? null,
      links: (t.links ?? []).filter((l) => l.kind === 'pull_request').map((l) => ({ ref: l.ref, url: l.url })),
    })),
  })).filter((s) => s.tickets.length);

  const range = from === to ? prettyDay(to) : `${prettyDay(from)} – ${prettyDay(to)}`;
  const heading = version ? `## ${md(version)} (${range})` : `## ${md(project.name)}: ${range}`;
  const lines = [heading, ''];
  if (!sections.length) lines.push('_Nothing was finished in this period._');
  for (const s of sections) {
    lines.push(`### ${s.title}`, '');
    for (const t of s.tickets) {
      const prs = t.links.map((l) => `[${l.ref}](${l.url})`).join(', ');
      lines.push(`- ${md(t.title)} ([${t.key}](${ticketUrl(project._id, t.key)}))${prs ? ` · ${prs}` : ''}`);
    }
    lines.push('');
  }
  const people = [...new Set(tickets.map((t) => t.assignee?.name).filter(Boolean))].sort();
  if (people.length) lines.push(`Thanks to ${people.map(md).join(', ')}.`);

  return { range: { from, to, timeZone: tz }, version: version ?? null, count: tickets.length, sections, markdown: `${lines.join('\n').trim()}\n` };
}
