import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;
let testTransport = null;

// Tests swap in nodemailer's JSON transport so no real email is sent; pass null to undo.
export function __setTransport(t) {
  testTransport = t;
}

// Render's free tier blocks outgoing SMTP, so there mail goes over HTTPS to the relay on Vercel
// (client/api/send-mail.js) instead. Locally, and in tests, SMTP (or the test transport) is used.
const relayConfigured = () => Boolean(config.mailRelay.url && config.mailRelay.secret);

export function emailConfigured() {
  if (testTransport) return true;
  if (relayConfigured()) return true;
  const { host, user, pass } = config.smtp;
  return Boolean(host && user && pass);
}

function getTransport() {
  if (testTransport) return testTransport;
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transport;
}

// Signed like Tessera's webhooks: HMAC-SHA256 of "<timestamp>.<body>"; the relay refuses requests
// older than five minutes and always sends from its own address.
export const relaySignature = (secret, timestamp, body) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

async function sendViaRelay({ to, subject, text, html }) {
  const body = JSON.stringify({ to, subject, text, html });
  const timestamp = Date.now();
  const res = await fetch(config.mailRelay.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tessera-timestamp': String(timestamp),
      'x-tessera-signature': relaySignature(config.mailRelay.secret, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mail relay answered ${res.status}: ${answer.reason || answer.error || 'no detail'}`);
}

// Returns { sent: true } or { sent: false, reason } and never throws, so a mail problem
// never undoes the action that triggered it (the invite still exists and its link still works).
export async function sendMail({ to, subject, text, html }) {
  if (!emailConfigured()) return { sent: false, reason: 'not_configured' };
  try {
    // A transport set by tests always wins, so tests never reach a relay by accident.
    if (!testTransport && relayConfigured()) await sendViaRelay({ to, subject, text, html });
    else await getTransport().sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error(`Email to ${to} failed: ${err.message}`);
    return { sent: false, reason: 'send_failed' };
  }
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
