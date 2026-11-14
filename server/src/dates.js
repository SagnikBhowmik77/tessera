import { config } from './config.js';

// Today's calendar date where the team is (default India), as YYYY-MM-DD.
// Due dates are calendar dates, so "overdue" must not flip at 5:30 am IST (UTC midnight).
export function todayIn(timeZone = config.timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// A YYYY-MM-DD date as the UTC-midnight Date it is stored as.
export const dayToDate = (day) => new Date(`${day}T00:00:00Z`);

// How far `timeZone` is ahead of UTC at that moment (handles daylight saving where it exists).
function offsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utcMs;
}

// The instant a calendar day starts in `timeZone` (e.g. 2026-11-05 in India = 2026-11-04T18:30Z).
export function startOfDayIn(day, timeZone = config.timeZone) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  return new Date(guess - offsetMs(guess, timeZone));
}

export function addDays(day, n) {
  const d = dayToDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
