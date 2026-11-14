// Two-factor authentication with an authenticator app (Google Authenticator, Authy, 1Password…):
// time-based one-time passwords, RFC 6238 (TOTP: HMAC-SHA1, 30-second steps, 6 digits).
// Built on Node's own crypto, no extra package.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new random secret (160 bits, the size RFC 4226 recommends), as base32 for the app.
export const newSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

// The 6-digit code for one 30-second step.
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Checks a code, allowing one step either side for clock drift. Returns the step it matched
// (so the caller can refuse the same code twice) or null.
export function verifyCode(secret, code, { now = Date.now(), notAfterStep = -1 } = {}) {
  const given = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = stepAt(now);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= notAfterStep) continue;
    const expected = codeAt(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

// What the authenticator app scans (as a QR code) to add the account.
export function otpauthUri(secret, accountEmail, issuer = 'Tessera') {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Backup codes for when the phone is lost: ten "xxxx-xxxx" codes, shown once, stored hashed.
export function newBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(5)).toLowerCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
export const hashBackupCode = (code) => createHash('sha256').update(String(code).toLowerCase().replace(/[^a-z2-7]/g, '')).digest('hex');

// The TOTP secret is stored encrypted (AES-256-GCM, key derived from the server's JWT secret),
// so reading the database alone is not enough to generate someone's codes.
const keyFrom = (serverSecret) => createHash('sha256').update(`tessera-2fa:${serverSecret}`).digest();

export function sealSecret(secret, serverSecret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(serverSecret), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function openSecret(sealed, serverSecret) {
  const [iv, tag, data] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(serverSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
