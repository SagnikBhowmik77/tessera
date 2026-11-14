import './docs/mounts.js';
import { buildOpenApi, DOCS_CSP, DOCS_HTML, DOCS_INIT } from './docs/openapi.js';
import { workspaceRouter } from './routes/workspace.routes.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { errorHandler, notFound } from './errors.js';
import { dbStatus } from './db.js';
import { authRouter } from './routes/auth.routes.js';
import { projectRouter, inviteRouter } from './routes/project.routes.js';
import { meRouter } from './routes/me.routes.js';
import { notificationRouter } from './routes/notification.routes.js';
import { hooksRouter, portalRouter, roadmapRouter, sharedRouter, trackRouter } from './routes/public.routes.js';
import { deployRouter, ingestRouter, sdkRouter, sourcemapRouter, statusRouter, testResultsRouter, widgetRouter } from './routes/ingest.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  // Crash capture (E6A) answers every website, so it comes before the app's own CORS rules.
  app.use('/api/ingest', ingestRouter());
  app.use('/sdk', sdkRouter());
  app.use('/api/sourcemaps', sourcemapRouter());
  app.use('/api/test-results', testResultsRouter());
  app.use('/api/widget', widgetRouter());
  app.use('/api/deploys', deployRouter());
  // Content-Disposition is exposed so the app can read attachment file names.
  app.use(cors({
    origin: config.clientOrigins,
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
  }));
  // Webhooks read their own raw body (to check signatures), so they come before the JSON parser.
  app.use('/api/hooks', hooksRouter());
  app.use(express.json({ limit: '100kb' }));

  // The bare backend URL says what it is, instead of a 404, for anyone who opens it in a browser.
  app.get('/', (_req, res) => {
    res.json({
      service: 'tessera-api',
      status: 'running',
      message: 'Tessera backend API. The app itself is at the "app" link; every API route is under /api.',
      health: '/api/health',
      app: config.appUrl,
    });
  });

  // 200 only when the database is really connected; 503 with the reason otherwise
  // (the reason is hidden in production so connection details never leak).
  app.get('/api/health', (_req, res) => {
    const database = dbStatus();
    if (config.env === 'production') delete database.problem;
    res.status(database.connected ? 200 : 503).json({
      ok: database.connected,
      service: 'tessera-api',
      time: new Date().toISOString(),
      database,
    });
  });

  app.use('/api/auth', authRouter());
  app.use('/api/projects', projectRouter());
  app.use('/api/invites', inviteRouter());
  app.use('/api/me', meRouter());
  app.use('/api/workspaces', workspaceRouter());
  app.use('/api/notifications', notificationRouter());
  app.use('/api/portal', portalRouter());
  app.use('/api/status', statusRouter());
  app.use('/api/track', trackRouter());
  app.use('/api/roadmap', roadmapRouter());
  app.use('/api/shared', sharedRouter());

  // API documentation (E15), built from the routes themselves.
  let spec = null;
  app.get('/api/openapi.json', (_req, res) => { spec ??= buildOpenApi(app); res.json(spec); });
  app.get('/api/docs', (_req, res) => { res.set('Content-Security-Policy', DOCS_CSP).type('html').send(DOCS_HTML); });
  app.get('/api/docs/init.js', (_req, res) => { res.type('application/javascript').send(DOCS_INIT); });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
