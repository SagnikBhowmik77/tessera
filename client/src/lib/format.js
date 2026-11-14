// Display helpers shared across the app.

export const PRIORITIES = [
  { key: 'critical', label: 'Critical', dot: 'bg-prio-critical', text: 'text-prio-critical', color: 'var(--c-prio-critical)' },
  { key: 'high', label: 'High', dot: 'bg-prio-high', text: 'text-prio-high', color: 'var(--c-prio-high)' },
  { key: 'medium', label: 'Medium', dot: 'bg-prio-medium', text: 'text-prio-medium', color: 'var(--c-prio-medium)' },
  { key: 'low', label: 'Low', dot: 'bg-prio-low', text: 'text-prio-low', color: 'var(--c-prio-low)' },
];
export const priorityOf = (key) => PRIORITIES.find((p) => p.key === key) ?? PRIORITIES[2];

export const TYPES = [
  { key: 'bug', label: 'Bug' },
  { key: 'feature', label: 'Feature' },
  { key: 'task', label: 'Task' },
  { key: 'epic', label: 'Epic' },
];

export const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', developer: 'Developer', viewer: 'Viewer' };
const RANK = { viewer: 1, developer: 2, manager: 3, admin: 4 };
export const roleAtLeast = (role, min) => (RANK[role] ?? 0) >= RANK[min];

// The same edit rule the API uses: managers edit anything; developers what they reported or own.
export function canEditTicket(project, ticket, userId) {
  if (!project || !ticket) return false;
  if (roleAtLeast(project.myRole, 'manager')) return true;
  if (!roleAtLeast(project.myRole, 'developer')) return false;
  return ticket.reporter?.id === userId || ticket.assignee?.id === userId;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function timeAgo(date) {
  const diff = (new Date(date).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return formatDate(date);
}

export const formatDate = (date) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(date));
export const formatDateTime = (date) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(date));

// Due dates are calendar days (YYYY-MM-DD) in the team's time zone.
export function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
export function dueState(due, done) {
  if (!due || done) return null;
  const today = todayKey();
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'later';
}
export const formatDue = (due) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${due}T00:00:00Z`));

export const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// A steady colour per person, so avatars are recognisable at a glance.
const AVATAR_COLORS = ['bg-violet-500', 'bg-teal-500', 'bg-pink-500', 'bg-sky-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500', 'bg-indigo-500'];
export function avatarColor(id = '') {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
