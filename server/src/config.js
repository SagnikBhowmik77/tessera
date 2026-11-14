import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load server/.env when it exists (Node's built-in loader; no dotenv needed).
// On Render the variables come from the dashboard instead. Tests never read it.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile) && process.env.NODE_ENV !== 'test') process.loadEnvFile(envFile);

const list = (value, fallback) =>
  (value || fallback).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 8740,
  // Browser origins allowed to call the API (comma-separated).
  clientOrigins: list(process.env.CLIENT_ORIGIN, 'http://localhost:5210'),
  // Behind Render's proxy this must be 1 so rate limits see the real client IP.
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  // Where the web app lives, shown on the API's root page and used for links in emails.
  appUrl: (process.env.APP_URL || 'http://localhost:5210').replace(/\/+$/, ''),
  mongodb: mongoConfig(process.env.MONGODB_URI),
  // Optional DNS servers for Node's own lookups (comma-separated), e.g. 1.1.1.1,8.8.8.8.
  dnsServers: list(process.env.DNS_SERVERS, ''),
  jwt: {
    // At least 32 characters; without it the auth routes answer 503 "not configured".
    secret: (process.env.JWT_SECRET || '').length >= 32 ? process.env.JWT_SECRET : null,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: 'tessera',
  },
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
  rateLimit: {
    // Failed logins per IP per 15 minutes (successful logins don't count).
    loginMax: Number(process.env.LOGIN_RATE_LIMIT) || 10,
    // New accounts per IP per hour.
    registerMax: Number(process.env.REGISTER_RATE_LIMIT) || 20,
    // Forgot-password / resend-verification emails per IP per hour.
    emailMax: Number(process.env.EMAIL_RATE_LIMIT) || 5,
    // Project invite emails per IP per hour.
    inviteMax: Number(process.env.INVITE_RATE_LIMIT) || 30,
    // Public portal reports per IP per hour.
    portalMax: Number(process.env.PORTAL_RATE_LIMIT) || 10,
    // Crash reports (SDK) per IP per minute.
    ingestMax: Number(process.env.INGEST_RATE_LIMIT) || 120,
  },
  // Where this API is reachable from outside (GitHub needs it for the webhook URL).
  apiUrl: (process.env.API_URL || `http://localhost:${Number(process.env.PORT) || 8740}`).replace(/\/+$/, ''),
  // "Sign in with GitHub / Google" (free OAuth apps). Each is off unless both its values are set.
  oauth: {
    github: { clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '', clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '' },
    google: { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '', clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '' },
  },
  // Cloudflare Turnstile for the public portal (optional, free). Off unless both keys are set.
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    secret: process.env.TURNSTILE_SECRET || '',
    verifyUrl: process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
  // The team's time zone, for "today", "overdue" and "due this week" (due dates are calendar dates).
  timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
  attachments: {
    // Per-project storage for screenshots and logs. The free Atlas cluster (512 MB) is shared
    // with Spendwise, so the default is modest.
    projectQuotaBytes: (Number(process.env.ATTACHMENT_QUOTA_MB) || 100) * 1024 * 1024,
  },
  // Web push (E14). The VAPID keys are generated locally (web-push) and kept in .env.
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || ((process.env.APP_URL || '').startsWith('https://') ? process.env.APP_URL : 'mailto:noreply@tessera.invalid'),
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 465,
    user: process.env.SMTP_USER || '',
    // Gmail shows app passwords in groups of four; the spaces aren't part of it.
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    from: process.env.SMTP_FROM || (process.env.SMTP_USER ? `Tessera <${process.env.SMTP_USER}>` : ''),
  },
  // Render's free tier blocks outgoing SMTP, so in production each email goes over HTTPS to the
  // relay on Vercel (client/api/send-mail.js), signed with this shared secret. Locally SMTP is used.
  mailRelay: {
    url: process.env.MAIL_RELAY_URL || '',
    secret: process.env.MAIL_RELAY_SECRET || '',
  },
};

// Returns { uri } when usable, or { uri: null, problem } explaining what is missing.
function mongoConfig(raw) {
  const uri = (raw || '').trim();
  if (!uri) return { uri: null, problem: 'MONGODB_URI is not set' };
  if (uri.includes('<db_password>')) {
    return { uri: null, problem: 'MONGODB_URI still contains <db_password>; put the real password in server/.env' };
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    return { uri: null, problem: 'MONGODB_URI must start with mongodb:// or mongodb+srv://' };
  }
  return { uri };
}
