import { Router } from 'express';
import { HttpError } from '../errors.js';
import { requireDb } from '../db.js';
import { validate } from '../middleware/validate.js';
import { noApiToken, requireAuth } from '../middleware/requireAuth.js';
import { createAuthLimiters } from '../middleware/rateLimits.js';
import { authConfigured } from '../services/auth.service.js';
import * as ctrl from '../controllers/auth.controller.js';
import {
  registerSchema, loginSchema, updateProfileSchema, preferencesSchema, changePasswordSchema, deleteAccountSchema,
  oauthParams, oauthStartQuery, oauthExchangeSchema,
  forgotSchema, resetSchema, verifySchema, loginSecondStepSchema, twoFactorCodeSchema, twoFactorDisableSchema, sessionParams,
} from '../schemas/auth.schemas.js';

export function authRouter() {
  const router = Router();
  const limit = createAuthLimiters();

  // Without a signing secret, login is honestly "not configured" instead of half-working.
  router.use((_req, _res, next) => {
    if (!authConfigured()) return next(new HttpError(503, 'auth_not_configured', 'Login is not configured on this server'));
    next();
  });
  router.use(requireDb);

  router.post('/register', limit.register, validate({ body: registerSchema }), ctrl.register);
  router.post('/login', limit.login, validate({ body: loginSchema }), ctrl.login);
  // 2FA: the code step after a correct password (failed codes count against the login limit).
  router.post('/login/2fa', limit.login, validate({ body: loginSecondStepSchema }), ctrl.loginSecondStep);

  // Forgot password and email verification (links sent by email).
  router.post('/forgot', limit.email, validate({ body: forgotSchema }), ctrl.forgot);
  router.post('/reset', limit.login, validate({ body: resetSchema }), ctrl.reset);
  router.post('/verify', validate({ body: verifySchema }), ctrl.verify);
  router.post('/verify/resend', requireAuth, limit.email, ctrl.resendVerification);

  // Sign in with GitHub / Google. start and callback are browser navigations (redirects).
  const op = validate({ params: oauthParams });
  router.get('/oauth/providers', ctrl.oauthProviders);
  router.get('/oauth/:provider/start', op, validate({ query: oauthStartQuery }), ctrl.oauthStart);
  router.get('/oauth/:provider/callback', op, ctrl.oauthCallback);
  router.post('/oauth/:provider/link-intent', requireAuth, noApiToken, op, ctrl.oauthLinkIntent);
  router.post('/oauth/exchange', limit.login, validate({ body: oauthExchangeSchema }), ctrl.oauthExchange);
  router.delete('/oauth/:provider', requireAuth, noApiToken, op, ctrl.oauthUnlink);

  // Signed-in devices.
  router.get('/sessions', requireAuth, noApiToken, ctrl.sessions);
  router.delete('/sessions/:sessionId', requireAuth, noApiToken, validate({ params: sessionParams }), ctrl.revokeSession);

  // Two-factor authentication with an authenticator app.
  router.get('/2fa', requireAuth, noApiToken, ctrl.twoFactorStatus);
  router.post('/2fa/setup', requireAuth, noApiToken, ctrl.twoFactorStart);
  router.post('/2fa/confirm', requireAuth, noApiToken, limit.login, validate({ body: twoFactorCodeSchema }), ctrl.twoFactorConfirm);
  router.post('/2fa/disable', requireAuth, noApiToken, limit.login, validate({ body: twoFactorDisableSchema }), ctrl.twoFactorDisable);
  router.post('/2fa/backup-codes', requireAuth, noApiToken, limit.login, validate({ body: twoFactorCodeSchema }), ctrl.twoFactorBackupCodes);

  router.get('/me', requireAuth, ctrl.me);
  router.patch('/me', requireAuth, validate({ body: updateProfileSchema }), ctrl.updateMe);
  router.patch('/me/preferences', requireAuth, validate({ body: preferencesSchema }), ctrl.updatePreferences);
  router.delete('/me', requireAuth, noApiToken, validate({ body: deleteAccountSchema }), ctrl.deleteMe);
  router.post('/logout', requireAuth, noApiToken, ctrl.logout);
  router.post('/logout-all', requireAuth, noApiToken, ctrl.logoutAll);
  router.post('/password', requireAuth, noApiToken, validate({ body: changePasswordSchema }), ctrl.changePassword);

  return router;
}
