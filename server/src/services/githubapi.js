import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { openSecret, sealSecret } from '../security/twoFactor.js';

// GitHub REST API calls with a project's own token (E7). The token is stored encrypted
// (AES-256-GCM, key from the server secret), never sent to the browser, and every call says
// plainly what went wrong: a rejected token, no access to the repository, or the rate limit.

const API = 'https://api.github.com';
let fetchImpl = (...args) => fetch(...args);
// Tests answer like GitHub does, without the network.
export function __setGithubFetch(fn) { fetchImpl = fn ?? ((...args) => fetch(...args)); }

export const sealToken = (token) => sealSecret(token, config.jwt.secret);

export function tokenOf(project) {
  const sealed = project.github?.token;
  if (!sealed) throw new HttpError(409, 'github_token_missing', 'Add a GitHub token in Settings → GitHub first');
  try { return openSecret(sealed, config.jwt.secret); } catch {
    throw new HttpError(409, 'github_token_unreadable', "The saved GitHub token can't be read any more (the server secret changed). Add it again.");
  }
}

export function repoOf(project) {
  const repo = project.source?.repo;
  if (!repo) throw new HttpError(409, 'repo_missing', 'Set the repository in Settings → Source code first');
  return repo;
}

export const hasGithub = (project) => Boolean(project.github?.token && project.source?.repo);

export async function gh(project, method, path, body, { token } = {}) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token ?? tokenOf(project)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'tessera-issue-tracker',
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const where = path.split('?')[0];
  if (res.status === 401) throw new HttpError(502, 'github_token_rejected', 'GitHub rejected the token (expired or revoked?). Add a new one in Settings → GitHub.');
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when = reset ? new Date(reset * 1000).toISOString().slice(11, 16) : 'a while';
    throw new HttpError(503, 'github_rate_limited', `This token used up GitHub's hourly limit. Try again after ${when} UTC.`);
  }
  if (res.status === 403 || res.status === 404) throw new HttpError(502, 'github_no_access', `GitHub says this token can't reach ${where} (${res.status}). Check which repositories and permissions the token has.`);
  throw new HttpError(502, 'github_failed', `GitHub answered ${res.status} for ${where}${data?.message ? `: ${data.message}` : ''}`);
}
