import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.js';

// The OpenAPI 3.1 document (E15), built from the running app: every route Express knows, with the
// zod schemas its validate() checks and the project role its requireProject() asks for. It cannot
// drift from the code because it is the code.

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const join = (a, b) => `${a.replace(/\/+$/, '')}/${String(b).replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
const openApiPath = (p) => p.replace(/:(\w+)/g, '{$1}');

function jsonSchema(schema, io = 'input') {
  try {
    const { $schema, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
    return rest;
  } catch { return {}; }
}

function tagOf(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts[1] !== 'projects') return parts[1] ?? 'other';
  if (parts.includes('tickets')) {
    const after = parts.slice(parts.indexOf('tickets') + 1).find((p) => !p.startsWith('{'));
    return ['comments', 'attachments'].includes(after) ? after : 'tickets';
  }
  return parts.slice(2).find((p) => !p.startsWith('{')) ?? 'projects';
}

function operation(path, method, handlers) {
  const schemas = Object.assign({}, ...handlers.filter((h) => h?.schemas).map((h) => h.schemas));
  const role = handlers.map((h) => h?.minRole).filter(Boolean).at(-1);
  const authed = handlers.some((h) => h?.name === 'requireAuth');
  const multipart = handlers.some((h) => h?.name === 'multerMiddleware');
  const parameters = [];
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const paramSchema = schemas.params ? jsonSchema(schemas.params) : null;
  for (const name of pathParams) parameters.push({ name, in: 'path', required: true, schema: paramSchema?.properties?.[name] ?? { type: 'string' } });
  if (schemas.query) {
    const q = jsonSchema(schemas.query);
    for (const [name, s] of Object.entries(q.properties ?? {})) parameters.push({ name, in: 'query', required: (q.required ?? []).includes(name) && s.default === undefined, schema: s });
  }
  const op = {
    operationId: `${method}${path.replace(/\{(\w+)\}/g, 'By_$1').split(/[^A-Za-z0-9_]+/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`,
    tags: [tagOf(path)],
    summary: `${method.toUpperCase()} ${path}`,
    ...(role && { description: `Needs the ${role} role (or higher) in the project.` }),
    ...(parameters.length && { parameters }),
    responses: {
      200: { description: 'Success' },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    security: authed ? [{ bearerAuth: [] }] : [],
  };
  if (multipart) {
    op.requestBody = { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } };
  } else if (schemas.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: jsonSchema(schemas.body) } } };
  }
  return op;
}

export function buildOpenApi(app) {
  const paths = {};
  const walk = (stack, prefix, inherited) => {
    // Middleware a router adds for a path (validators, role checks) applies to what is mounted there.
    const byPath = new Map();
    let shared = [...inherited];
    for (const layer of stack) {
      const mount = layer.mountPath ?? '/';
      if (layer.route) {
        const path = openApiPath(join(prefix, layer.route.path));
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          (paths[path] ??= {})[method] = operation(path, method, [...shared, ...layer.route.stack.map((s) => s.handle)]);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, mount === '/' ? prefix : join(prefix, mount), [...shared, ...(byPath.get(mount) ?? [])]);
      } else if (mount === '/') {
        shared = [...shared, layer.handle];
      } else {
        byPath.set(mount, [...(byPath.get(mount) ?? []), layer.handle]);
      }
    }
  };
  walk(app.router.stack, '', []);
  const sorted = Object.fromEntries(Object.entries(paths).filter(([p]) => p.startsWith('/api') || p.startsWith('/sdk')).sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tessera API', version: pkg.version,
      description: 'Built from the running server: the request schemas are the ones the server validates. Authenticate with "Authorization: Bearer <token>", either a login token or a personal API token (tsp_...). Errors are { error: { code, message, details } }.',
    },
    servers: [{ url: config.apiUrl }],
    tags: [...new Set(Object.values(sorted).flatMap((ops) => Object.values(ops).flatMap((o) => o.tags)))].sort().map((name) => ({ name })),
    paths: sorted,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'A login token, or a personal API token (tsp_...) from your profile' } },
      schemas: {
        Error: {
          type: 'object', required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
      },
    },
  };
}

// A small page that renders the document with Swagger UI (pinned, from jsDelivr).
export const DOCS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tessera API</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"></head>
<body><div id="docs"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script><script src="/api/docs/init.js"></script></body></html>`;
export const DOCS_INIT = "window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#docs', deepLinking: true });";
export const DOCS_CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'";
