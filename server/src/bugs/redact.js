// Removes secrets and personal data from pasted errors and stack traces before they are parsed
// or saved. Traces often carry an Authorization header, a connection string or an API key in a
// log line, and once saved they are visible to the whole project (and to email notifications).
//
// Each rule replaces the secret with "[redacted: <kind>]" and is counted, so the paste box can
// say what was removed. Order matters: specific token formats run before the generic
// "password=..." rule, so a GitHub token is reported as a GitHub token.

const R = (kind, pattern, replace) => ({ kind, pattern, replace });
const tag = (kind) => `[redacted: ${kind}]`;

const RULES = [
  R('private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g),
  // user:password@ inside any URL (database strings, proxies, basic-auth links): keep the user.
  R('password in URL', /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi, (_m, head) => `${head}:${tag('password')}@`),
  R('JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  R('GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g),
  R('AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  R('Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g),
  R('Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g),
  R('Stripe key', /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{16,}/g),
  R('API key', /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g),
  // "Authorization: Bearer abc..." and similar headers.
  R('auth header', /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g, (_m, scheme) => `${scheme} ${tag('auth header')}`),
  // ?token=... &api_key=... in URLs.
  R('secret in URL', /([?&](?:access_token|refresh_token|id_token|token|api_?key|key|secret|password|pwd|sig|signature|code|auth)=)[^&\s"'#]+/gi,
    (_m, name) => `${name}${tag('secret')}`),
  // password=..., "apiKey": "...", client_secret: ... (key names in code, env files and JSON).
  R('secret value', /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?id)(?:[_-][A-Za-z0-9]+)*["']?\s*[:=]\s*["']?)([^\s"',;&}]{4,})/gi,
    (_m, name) => `${name}${tag('secret')}`),
  // Emails: the domain must end in letters, so package versions like react@18.2.0 are left alone.
  R('email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g),
];

// Returns { text, removed } where `removed` is [{ kind, count }] in rule order (empty if nothing was found).
export function redactSecrets(input) {
  let text = String(input ?? '');
  const removed = [];
  for (const { kind, pattern, replace } of RULES) {
    let count = 0;
    text = text.replace(pattern, (...args) => {
      // Don't count (or re-wrap) something an earlier rule already redacted.
      if (args[0].includes('[redacted:')) return args[0];
      count += 1;
      return replace ? replace(...args) : tag(kind);
    });
    if (count) removed.push({ kind, count });
  }
  return { text, removed };
}
