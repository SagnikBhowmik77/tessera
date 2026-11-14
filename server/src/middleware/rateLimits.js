import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

const limited = (message) => (_req, _res, next) => next(new HttpError(429, 'rate_limited', message));

// Created per app instance so each test server starts with fresh counters.
export function createAuthLimiters() {
  return {
    // Only failed logins count, so a team member who logs in often is never locked out.
    login: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: config.rateLimit.loginMax,
      skipSuccessfulRequests: true,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: limited('Too many failed login attempts. Try again in 15 minutes.'),
    }),
    // Forgot-password and resend-verification emails: a few per hour, so nobody can use the
    // form to flood an inbox.
    email: rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: config.rateLimit.emailMax,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: limited('Too many emails asked for. Try again in an hour.'),
    }),
    register: rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: config.rateLimit.registerMax,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: limited('Too many accounts created from this network. Try again later.'),
    }),
  };
}
