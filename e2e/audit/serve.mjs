// Serves the built client (client/dist) the way a production static host does, for audits:
// Brotli or gzip compression, hashed files cached for a year, everything else revalidated, the
// single-page-app fallback to index.html, and /api and Socket.IO forwarded to the API. (`vite preview` sends
// files uncompressed and uncached, which would make Lighthouse's Performance score unfairly low.)
//   node audit/serve.mjs [port=5213] [api=http://localhost:8740]
import http from 'node:http';
import net from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const DIST = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const port = Number(process.argv[2]) || 5213;
const api = new URL(process.argv[3] || 'http://localhost:8740');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.webm': 'video/webm', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};
const COMPRESS = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt', '.ico']);
const cache = new Map();

async function file(path) {
  const full = normalize(join(DIST, path));
  if (!full.startsWith(normalize(DIST))) return null;
  try { if ((await stat(full)).isFile()) return full; } catch { /* not there */ }
  return null;
}

function proxy(req, res) {
  const out = http.request({ hostname: api.hostname, port: api.port, path: req.url, method: req.method, headers: { ...req.headers, host: api.host } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  out.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(out);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return proxy(req, res);
  const found = (await file(decodeURIComponent(url.pathname))) ?? join(DIST, 'index.html');
  const ext = extname(found);
  const accept = req.headers['accept-encoding'] ?? '';
  const enc = COMPRESS.has(ext) ? (accept.includes('br') ? 'br' : accept.includes('gzip') ? 'gzip' : null) : null;
  // Keyed by the file's time too, so a rebuild is served at once (not the old index.html).
  const key = `${found}|${(await stat(found)).mtimeMs}|${enc}`;
  if (!cache.has(key)) {
    const raw = await readFile(found);
    cache.set(key, enc === 'br' ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : enc === 'gzip' ? gzipSync(raw, { level: 9 }) : raw);
  }
  const body = cache.get(key);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    ...(enc && { 'Content-Encoding': enc, Vary: 'Accept-Encoding' }),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
})
  // The live connection's websocket: hand the upgrade request to the API and join the two sockets.
  .on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/socket.io/')) { socket.destroy(); return; }
    const upstream = net.connect(Number(api.port) || 80, api.hostname, () => {
      const headers = Object.entries({ ...req.headers, host: api.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
  })
  .listen(port, () => console.log(`audit server on http://localhost:${port} (dist, compressed; /api and the live connection -> ${api.origin})`));
