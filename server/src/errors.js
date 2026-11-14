// Every error response has the same shape: { error: { code, message, details? } }.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(req, _res, next) {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  // Failed half-way through streaming a file: the status is already sent, so just end it.
  if (res.headersSent) {
    console.error(err);
    return res.destroy();
  }
  if (err instanceof HttpError) {
    const body = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json({ error: body });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'That request is too big' } });
  }
  // Upload problems from multer.
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: { code: 'too_large', message: 'This file is too big. Attachments can be up to 10 MB and CSV imports up to 1 MB.' } });
    }
    return res.status(400).json({ error: { code: 'bad_upload', message: 'Send one file in the form field "file"' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side' } });
}
