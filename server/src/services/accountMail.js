import { escapeHtml, sendMail } from '../mailer.js';
import { runInBackground } from './notification.service.js';

// Account emails: verify your address, reset your password. Sent in the background so the
// response never waits for Gmail (and takes the same time whether or not an account exists).

function layout(lines, button) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18181b">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e4e4e7">
<div style="font-size:20px;font-weight:600">Tessera</div>
${lines.map((l) => `<p style="font-size:15px;line-height:1.6;margin:18px 0 0">${escapeHtml(l)}</p>`).join('')}
<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="background:#7c6cf0;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${escapeHtml(button.label)}</a></p>
<p style="font-size:13px;color:#71717a">If the button doesn't work, open this link: ${escapeHtml(button.url)}</p>
</div></body></html>`;
}

export function sendVerifyEmail(user, url) {
  const lines = [`Hi ${user.name}, please confirm that ${user.email} is your email address.`, 'The link works for 48 hours.'];
  runInBackground(sendMail({
    to: user.email,
    subject: 'Confirm your email for Tessera',
    text: `${lines.join('\n\n')}\n\nConfirm: ${url}\n\nIf you didn't create a Tessera account, ignore this email.`,
    html: layout([...lines, "If you didn't create a Tessera account, ignore this email."], { url, label: 'Confirm my email' }),
  }));
}

export function sendResetEmail(user, url) {
  const lines = [`Hi ${user.name}, someone asked to reset the password for your Tessera account (${user.email}).`, 'The link works for 1 hour and only once. Resetting signs you out on every device.'];
  runInBackground(sendMail({
    to: user.email,
    subject: 'Reset your Tessera password',
    text: `${lines.join('\n\n')}\n\nReset: ${url}\n\nIf it wasn't you, ignore this email; your password stays the same.`,
    html: layout([...lines, "If it wasn't you, ignore this email; your password stays the same."], { url, label: 'Choose a new password' }),
  }));
}
