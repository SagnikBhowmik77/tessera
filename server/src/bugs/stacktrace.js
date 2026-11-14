import { createHash } from 'node:crypto';

// Turns a pasted error (a stack trace from JavaScript, Python, Java, .NET, Go, PHP, Ruby or Rust, or just an
// error line) into structured data: language, error type, message, and frames newest-first.
// It never throws; text it doesn't recognise comes back as language "unknown".

const MAX_FRAMES = 50;

const JS_V8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const JS_GECKO = /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/;
const PY_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?$/;
const JAVA_FRAME = /^\s*at ([\w$.<>\-/]+)\(([^:()]+?)(?::(\d+))?\)\s*$/;
const DOTNET_FRAME = /^\s*at (.+?\(.*?\))(?: in (.+?):line (\d+))?\s*$/;
const DOTNET_HINT = /^\s*at .+\) in .+:line \d+\s*$/m;
const JAVA_HEADER = /^(?:Exception in thread ".*?" )?([a-zA-Z_$][\w$]*(?:\.[\w$]+)+)(?::\s*(.*))?$/;
const ERROR_LINE = /^(?:Uncaught\s+)?(?:\(in promise\)\s+)?([A-Za-z_$][\w$.]*(?:Error|Exception|Exit|Interrupt|Warning|Fault|Panic))(?::\s*(.*))?$/;
const GENERIC_ERROR_LINE = /^([A-Za-z_$][\w$.]*):\s+(.+)$/;

// Go, PHP, Ruby and Rust (E5B).
const GO_FILE = /^\s+(\S+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;
const PHP_FRAME = /^#\d+\s+(.+?)\((\d+)\):\s+(.+?)(?:\(.*\))?\s*$/;
// After "Uncaught" any class name counts; without it, only names ending in Exception or Error.
const PHP_HEAD = /^(?:PHP\s+)?(?:Fatal error:\s+)?(?:Uncaught\s+([A-Za-z_\\][\w\\]*)|([A-Za-z_\\][\w\\]*(?:Exception|Error))):\s*(.*?)(?:\s+in\s+(\S+?\.php)(?::(\d+)|\s+on line\s+(\d+)))?\s*$/;
const RUBY_FRAME = /^\s*(?:from\s+)?(.+?):(\d+):in\s+[`'](.+?)'(?::\s*(.*))?$/;
const RUST_PANIC = /^thread '.*?' panicked at (?:'(.*)', )?(.+?):(\d+):(\d+):?\s*$/;
const RUST_FN = /^\s*\d+:\s+(?:0x[0-9a-f]+ - )?(.+?)\s*$/;
const RUST_AT = /^\s+at (.+?):(\d+)(?::(\d+))?\s*$/;

const NOT_APP = {
  javascript: (f) => /node_modules|^node:|^internal\/|<anonymous>|chrome-extension:|webpack\/bootstrap|^native$/.test(f.file || ''),
  python: (f) => /site-packages|dist-packages|[\\/]lib[\\/]python\d|<frozen /.test(f.file || ''),
  java: (f) => /^(java|javax|jakarta|jdk|sun|com\.sun|kotlin|org\.springframework|org\.apache|org\.hibernate|io\.netty)\./.test(f.fn || ''),
  dotnet: (f) => /^(System|Microsoft)\./.test(f.fn || ''),
  go: (f) => /\/usr\/local\/go\/|\/go\/pkg\/mod\/|\/src\/runtime\//.test(f.file || '') || /^runtime\./.test(f.fn || ''),
  php: (f) => /[\\/]vendor[\\/]/.test(f.file || '') || f.file === '[internal function]',
  ruby: (f) => /[\\/]gems[\\/]|[\\/]rubygems[\\/]|^<internal:|[\\/]lib[\\/]ruby[\\/]/.test(f.file || ''),
  rust: (f) => /^\/rustc\/|[\\/]\.cargo[\\/]registry[\\/]|[\\/]library[\\/](std|core|alloc)[\\/]/.test(f.file || '') || /^(std|core|alloc|rust_begin_unwind|__rust|backtrace)\b/.test(f.fn || ''),
};

const lines = (text) => text.replace(/\r\n?/g, '\n').split('\n');

function detect(text) {
  if (/Traceback \(most recent call last\)/.test(text) || /^\s*File ".+", line \d+/m.test(text)) return 'python';
  if (/^thread '.*?' panicked at /m.test(text)) return 'rust';
  if (/^goroutine \d+ \[/m.test(text) || (/^panic: /m.test(text) && /\.go:\d+/.test(text))) return 'go';
  // "Uncaught X" alone is also how browsers print JavaScript errors, so PHP needs a .php file too.
  if (/^#\d+\s+.+\.php\(\d+\): /m.test(text) || /\.php(?::\d+| on line \d+)/.test(text)) return 'php';
  if (/:\d+:in [`'][^']+'/.test(text)) return 'ruby';
  if (DOTNET_HINT.test(text) || /^\s*(?:Unhandled exception\. )?(System|Microsoft)\.[\w.]+(Exception|Error)\b/m.test(text)) return 'dotnet';
  if (/\.(java|kt|scala):\d+\)/.test(text) || /\((Native Method|Unknown Source)\)/.test(text) || /^\s*Caused by: /m.test(text)) return 'java';
  if (lines(text).some((l) => JS_V8.test(l) || JS_GECKO.test(l))) return 'javascript';
  return 'unknown';
}

