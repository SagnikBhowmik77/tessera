import { HttpError } from '../errors.js';

// validate({ body: schema, query: schema, params: schema }) parses the request with zod.
// Parsed (trimmed, normalised) values land on req.valid.body / req.valid.query / req.valid.params.
// The schemas also ride along on the middleware (.schemas), so the OpenAPI document is built from
// exactly what the server checks (E15).
export function validate(schemas) {
  return Object.assign((req, _res, next) => {
    // A route may validate params and body in separate steps; each adds to req.valid.
    req.valid ??= {};
    for (const [part, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.join('.') || part,
          message: issue.message,
        }));
        return next(new HttpError(400, 'validation_failed', 'Some fields are missing or invalid', details));
      }
      req.valid[part] = result.data;
    }
    next();
  }, { schemas });
}
