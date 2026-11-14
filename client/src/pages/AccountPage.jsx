import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import QRCode from 'qrcode';
import { CheckCircle2, Download, KeyRound, Laptop, LogOut, MailWarning, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { api, apiBase } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { formatDateTime, timeAgo } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader } from '../components/AppShell.jsx';
import { Badge, Button, ConfirmDialog, Field, Spinner } from '../components/ui.jsx';
import MyLeave from '../components/MyLeave.jsx';
import PreferencesSettings from '../components/PreferencesSettings.jsx';
import { ApiTokens, NotificationSettings } from '../components/IntegrationTools.jsx';
import { PushSettings } from '../components/PlatformTools.jsx';
import { SettingsSection as Section } from '../components/SettingsSection.jsx';


// Field errors from the API next to the field, anything else as a toast.
function useForm(run) {
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setErrors({});
    try {
      await run(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      const fields = err.fieldErrors?.() ?? {};
      if (Object.keys(fields).length) setErrors(fields);
      else toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { submit, errors, busy };
}

function Profile() {
  const { user, setUser } = useAuth();
  const [sending, setSending] = useState(false);
  const form = useForm(async ({ name }) => {
    const { user: next } = await api('/auth/me', { method: 'PATCH', body: { name } });
    setUser(next);
    toast.success('Saved');
  });
  const toggleEmails = async (on) => {
    try { const { user: next } = await api('/auth/me', { method: 'PATCH', body: { emailNotifications: on } }); setUser(next); } catch (e) { toast.error(e.message); }
  };
  const resend = async () => {
    setSending(true);
    try {
      const res = await api('/auth/verify/resend', { method: 'POST' });
      toast.success(res.alreadyVerified ? 'Already confirmed' : `Link sent to ${user.email}`);
    } catch (e) { toast.error(e.message); } finally { setSending(false); }
  };
  return (
    <Section title="Profile" description="Your name is what teammates see on tickets and comments.">
      <form onSubmit={form.submit} className="space-y-4">
        <Field label="Name" error={form.errors.name}><input name="name" className="input" defaultValue={user.name} maxLength={80} required /></Field>
        <div className="text-small">
          <span className="text-caption font-medium text-fg-subtle">Email</span>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            {user.email}
            {user.emailVerifiedAt
              ? <Badge tone="teal"><CheckCircle2 className="size-3" />Confirmed</Badge>
              : (
                <>
                  <Badge tone="amber"><MailWarning className="size-3" />Not confirmed</Badge>
                  <Button size="sm" variant="ghost" loading={sending} onClick={resend}>Send the link again</Button>
                </>
              )}
          </p>
          {!user.emailVerifiedAt && <p className="mt-1 text-caption text-fg-subtle">Until you confirm it, notification emails are not sent to this address.</p>}
        </div>
        <label className="flex items-center gap-2 text-small">
          <input type="checkbox" className="size-4 accent-accent" checked={user.emailNotifications !== false} onChange={(e) => toggleEmails(e.target.checked)} />
          Email me about mentions, assignments and regressions while I'm away
        </label>
        <Button type="submit" variant="primary" loading={form.busy}>Save profile</Button>
      </form>
    </Section>
  );
}

const PROVIDER_LABEL = { github: 'GitHub', google: 'Google' };

// GitHub / Google sign-in for this account. Connecting runs the provider's sign-in in this tab
// and comes back here; disconnecting is refused while it is the only way in.
function ConnectedAccounts() {
  const { user, setUser } = useAuth();
  const { data } = useQuery({ queryKey: ['oauth-providers'], queryFn: () => api('/auth/oauth/providers').then((d) => d.providers) });
  const [busy, setBusy] = useState(null);
  const available = Object.entries(data ?? {}).filter(([, on]) => on).map(([p]) => p);
  if (data && !available.length) return null;
  const connect = async (p) => {
    setBusy(p);
    try {
      const { intent } = await api(`/auth/oauth/${p}/link-intent`, { method: 'POST' });
      window.location.assign(`${apiBase}/api/auth/oauth/${p}/start?${new URLSearchParams({ mode: 'link', intent, from: '/account' })}`);
    } catch (e) { toast.error(e.message); setBusy(null); }
  };
  const disconnect = async (p) => {
    setBusy(p);
    try {
      const { user: next } = await api(`/auth/oauth/${p}`, { method: 'DELETE' });
      setUser(next);
      toast.success(`${PROVIDER_LABEL[p]} disconnected`);
    } catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };
  return (
    <Section title="Connected accounts" description="Sign in with GitHub or Google instead of a password. Only the account id is stored, never a token.">
      {!data && <Spinner className="text-fg-subtle" />}
      <ul className="divide-y divide-line">
        {available.map((p) => {
          const link = user.oauth?.[p];
          return (
            <li key={p} className="flex items-center gap-3 py-2.5 text-small">
              <span className="w-20 font-medium">{PROVIDER_LABEL[p]}</span>
              <span className="min-w-0 flex-1 truncate text-fg-subtle">{link ? `Connected${link.login ? ` as ${link.login}` : link.email ? ` as ${link.email}` : ''}` : 'Not connected'}</span>
              {link
                ? <Button size="sm" loading={busy === p} onClick={() => disconnect(p)}>Disconnect</Button>
                : <Button size="sm" variant="primary" loading={busy === p} onClick={() => connect(p)}>Connect</Button>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Password() {
  const { user, adoptToken } = useAuth();
  // Joined with GitHub / Google: no password yet, so there's no "current" one to ask for.
  const setting = user.passwordSet === false;
  const form = useForm(async ({ currentPassword, newPassword, confirm }, el) => {
    if (newPassword !== confirm) throw Object.assign(new Error(''), { fieldErrors: () => ({ confirm: 'The two passwords are different' }) });
    const res = await api('/auth/password', { method: 'POST', body: { ...(!setting && { currentPassword }), newPassword } });
    adoptToken(res.token, res.user);
    el.reset();
    toast.success(setting ? 'Password set. You can now also log in with your email.' : 'Password changed. Your other devices were signed out.');
  });
  return (
    <Section title="Password" description={setting ? 'You sign in with GitHub or Google. Add a password to also log in with your email.' : 'Changing it signs out every other device.'}>
      <form onSubmit={form.submit} className="grid gap-4 sm:grid-cols-2">
        {!setting && (
          <Field label="Current password" error={form.errors.currentPassword} className="sm:col-span-2">
            <input name="currentPassword" type="password" autoComplete="current-password" className="input" required />
          </Field>
        )}
        <Field label="New password" error={form.errors.newPassword} hint="8+ characters, a letter and a number">
          <input name="newPassword" type="password" autoComplete="new-password" className="input" required />
        </Field>
        <Field label="Repeat new password" error={form.errors.confirm}>
          <input name="confirm" type="password" autoComplete="new-password" className="input" required />
        </Field>
        <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={form.busy}>{setting ? 'Set password' : 'Change password'}</Button></div>
      </form>
    </Section>
  );
}

function BackupCodes({ codes, onDone }) {
  const text = `Tessera backup codes\nEach code works once, in place of a code from your authenticator app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'tessera-backup-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="rounded-tile border border-warning/40 bg-warning/10 p-4  ">
      <p className="text-small font-medium">Save these backup codes now</p>
      <p className="mt-1 text-caption text-fg-muted">If you lose your phone, each code lets you log in once. They won't be shown again.</p>
      <ol className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-code text-small sm:grid-cols-5" aria-label="Backup codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={download}><Download className="size-3.5" />Download .txt</Button>
        <Button size="sm" onClick={() => copyText(codes.join('\n'), 'Backup codes copied')}>Copy</Button>
        <Button size="sm" variant="primary" onClick={onDone}>I've saved them</Button>
      </div>
    </div>
  );
}

function TwoFactor() {
  const { user, setUser } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['2fa'], queryFn: () => api('/auth/2fa') });
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [codes, setCodes] = useState(null);
  const [disabling, setDisabling] = useState(false);
  useEffect(() => {
    if (!setup) { setQr(null); return; }
    QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 200 }).then(setQr).catch(() => setQr(null));
  }, [setup]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['2fa'] });

  const start = async () => {
    try { setSetup(await api('/auth/2fa/setup', { method: 'POST' })); } catch (e) { toast.error(e.message); }
  };
  const confirm = useForm(async ({ code }) => {
    const res = await api('/auth/2fa/confirm', { method: 'POST', body: { code } });
    setSetup(null);
    setCodes(res.backupCodes);
    setUser({ ...user, twoFactorEnabled: true });
    refresh();
  });
  const regenerate = useForm(async ({ code }, el) => {
    const res = await api('/auth/2fa/backup-codes', { method: 'POST', body: { code } });
    setCodes(res.backupCodes);
    el.reset();
    refresh();
  });
  const disable = useForm(async ({ password, code }) => {
    await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
    setDisabling(false);
    setUser({ ...user, twoFactorEnabled: false });
    refresh();
    toast.success('Two-factor authentication is off');
  });

  return (
    <Section title="Two-factor authentication" description="A 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…) is asked for after your password.">
      {codes && <BackupCodes codes={codes} onDone={() => setCodes(null)} />}
      {!codes && !data && <Spinner className="text-fg-subtle" />}
      {!codes && data && !data.enabled && !setup && (
        <div className="space-y-3">
          <p className="text-small">Off. Anyone with your password can log in.</p>
          <Button variant="primary" onClick={start}><ShieldCheck className="size-4" />Turn on</Button>
        </div>
      )}
      {!codes && setup && (
        <div className="grid gap-5 sm:grid-cols-[200px_1fr]">
          <div>
            {qr ? <img src={qr} alt="QR code for your authenticator app" className="size-[200px] rounded-tile bg-white p-1" /> : <Spinner className="text-fg-subtle" />}
          </div>
          <form onSubmit={confirm.submit} className="space-y-3 text-small">
            <p><b>1.</b> Scan the code with your authenticator app.</p>
            <p className="text-caption text-fg-subtle">Can't scan? Enter this key by hand: <code className="break-all rounded-hair bg-hover px-1 font-code ">{setup.secret}</code></p>
            <p><b>2.</b> Enter the 6-digit code it shows.</p>
            <Field label="Code" error={confirm.errors.code}>
              <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="input w-40 text-center font-code tracking-[0.3em]" placeholder="123456" required autoFocus />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={confirm.busy}>Confirm and turn on</Button>
              <Button onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </form>
        </div>
      )}
      {!codes && data?.enabled && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-small"><Badge tone="teal"><ShieldCheck className="size-3" />On</Badge>{data.backupCodesLeft} backup code{data.backupCodesLeft === 1 ? '' : 's'} left</p>
          <form onSubmit={regenerate.submit} className="flex flex-wrap items-end gap-2">
            <Field label="New backup codes (the old ones stop working)" error={regenerate.errors.code}>
              <input name="code" inputMode="numeric" className="input w-40 font-code" placeholder="Code from the app" required />
            </Field>
            <Button type="submit" loading={regenerate.busy}><KeyRound className="size-4" />Make new codes</Button>
          </form>
          {disabling ? (
            <form onSubmit={disable.submit} className="flex flex-wrap items-end gap-2 rounded-tile border border-line p-3 ">
              {user.passwordSet !== false && <Field label="Password" error={disable.errors.password}><input name="password" type="password" autoComplete="current-password" className="input w-48" required /></Field>}
              <Field label="Code or backup code" error={disable.errors.code}><input name="code" className="input w-40 font-code" required /></Field>
              <Button type="submit" variant="danger" loading={disable.busy}>Turn off</Button>
              <Button onClick={() => setDisabling(false)}>Cancel</Button>
            </form>
          ) : <Button variant="ghost" onClick={() => setDisabling(true)}>Turn off two-factor…</Button>}
        </div>
      )}
    </Section>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['sessions'], queryFn: () => api('/auth/sessions').then((d) => d.sessions) });
  const [everywhere, setEverywhere] = useState(false);
  const signOut = async (s) => {
    try {
      await api(`/auth/sessions/${s.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      toast.success(`Signed out ${s.browser ?? 'that device'}`);
    } catch (e) { toast.error(e.message); }
  };
  const signOutEverywhere = async () => {
    try { await api('/auth/logout-all', { method: 'POST' }); } catch { /* signed out locally anyway */ }
    await logout();
    navigate('/login', { replace: true, state: { notice: 'Signed out on every device.' } });
  };
  return (
    <Section title="Where you're signed in" description="Sign out a device you don't recognise or no longer use. Its open tabs disconnect at once.">
      {!data && <Spinner className="text-fg-subtle" />}
      <ul className="divide-y divide-line">
        {data?.map((s) => {
          const Icon = /iOS|Android/.test(s.os ?? '') ? Smartphone : Laptop;
          return (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <Icon className="size-5 shrink-0 text-fg-subtle" />
              <div className="min-w-0 flex-1 text-small">
                <p className="font-medium">
                  {[s.browser, s.os].filter(Boolean).join(' on ') || 'Unknown device'}
                  {s.current && <Badge tone="brand" className="ml-2">This device</Badge>}
                </p>
                <p className="text-caption text-fg-subtle" title={`Signed in ${formatDateTime(s.createdAt)}`}>
                  {s.ip ? `${s.ip} · ` : ''}active {timeAgo(s.lastSeenAt)} · signed in {formatDateTime(s.createdAt)}
                </p>
              </div>
              {!s.current && <Button size="sm" onClick={() => signOut(s)}><LogOut className="size-3.5" />Sign out</Button>}
            </li>
          );
        })}
      </ul>
      <Button className="mt-3" variant="ghost" onClick={() => setEverywhere(true)}>Sign out everywhere, including here</Button>
      <ConfirmDialog open={everywhere} title="Sign out everywhere?" confirmLabel="Sign out everywhere" onCancel={() => setEverywhere(false)} onConfirm={signOutEverywhere}>
        Every device, this one included, will need your password (and code) again.
      </ConfirmDialog>
    </Section>
  );
}

function DeleteAccount() {
  const { user, logout } = useAuth();
  // No password (GitHub / Google account): typing the email confirms instead.
  const byEmail = user.passwordSet === false;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setProblem('');
    try {
      await api('/auth/me', { method: 'DELETE', body: byEmail ? { confirmEmail: password } : { password } });
      await logout();
      navigate('/login', { replace: true, state: { notice: 'Your account was deleted.' } });
    } catch (e) {
      setProblem(e.code === 'sole_admin'
        ? `You are the only admin of ${e.details.map((p) => p.name).join(', ')}. Make someone else an admin there first, or delete those projects.`
        : e.message);
    } finally { setBusy(false); }
  };
  return (
    <Section title="Delete account" description="Projects only you are in are deleted with their tickets. In shared projects you leave and your tickets become unassigned." tone="danger">
      <Button variant="danger" onClick={() => setOpen(true)}><Trash2 className="size-4" />Delete my account</Button>
      <ConfirmDialog open={open} title="Delete your account for good?" confirmLabel="Delete my account" busy={busy} onCancel={() => setOpen(false)} onConfirm={remove}>
        <p>This can't be undone.</p>
        <label className="mt-3 block text-caption font-medium">{byEmail ? `Type ${user.email} to confirm` : 'Your password'}
          <input type={byEmail ? 'email' : 'password'} className="input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={byEmail ? 'off' : 'current-password'} />
        </label>
        {problem && <p className="mt-2 text-small text-danger">{problem}</p>}
      </ConfirmDialog>
    </Section>
  );
}

export default function AccountPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // Back from connecting GitHub / Google: say so once, then drop the message from history.
  useEffect(() => {
    if (location.state?.notice) {
      toast.success(location.state.notice);
      navigate('/account', { replace: true, state: null });
    }
  }, [location.state, navigate]);
  return (
    <div>
      <PageHeader crumbs={[{ label: 'Account' }]} title={<h1 className="font-display text-h1 italic text-fg">Your account</h1>} />
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Profile />
        <PreferencesSettings Section={Section} />
        <NotificationSettings Section={Section} />
        <PushSettings Section={Section} />
        <Section title="Leave" description="Days you are away. Teammates see them on the project calendar and timeline, and next to your name when assigning work."><MyLeave /></Section>
        <ConnectedAccounts />
        <Password />
        <TwoFactor />
        <ApiTokens Section={Section} />
        <Sessions />
        <DeleteAccount />
      </div>
    </div>
  );
}
