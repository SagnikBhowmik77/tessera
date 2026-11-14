// The one way the app talks to the Tessera API.
// In dev VITE_API_URL is empty and Vite proxies /api; in production it is the API's own address.
export const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const TOKEN_KEY = 'tessera.token';

export const tokenStore = {
  get() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode: lasts until reload */ }
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
  },
};

// Words for the failures the server can't word itself (see docs/voice.md): plain, and saying what
// to do next. The server's own messages are used whenever it sends one, except for its generic
// "internal" error, which says nothing the person can act on.
function fallbackMessage(status, code) {
  if (status === 0) return "Can't reach Tessera. Check your connection, then try again.";
  if (code === 'internal' || status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  if (status === 429) return 'Too many requests in a short time. Wait a few seconds, then try again.';
  if (status === 413) return 'That is too big to send. Try a smaller file or less text.';
  if (status === 403) return "You don't have permission to do that. Ask a project manager or admin.";
  if (status === 404) return "That isn't here any more. It may have been deleted or moved.";
  return "That didn't work. Try again, and if it keeps happening, reload the page.";
}

export class ApiError extends Error {
  constructor(status, error = {}) {
    super((error.code !== 'internal' && error.message) || fallbackMessage(status, error.code));
    this.status = status;
    this.code = error.code || 'unknown';
    this.details = error.details || [];
  }

  // { title: 'Title is required', … } for showing next to form fields.
  fieldErrors() {
    return Object.fromEntries((Array.isArray(this.details) ? this.details : []).filter((d) => d.field).map((d) => [d.field, d.message]));
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function request(path, { method = 'GET', body, form, signal, headers: extra } = {}) {
  const headers = { ...extra };
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${apiBase}/api${path}`, { method, headers, body: payload, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0);
  }
  if (res.status === 401 && token && !path.startsWith('/auth/login')) onUnauthorized();
  return res;
}

export async function api(path, options) {
  const res = await request(path, options);
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  // A 5xx with no JSON body comes from a proxy in front of the API, not the API: say it's down.
  const unreachable = res.status >= 500 && !data ? { message: "Tessera's server isn't answering right now. Try again in a moment.", code: 'unreachable' } : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? unreachable);
  return data;
}

// Files (attachments) need the login header, so they are fetched as blobs and shown via object URLs.
export async function apiBlob(path) {
  const res = await request(path);
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error);
  return res.blob();
}
