import { redactSecrets } from '../bugs/redact.js';

// HAR files (E12): a browser's record of every request a page made. They are full of cookies,
// tokens and response bodies, so they are cleaned BEFORE they are stored; only the cleaned file
// ever reaches the database.

const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$|token|secret|session|auth|api[-_]?key|password|passwd|signature|csrf|xsrf/i;
const SENSITIVE_NAME = /token|secret|password|passwd|pwd|session|auth|api[-_]?key|apikey|key$|^key|sig$|signature|^code$|access|refresh|jwt|otp|credential|ssn|card|cvv/i;
const REMOVED = '[removed]';

function cleanUrl(raw, counts) {
  let url;
  try { url = new URL(raw); } catch { return raw; }
  let changed = false;
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_NAME.test(name)) { url.searchParams.set(name, REMOVED); counts.params += 1; changed = true; }
  }
  if (url.username || url.password) { url.username = ''; url.password = ''; counts.params += 1; changed = true; }
  return changed ? url.toString() : raw;
}

function cleanValue(value, counts) {
  if (typeof value !== 'string') return value;
  const { text, removed } = redactSecrets(/^https?:\/\//i.test(value) ? cleanUrl(value, counts) : value);
  counts.secrets += removed.reduce((n, r) => n + r.count, 0);
  return text;
}

function cleanHeaders(headers, counts) {
  return (Array.isArray(headers) ? headers : []).map((h) => {
    if (SENSITIVE_HEADER.test(h?.name ?? '')) { counts.headers += 1; return { ...h, value: REMOVED }; }
    return { ...h, value: cleanValue(h?.value, counts) };
  });
}

// JSON bodies keep their shape with sensitive fields blanked; forms likewise; anything else goes.
function cleanJson(value, counts) {
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, counts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      if (SENSITIVE_NAME.test(k)) { counts.params += 1; return [k, REMOVED]; }
      return [k, cleanJson(v, counts)];
    }));
  }
  return cleanValue(value, counts);
}

function cleanPostData(post, counts) {
  if (!post) return post;
  const out = { ...post };
  if (Array.isArray(post.params)) {
    out.params = post.params.map((p) => {
      if (SENSITIVE_NAME.test(p?.name ?? '')) { counts.params += 1; return { ...p, value: REMOVED }; }
      return { ...p, value: cleanValue(p?.value, counts) };
    });
  }
  if (typeof post.text === 'string' && post.text) {
    const mime = String(post.mimeType ?? '').toLowerCase();
    if (mime.includes('json')) {
      try { out.text = JSON.stringify(cleanJson(JSON.parse(post.text), counts)); } catch { out.text = `[removed: ${post.text.length} characters]`; counts.bodies += 1; }
    } else if (mime.includes('x-www-form-urlencoded')) {
      const form = new URLSearchParams(post.text);
      for (const k of [...form.keys()]) if (SENSITIVE_NAME.test(k)) { form.set(k, REMOVED); counts.params += 1; }
      out.text = cleanValue(form.toString(), counts);
    } else {
      out.text = `[removed: ${post.text.length} characters]`;
      counts.bodies += 1;
    }
  }
  return out;
}

export class HarError extends Error {}

// Returns { buffer, removed: { cookies, headers, params, bodies, secrets } }. Throws HarError when
// the file is not a HAR. Response bodies are dropped entirely (their size is kept for analysis).
export function sanitizeHar(buffer) {
  let har;
  try { har = JSON.parse(buffer.toString('utf8')); } catch { throw new HarError('This .har file is not valid JSON'); }
  if (!Array.isArray(har?.log?.entries)) throw new HarError('This is not a HAR file (it has no log.entries)');
  const counts = { cookies: 0, headers: 0, params: 0, bodies: 0, secrets: 0 };
  har.log.entries = har.log.entries.map((e) => {
    const req = e.request ?? {};
    const res = e.response ?? {};
    counts.cookies += (req.cookies?.length ?? 0) + (res.cookies?.length ?? 0);
    const content = res.content ?? {};
    if (typeof content.text === 'string' && content.text) counts.bodies += 1;
    return {
      ...e,
      request: {
        ...req,
        url: typeof req.url === 'string' ? cleanUrl(req.url, counts) : req.url,
        headers: cleanHeaders(req.headers, counts),
        cookies: [],
        queryString: (req.queryString ?? []).map((q) => (SENSITIVE_NAME.test(q?.name ?? '') ? { ...q, value: REMOVED } : { ...q, value: cleanValue(q?.value, counts) })),
        postData: cleanPostData(req.postData, counts),
      },
      response: {
        ...res,
        headers: cleanHeaders(res.headers, counts),
        cookies: [],
        redirectURL: typeof res.redirectURL === 'string' ? cleanUrl(res.redirectURL, counts) : res.redirectURL,
        content: { size: content.size, mimeType: content.mimeType, compression: content.compression },
      },
    };
  });
  return { buffer: Buffer.from(JSON.stringify(har)), removed: counts };
}

const withoutQuery = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).split('?')[0]; } };
const hostOf = (url) => { try { return new URL(url).host; } catch { return 'unknown'; } };
const bytesOf = (e) => Math.max(0, e.response?.bodySize ?? -1, e.response?.content?.size ?? -1);

// What a teammate wants from a HAR: what failed, what was slow or big, and where time went.
export function analyzeHar(har) {
  const entries = har.log.entries;
  const rows = entries.map((e) => ({
    method: e.request?.method ?? 'GET', url: withoutQuery(e.request?.url ?? ''), host: hostOf(e.request?.url ?? ''),
    status: e.response?.status ?? 0, statusText: e.response?.statusText ?? '', time: Math.round(e.time ?? 0), bytes: bytesOf(e),
    type: String(e.response?.content?.mimeType ?? '').split(';')[0] || null,
    start: Date.parse(e.startedDateTime ?? '') || null,
  }));
  const starts = rows.map((r) => r.start).filter(Boolean);
  const ends = rows.filter((r) => r.start).map((r) => r.start + r.time);
  const byHost = new Map();
  for (const r of rows) {
    const h = byHost.get(r.host) ?? { host: r.host, requests: 0, bytes: 0, time: 0, failed: 0 };
    h.requests += 1; h.bytes += r.bytes; h.time += r.time;
    if (r.status === 0 || r.status >= 400) h.failed += 1;
    byHost.set(r.host, h);
  }
  const pick = ({ method, url, status, statusText, time, bytes, type }) => ({ method, url, status, statusText, time, bytes, type });
  return {
    requests: rows.length,
    pages: har.log.pages?.length ?? 0,
    browser: har.log.browser?.name ? `${har.log.browser.name} ${har.log.browser.version ?? ''}`.trim() : null,
    totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
    // From the first request starting to the last one ending (not the sum of request times).
    wallTime: starts.length ? Math.round(Math.max(...ends) - Math.min(...starts)) : null,
    failed: rows.filter((r) => r.status === 0 || r.status >= 400).map(pick),
    redirects: rows.filter((r) => r.status >= 300 && r.status < 400).length,
    slowest: [...rows].sort((a, b) => b.time - a.time).slice(0, 10).map(pick),
    largest: [...rows].sort((a, b) => b.bytes - a.bytes).filter((r) => r.bytes > 0).slice(0, 10).map(pick),
    hosts: [...byHost.values()].sort((a, b) => b.requests - a.requests),
  };
}
