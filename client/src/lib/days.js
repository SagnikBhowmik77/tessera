// Calendar days as YYYY-MM-DD strings, in the team's time zone (India), for the calendar,
// timeline and leave. Plain string maths in UTC, so daylight saving never shifts a day.

export const TEAM_TZ = 'Asia/Kolkata';
export const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TEAM_TZ }).format(new Date());
const utc = (day) => new Date(`${day}T00:00:00Z`);
export const addDays = (day, n) => { const d = utc(day); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400e3);
// 0 = Monday ... 6 = Sunday (weeks start on Monday in India).
export const weekdayOf = (day) => (utc(day).getUTCDay() + 6) % 7;
export const startOfWeek = (day) => addDays(day, -weekdayOf(day));
export const startOfMonth = (day) => `${day.slice(0, 7)}-01`;
export const addMonths = (day, n) => {
  const d = utc(startOfMonth(day));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
export const shortDay = (day) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(utc(day));
export const monthLabel = (day) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(day));
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The leave entry (if any) that has `userId` away on `day`.
export const leaveOn = (leave, userId, day) => (leave ?? []).find((l) => l.user.id === userId && l.from <= day && day <= l.to);

// "on leave until 14 Nov" / "away 20–22 Nov" for a picker, looking two weeks ahead; '' if neither.
export function awayText(leave, userId, today = todayKey()) {
  const now = leaveOn(leave, userId, today);
  if (now) return `on leave until ${shortDay(now.to)}`;
  const soon = (leave ?? []).find((l) => l.user.id === userId && l.from > today && daysBetween(today, l.from) <= 14);
  return soon ? `away ${shortDay(soon.from)}–${shortDay(soon.to)}` : '';
}
