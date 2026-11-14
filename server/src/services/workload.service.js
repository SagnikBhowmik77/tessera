import { config } from '../config.js';
import { addDays, dayToDate, todayIn } from '../dates.js';
import { Ticket, User, PRIORITIES } from '../models/index.js';

// How heavy an open ticket is. Story points win when set; otherwise priority stands in,
// because "five critical bugs" is more work than "five small tasks".
const PRIORITY_WEIGHT = { low: 1, medium: 2, high: 3, critical: 5 };

const BUCKETS = ['overdue', 'thisWeek', 'nextWeek', 'later', 'noDate'];

// The workload heatmap: for each member who can be assigned work, their open tickets
// split by priority and by when they're due, plus a load level compared with the team.
export async function projectWorkload(project) {
  const workers = project.members.filter((m) => m.role !== 'viewer');
  const done = project.statuses.filter((s) => s.category === 'done').map((s) => s.key);
  const open = await Ticket.find(
    { project: project._id, deletedAt: null, status: { $nin: done }, assignee: { $in: workers.map((m) => m.user) } },
    { assignee: 1, priority: 1, dueDate: 1, storyPoints: 1 },
  ).lean();

  const today = todayIn(config.timeZone);
  const start = dayToDate(today);
  const weekEnd = dayToDate(addDays(today, 7));
  const nextWeekEnd = dayToDate(addDays(today, 14));
  const bucketOf = (due) => {
    if (!due) return 'noDate';
    if (due < start) return 'overdue';
    if (due < weekEnd) return 'thisWeek';
    if (due < nextWeekEnd) return 'nextWeek';
    return 'later';
  };

  const users = await User.find({ _id: { $in: workers.map((m) => m.user) } }, 'name email');
  const userJson = new Map(users.map((u) => [String(u._id), u.toJSON()]));
  const rows = new Map(workers.map((m) => [String(m.user), {
    user: userJson.get(String(m.user)) ?? null,
    role: m.role,
    open: 0,
    points: 0,
    score: 0,
    byPriority: Object.fromEntries(PRIORITIES.map((p) => [p, 0])),
    byDue: Object.fromEntries(BUCKETS.map((b) => [b, 0])),
  }]));

  for (const t of open) {
    const row = rows.get(String(t.assignee));
    if (!row) continue;
    row.open += 1;
    row.points += t.storyPoints ?? 0;
    row.score += t.storyPoints ?? PRIORITY_WEIGHT[t.priority];
    row.byPriority[t.priority] += 1;
    row.byDue[bucketOf(t.dueDate)] += 1;
  }

  const list = [...rows.values()].filter((r) => r.user);
  const mean = list.length ? list.reduce((s, r) => s + r.score, 0) / list.length : 0;
  // Levels are relative to this team, with a floor so a team of two light loads
  // doesn't call one of them "overloaded".
  for (const r of list) {
    const ratio = mean ? r.score / mean : 0;
    r.level = r.score >= 8 && ratio >= 1.5 ? 'overloaded'
      : r.score >= 5 && ratio >= 1.15 ? 'heavy'
        : r.score === 0 || ratio < 0.6 ? 'light'
          : 'balanced';
  }
  list.sort((a, b) => b.score - a.score || a.user.name.localeCompare(b.user.name));
  return { members: list, team: { averageScore: Math.round(mean * 10) / 10, openAssigned: open.length } };
}