function firstErrorLine(all, { fromEnd = false } = {}) {
  const list = fromEnd ? [...all].reverse() : all;
  for (const raw of list) {
    const line = raw.trim();
    if (!line || /^at\s/.test(line) || /^File "/.test(line)) continue;
    const m = ERROR_LINE.exec(line) || GENERIC_ERROR_LINE.exec(line);
    if (m) return { type: m[1], message: (m[2] ?? '').trim() };
  }
  return null;
}

function parseJs(all) {
  const frames = [];
  for (const line of all) {
    let m = JS_V8.exec(line);
    if (m) {
      frames.push({ fn: m[1]?.replace(/^(async|new) /, '') || null, file: m[2], line: Number(m[3]), column: Number(m[4]) });
      continue;
    }
    m = JS_GECKO.exec(line);
    if (m) frames.push({ fn: m[1] || null, file: m[2], line: Number(m[3]), column: Number(m[4]) });
  }
  return { head: firstErrorLine(all), frames };
}

function parsePython(all) {
  const frames = [];
  for (const line of all) {
    const m = PY_FRAME.exec(line);
    if (m) frames.push({ fn: m[3]?.trim() || null, file: m[1], line: Number(m[2]), column: null });
  }
  // Python prints the oldest call first and the error last.
  return { head: firstErrorLine(all, { fromEnd: true }), frames: frames.reverse() };
}

function parseJava(all) {
  const frames = [];
  const causes = [];
  let head = null;
  let inCause = false;
  for (const raw of all) {
    const line = raw.trim();
    const cause = /^Caused by: (.+)$/.exec(line);
    if (cause) {
      const m = JAVA_HEADER.exec(cause[1]) || ERROR_LINE.exec(cause[1]);
      if (m) causes.push({ type: m[1], message: (m[2] ?? '').trim() });
      inCause = true;
      continue;
    }
    if (!head) {
      const m = JAVA_HEADER.exec(line);
      if (m && !line.startsWith('at ')) { head = { type: m[1], message: (m[2] ?? '').trim() }; continue; }
    }
    const f = JAVA_FRAME.exec(raw);
    // Only the top exception's frames: "Caused by" frames belong to the cause.
    if (f && !inCause) frames.push({ fn: f[1], file: f[2], line: f[3] ? Number(f[3]) : null, column: null });
  }
  return { head, frames, causes };
}

function parseDotnet(all) {
  const frames = [];
  for (const line of all) {
    const m = DOTNET_FRAME.exec(line);
    if (m) frames.push({ fn: m[1].replace(/\(.*\)$/, ''), file: m[2] ?? null, line: m[3] ? Number(m[3]) : null, column: null });
  }
  const headLine = all.find((l) => /^\s*(?:Unhandled exception\. )?[\w.]+(Exception|Error)\b/.test(l));
  let head = null;
  if (headLine) {
    const m = /^\s*(?:Unhandled exception\. )?([\w.]+)(?::\s*(.*))?$/.exec(headLine.trim());
    if (m) head = { type: m[1], message: (m[2] ?? '').replace(/\s*--->.*$/, '').trim() };
  }
  return { head, frames };
}

// Go: "panic: ..." (or "fatal error: ..."), then per goroutine a function line followed by an
// indented "file.go:line +0x.." line. Only the first goroutine (the one that panicked) is read.
function parseGo(all) {
  let head = null;
  for (const raw of all) {
    const m = /^(panic|fatal error):\s*(.*)$/.exec(raw.trim());
    if (m) {
      const runtime = /^runtime error:\s*(.*)$/.exec(m[2]);
      head = runtime ? { type: 'runtime error', message: runtime[1] } : { type: m[1], message: m[2].replace(/\s*\[recovered\]$/, '') };
      break;
    }
  }
  const frames = [];
  let goroutines = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (/^goroutine \d+ \[/.test(all[i])) { goroutines += 1; if (goroutines > 1) break; continue; }
    const f = GO_FILE.exec(all[i]);
    if (!f || i === 0) continue;
    const fnLine = all[i - 1].trim();
    if (!fnLine || GO_FILE.test(all[i - 1])) continue;
    const fn = fnLine.replace(/^created by\s+/, '').replace(/\s+in goroutine \d+$/, '').replace(/\(.*\)$/, '');
    frames.push({ fn: fn || null, file: f[1], line: Number(f[2]), column: null });
  }
  return { head, frames };
}

// PHP: "Uncaught Exception: msg in /path/File.php:42" and "#0 /path/Caller.php(17): Class->method()".
// Each "#n file(line): call()" line is the place `call` was made from, so the error happened inside
// call #0, at the file and line from the error message.
function parsePhp(all) {
  let head = null;
  let at = null;
  for (const raw of all) {
    const m = PHP_HEAD.exec(raw.trim());
    if (m) {
      head = { type: m[1] ?? m[2], message: m[3].trim() };
      if (m[4]) at = { file: m[4], line: Number(m[5] ?? m[6]) };
      break;
    }
  }
  if (head && !at) {
    const thrown = all.map((l) => /thrown in (\S+?\.php) on line (\d+)/.exec(l)).find(Boolean);
    if (thrown) at = { file: thrown[1], line: Number(thrown[2]) };
  }
  const calls = [];
  for (const raw of all) {
    const m = PHP_FRAME.exec(raw.trim());
    if (m) calls.push({ file: m[1], line: Number(m[2]), fn: m[3].trim() });
  }
  const frames = [];
  if (at) frames.push({ fn: calls[0]?.fn ?? null, file: at.file, line: at.line, column: null });
  calls.forEach((c, k) => frames.push({ fn: calls[k + 1]?.fn ?? '{main}', file: c.file, line: c.line, column: null }));
  return { head, frames };
}

// Ruby: "app/models/order.rb:42:in `total': undefined method ... (NoMethodError)" and "from ..." lines.
// Ruby 3.4 quotes with ' instead of `.
function parseRuby(all) {
  const frames = [];
  let head = null;
  for (const raw of all) {
    const m = RUBY_FRAME.exec(raw);
    if (!m) continue;
    frames.push({ fn: m[3], file: m[1], line: Number(m[2]), column: null });
    if (!head && m[4]) {
      const typed = /^(.*)\s+\(([A-Z][\w:]*)\)\s*$/.exec(m[4]);
      head = typed ? { type: typed[2], message: typed[1].trim() } : { type: null, message: m[4].trim() };
    }
  }
  if (!head) {
    // Rails logs put the error first: "NoMethodError (undefined method ...):".
    for (const raw of all) {
      const m = /^([A-Z][\w:]*(?:Error|Exception|Invalid|NotFound))\s*\((.*)\):?\s*$/.exec(raw.trim());
      if (m) { head = { type: m[1], message: m[2] }; break; }
    }
  }
  return { head: head ?? firstErrorLine(all), frames };
}

// Rust: "thread 'main' panicked at src/main.rs:5:10:" with the message on the next line (or, before
// Rust 1.73, quoted on the same line), then an optional "stack backtrace:" of "N: fn" / "at file:line".
function parseRust(all) {
  let head = null;
  let at = null;
  for (let i = 0; i < all.length; i += 1) {
    const m = RUST_PANIC.exec(all[i].trim());
    if (!m) continue;
    const message = m[1] ?? all.slice(i + 1).find((l) => l.trim())?.trim() ?? '';
    head = { type: 'panic', message };
    at = { file: m[2], line: Number(m[3]), column: Number(m[4]) };
    break;
  }
  const frames = [];
  const start = all.findIndex((l) => /^stack backtrace:/.test(l.trim()));
  if (start >= 0) {
    for (let i = start + 1; i < all.length; i += 1) {
      const fn = RUST_FN.exec(all[i]);
      if (!fn) continue;
      const loc = RUST_AT.exec(all[i + 1] ?? '');
      frames.push({ fn: fn[1].replace(/::h[0-9a-f]{16}$/, ''), file: loc?.[1] ?? null, line: loc ? Number(loc[2]) : null, column: loc?.[3] ? Number(loc[3]) : null });
    }
  }
  if (!frames.length && at) frames.push({ fn: null, ...at });
  return { head, frames };
}

const PARSERS = {
  javascript: parseJs, python: parsePython, java: parseJava, dotnet: parseDotnet, go: parseGo, php: parsePhp, ruby: parseRuby, rust: parseRust,
};

export function parseError(text) {
  const raw = String(text ?? '').slice(0, 50_000);
  const language = detect(raw);
  const all = lines(raw);
  const parsed = language === 'unknown' ? { head: firstErrorLine(all), frames: [] } : PARSERS[language](all);
  const isLibrary = NOT_APP[language];
  const frames = parsed.frames.slice(0, MAX_FRAMES).map((f) => ({ ...f, inApp: isLibrary ? !isLibrary(f) : true }));
  const firstLine = all.find((l) => l.trim())?.trim().slice(0, 300) ?? '';
  const error = {
    language,
    type: parsed.head?.type ?? null,
    message: (parsed.head ? parsed.head.message : firstLine).slice(0, 1000),
    frames,
    causes: (parsed.causes ?? []).slice(0, 5),
  };
  error.recognized = language !== 'unknown' || Boolean(parsed.head);
  error.fingerprint = fingerprintOf(error);
  return error;
}

// File names without folders, query strings or build hashes (main.3f9a1c2b.js -> main.js),
// so the same bug from two deploys still groups together.
const fileKey = (file) => (file || '')
  .split(/[?#]/)[0]
  .split(/[\\/]/)
  .pop()
  .replace(/[.-][0-9a-f]{6,}(?=\.)/gi, '');

// Variable parts of a message (numbers, ids, quoted values) replaced, so
// "user 123 not found" and "user 456 not found" group together.
export const normalizeMessage = (m) => (m || '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
  .replace(/0x[0-9a-f]+/gi, '<hex>')
  .replace(/(["'`]).*?\1/g, '"…"')
  .replace(/\d+/g, '#')
  .trim()
  .toLowerCase();

// Same error, same place in your code -> same fingerprint. Line numbers are left out
// because they move with every edit; library frames are left out when your own exist.
export function fingerprintOf(error) {
  const own = error.frames.filter((f) => f.inApp);
  const top = (own.length ? own : error.frames).slice(0, 3).map((f) => `${fileKey(f.file)}:${(f.fn || '?').replace(/<anonymous>|\d+/g, '')}`);
  const parts = [error.language, error.type || '', ...(top.length ? top : [normalizeMessage(error.message)])];
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

// Enough to say "Chrome 130 on Windows" in a bug report.
export function parseUserAgent(ua) {
  if (!ua) return null;
  const s = String(ua);
  const version = (re) => re.exec(s)?.[1]?.split('.')[0];
  let browser = null;
  if (/Edg\//.test(s)) browser = `Edge ${version(/Edg\/([\d.]+)/)}`;
  else if (/OPR\//.test(s)) browser = `Opera ${version(/OPR\/([\d.]+)/)}`;
  else if (/Firefox\//.test(s)) browser = `Firefox ${version(/Firefox\/([\d.]+)/)}`;
  else if (/Chrome\//.test(s)) browser = `Chrome ${version(/Chrome\/([\d.]+)/)}`;
  else if (/Version\/[\d.]+.*Safari\//.test(s)) browser = `Safari ${version(/Version\/([\d.]+)/)}`;
  let os = null;
  if (/iPhone|iPad/.test(s)) os = `iOS ${(/OS (\d+)[_.](\d+)/.exec(s) || []).slice(1, 3).join('.')}`.trim();
  else if (/Android/.test(s)) os = `Android ${version(/Android ([\d.]+)/) ?? ''}`.trim();
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return browser || os ? { browser, os } : null;
}
