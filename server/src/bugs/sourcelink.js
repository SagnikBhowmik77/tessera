// Links a stack frame to that file and line in the project's GitHub repository (E5B), but only when
// the path can be worked out without guessing:
//  - relative paths (src/cart.rs, app/models/order.rb) are taken as paths in the repo;
//  - absolute paths and URLs need the project's "strip prefix" (e.g. /var/www/shop/) to match;
//  - bundled build files (checkout.4f9a2c1e.js) need source maps, so they are not linked;
//  - Java and Kotlin frames carry only a file name, so they are not linked either.
// The link points at the branch as it is today, so lines may have moved since the crash.

const BUNDLED = /[.-][0-9a-f]{8,}\.(?:m?js|css)$/i;

const norm = (s) => String(s ?? '').trim().replace(/\\/g, '/');

export function sourcePath(file, pathPrefix) {
  if (!file) return null;
  let p = norm(file).split(/[?#]/)[0].replace(/^webpack:\/\/[^/]*\//, '');
  const prefix = norm(pathPrefix);
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  else if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\/|[a-z]:\/)/i.test(p)) return null;
  p = p.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (!p || p.split('/').includes('..') || /^[<[{]/.test(p) || BUNDLED.test(p)) return null;
  return p;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function sourceUrl(source, frame, language) {
  if (!source?.repo || !frame?.inApp || language === 'java') return null;
  const path = sourcePath(frame.file, source.pathPrefix);
  if (!path) return null;
  return `https://github.com/${source.repo}/blob/${encodePath(source.branch || 'main')}/${encodePath(path)}${frame.line ? `#L${frame.line}` : ''}`;
}

export const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
