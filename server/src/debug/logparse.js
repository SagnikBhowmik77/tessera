// Log viewer (E12): reads a plain-text or JSON-lines log into lines with a level and a time, so
// it can be filtered by level, searched, and jumped through error by error.

export const LEVELS = ['error', 'warn', 'info', 'debug'];
const WORD = /\b(FATAL|CRITICAL|CRIT|ERROR|ERR|SEVERE|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE|VERBOSE)\b/;
const levelOfWord = (w) => {
  const u = w.toUpperCase();
  if (/^(FATAL|CRITICAL|CRIT|ERROR|ERR|SEVERE)$/.test(u)) return 'error';
  if (u.startsWith('WARN')) return 'warn';
  if (u === 'INFO' || u === 'NOTICE') return 'info';
  return 'debug';
};
// pino / bunyan numbers: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
const levelOfNumber = (n) => (n >= 50 ? 'error' : n >= 40 ? 'warn' : n >= 30 ? 'info' : 'debug');
const TIME = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

function jsonLine(text) {
  if (!text.startsWith('{')) return null;
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object') return null;
    const raw = o.level ?? o.severity ?? o.lvl;
    const level = typeof raw === 'number' ? levelOfNumber(raw) : typeof raw === 'string' && WORD.test(raw.toUpperCase()) ? levelOfWord(raw.toUpperCase().match(WORD)[1]) : null;
    const t = o.time ?? o.timestamp ?? o['@timestamp'] ?? o.ts;
    const at = typeof t === 'number' ? new Date(t > 1e12 ? t : t * 1000) : typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t) : null;
    const msg = o.msg ?? o.message ?? null;
    const err = o.err?.stack ?? o.error?.stack ?? o.stack ?? null;
    return { level, at, text: [msg, err].filter(Boolean).join('\n') || text };
  } catch { return null; }
}

// Lines that continue the one before (stack frames, wrapped messages) take its level, so an error's
// stack stays with it when filtering.
const continues = (text) => /^\s+\S/.test(text) || /^\s*(at |Caused by:|\.\.\. \d+ more|File ")/.test(text);
// A time with a zone (Z or +05:30) is an exact moment. One without a zone could be any zone, so it
// is shown as written and not used for the log's time range.
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/;
const isoOf = (s) => {
  if (!ZONED.test(s)) return null;
  const d = new Date(s.replace(' ', 'T').replace(',', '.'));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function parseLog(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  let prev = null;
  lines.forEach((raw, i) => {
    const j = jsonLine(raw.trim());
    let level = j?.level ?? null;
    let at = j?.at ?? null;
    let time = null;
    if (!j) {
      const w = raw.match(WORD);
      if (w) level = levelOfWord(w[1]);
      const t = raw.match(TIME);
      if (t) { time = t[1]; at = isoOf(t[1]); }
    }
    let continuation = false;
    if (!level && prev && continues(raw)) { level = prev.level; continuation = true; }
    const iso = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
    const line = { n: i + 1, level, at: iso, time: time ?? iso, text: j ? j.text : raw, continuation };
    out.push(line);
    prev = line;
  });
  const counts = Object.fromEntries([...LEVELS, 'other'].map((l) => [l, 0]));
  // Count entries, not their stack lines.
  for (const l of out) if (!l.continuation) counts[l.level ?? 'other'] += 1;
  const times = out.map((l) => l.at).filter(Boolean).sort();
  return { lines: out, counts, from: times[0] ?? null, to: times.at(-1) ?? null };
}
