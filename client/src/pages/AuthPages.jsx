import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import { Activity, CircleAlert, CircleCheck, Eye, EyeOff, GitPullRequest, Radio, ScanSearch } from 'lucide-react';
import { api, apiBase } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
// From core directly: the sign-in pages are the first download, so they skip the motion library.
import { Button, Field, IconButton, Input, Logo, StainedWindow, buttonClasses } from '../ds/core.jsx';
import { HeroWindow } from '../components/cinematic.jsx';

// What Tessera actually does, shown beside the form. Every line is a feature that exists.
const POINTS = [
  { Icon: ScanSearch, title: 'Paste a stack trace, get a bug', text: 'Errors are parsed, grouped, and reopened if they come back.' },
  { Icon: Activity, title: 'Flow analytics', text: 'Cycle time, WIP limits, and the board as it was on any day.' },
  { Icon: Radio, title: 'Live together', text: 'See who is looking and typing; cards move as they move.' },
  { Icon: GitPullRequest, title: 'Outside-in', text: 'A public bug page for clients, and "fixes TES-12" from GitHub.' },
];

function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="ds-canvas grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* The window: brand artwork and what the product does. Wide screens only. */}
        <section className="relative hidden flex-col overflow-hidden border-r border-line bg-sunken px-12 py-10 lg:flex">
          <Logo wordmark size={30} />
          <div className="flex min-h-0 flex-1 items-center justify-center py-8">
            <div className="aspect-[5/6] h-full max-h-[26rem] min-h-48 overflow-hidden rounded-t-full rounded-b-panel bg-canvas p-1.5 shadow-lift">
              <HeroWindow seed={11} width={100} height={120} video="login-hero" className="size-full rounded-t-full rounded-b-card" />
            </div>
          </div>
          <div className="max-w-lg">
            <h1 className="font-display text-title italic text-fg">Every ticket is a tile. Every release, a window.</h1>
            <ul className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
              {POINTS.map(({ Icon, title: name, text }) => (
                <li key={name} className="flex gap-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span>
                    <span className="block text-small font-medium text-fg">{name}</span>
                    <span className="block text-caption text-fg-muted">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <main className="flex items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-sm">
            <div className="mb-8 lg:hidden">
              <Logo wordmark size={28} />
              <div className="mt-6 h-20 overflow-hidden rounded-card bg-sunken p-1 shadow-surface">
                <StainedWindow seed={11} width={240} height={60} className="size-full rounded-tile" />
              </div>
            </div>
            <h2 className="font-display text-title italic text-fg">{title}</h2>
            <p className="mt-2 text-small text-fg-muted">{subtitle}</p>
            <div className="mt-8">{children}</div>
          </div>
        </main>
    </div>
  );
}

// Runs a form's action; field errors go next to fields, anything else above the button.
// `onDone` replaces the default "go to where the person was headed" after success.
function useSubmit(action, { onDone } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage('');
    try {
      await action(Object.fromEntries(new FormData(e.currentTarget)));
      if (onDone) onDone();
      else navigate(location.state?.from ?? '/projects', { replace: true });
    } catch (err) {
      // A step that moved on by itself (e.g. to the 2FA code) is not an error.
      if (err.silent) return;
      const fields = err.fieldErrors?.() ?? {};
      setErrors(fields);
      if (!Object.keys(fields).length) setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { submit, errors, message, busy };
}

function Alert({ children, tone = 'danger' }) {
  const Icon = tone === 'danger' ? CircleAlert : CircleCheck;
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx('flex items-start gap-2 rounded-tile px-3 py-2.5 text-small', tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success')}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

const linkClass = 'ds-focus rounded-hair font-medium text-fg underline decoration-line-strong underline-offset-4 transition-colors duration-(--dur-fast) hover:decoration-fg';

// A password field with a show/hide button inside it.
function PasswordInput({ autoComplete, autoFocus }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input name="password" type={shown ? 'text' : 'password'} autoComplete={autoComplete} autoFocus={autoFocus} required className="pr-10" />
      <div className="absolute inset-y-0 right-1 flex items-center">
        <IconButton label={shown ? 'Hide password' : 'Show password'} icon={shown ? EyeOff : Eye} size="sm" onClick={() => setShown((s) => !s)} />
      </div>
    </div>
  );
}

const GitHubMark = () => (
  <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
const GoogleMark = () => (
  <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

// "Continue with GitHub / Google": plain links to the API, which runs the sign-in and sends the
// browser back to /oauth. Only providers the server has keys for are shown.
// The last answer is remembered, so the buttons are drawn at once on later visits; on a first visit
// their space is held (invisibly) until the server answers, so the form never jumps when they arrive.
const PROVIDERS_KEY = 'tessera.oauthProviders';
const rememberedProviders = () => { try { return JSON.parse(localStorage.getItem(PROVIDERS_KEY)); } catch { return null; } };

function OAuthButtons() {
  const location = useLocation();
  const [providers, setProviders] = useState(rememberedProviders);
  const [known, setKnown] = useState(false);
  useEffect(() => {
    api('/auth/oauth/providers')
      .then((d) => { setProviders(d.providers); try { localStorage.setItem(PROVIDERS_KEY, JSON.stringify(d.providers)); } catch { /* storage blocked */ } })
      .catch(() => setProviders({}))
      .finally(() => setKnown(true));
  }, []);
  // Not known yet and nothing remembered: hold the space of both buttons.
  const holding = !known && providers === null;
  const on = holding ? ['github', 'google'] : Object.entries(providers ?? {}).filter(([, ok]) => ok).map(([p]) => p);
  if (!on.length) return null;
  const from = location.state?.from ?? '/projects';
  const href = (p) => `${apiBase}/api/auth/oauth/${p}/start?${new URLSearchParams({ from })}`;
  const linkButton = buttonClasses({ variant: 'secondary', size: 'lg', className: 'w-full' });
  return (
    <div className={clsx('mt-6', holding && 'invisible')} aria-hidden={holding || undefined}>
      <div className="mb-4 flex items-center gap-3 text-caption text-fg-subtle"><span className="h-px flex-1 bg-line-strong" />or<span className="h-px flex-1 bg-line-strong" /></div>
      <div className="grid gap-2">
        {on.includes('github') && <a href={href('github')} className={linkButton}><GitHubMark />Continue with GitHub</a>}
        {on.includes('google') && <a href={href('google')} className={linkButton}><GoogleMark />Continue with Google</a>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, loginSecondStep } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // With 2FA on, a correct password leads to a second step: the code from the app.
  // GitHub / Google sign-in lands here with a ticket too, when the account has 2FA.
  const [ticket, setTicket] = useState(location.state?.ticket ?? null);
  const done = () => navigate(location.state?.from ?? '/projects', { replace: true });
  const first = useSubmit(async (body) => {
    const res = await login(body);
    if (res.twoFactorRequired) { setTicket(res.ticket); throw Object.assign(new Error(''), { silent: true }); }
  }, { onDone: done });
  const second = useSubmit(async ({ code }) => {
    const res = await loginSecondStep({ ticket, code });
    if (res.backupCodesLeft !== undefined) sessionStorage.setItem('tessera.backupNotice', String(res.backupCodesLeft));
  }, { onDone: done });

  if (ticket) {
    return (
      <AuthLayout title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app.">
        <form onSubmit={second.submit} className="space-y-5" noValidate>
          <Field label="Code" error={second.errors.code} hint="Lost your phone? Enter one of your backup codes instead.">
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={20} className="h-12 text-center font-code text-h2 tracking-[0.3em]" placeholder="123456" />
          </Field>
          {second.message && <Alert>{second.message}</Alert>}
          <Button type="submit" variant="primary" size="lg" loading={second.busy} className="w-full">Verify and log in</Button>
        </form>
        <p className="mt-8 text-center text-small text-fg-muted">
          <button type="button" className={linkClass} onClick={() => setTicket(null)}>Use a different account</button>
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your projects.">
      <form onSubmit={first.submit} className="space-y-5" noValidate>
        {location.state?.notice && <Alert tone="success">{location.state.notice}</Alert>}
        <Field label="Email" error={first.errors.email}><Input name="email" type="email" autoComplete="email" required /></Field>
        <div className="space-y-2">
          <Field label="Password" error={first.errors.password}><PasswordInput autoComplete="current-password" /></Field>
          <p className="text-right text-caption"><Link to="/forgot" className={linkClass}>Forgot password?</Link></p>
        </div>
        {first.message && <Alert>{first.message}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={first.busy} className="w-full">Sign in</Button>
      </form>
      <OAuthButtons />
      <p className="mt-8 text-center text-small text-fg-muted">New to Tessera? <Link to="/register" className={linkClass}>Create an account</Link></p>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState(null);
  const { submit, errors, message, busy } = useSubmit(async ({ email }) => {
    await api('/auth/forgot', { method: 'POST', body: { email } });
    setSentTo(email);
  }, { onDone: () => {} });
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {sentTo ? (
        <Alert tone="success">If an account uses <b>{sentTo}</b>, a reset link is on its way. It works for 1 hour. Check your spam folder too.</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-5" noValidate>
          <Field label="Email" error={errors.email}><Input name="email" type="email" autoComplete="email" required autoFocus /></Field>
          {message && <Alert>{message}</Alert>}
          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Send reset link</Button>
        </form>
      )}
      <p className="mt-8 text-center text-small text-fg-muted"><Link to="/login" className={linkClass}>Back to log in</Link></p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { submit, errors, message, busy } = useSubmit(async ({ password, confirm }) => {
    if (password !== confirm) throw Object.assign(new Error(''), { fieldErrors: () => ({ confirm: 'The two passwords are different' }) });
    await api('/auth/reset', { method: 'POST', body: { token, password } });
  }, { onDone: () => navigate('/login', { replace: true, state: { notice: 'Password changed. Sign in with your new password.' } }) });
  return (
    <AuthLayout title="Choose a new password" subtitle="You'll be signed out on every device and can log in again with it.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label="New password" error={errors.password} hint="At least 8 characters, with a letter and a number.">
          <PasswordInput autoComplete="new-password" autoFocus />
        </Field>
        <Field label="Repeat it" error={errors.confirm}><Input name="confirm" type="password" autoComplete="new-password" required /></Field>
        {message && <Alert>{message}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Save new password</Button>
      </form>
      <p className="mt-8 text-center text-small text-fg-muted"><Link to="/forgot" className={linkClass}>Send a new link</Link></p>
    </AuthLayout>
  );
}

const verifying = new Map();

export function VerifyEmailPage() {
  const { token } = useParams();
  const { user, setUser } = useAuth();
  const [state, setState] = useState({ status: 'working' });
  useEffect(() => {
    let live = true;
    // A link works once: share the request so a double effect doesn't use it up twice.
    if (!verifying.has(token)) verifying.set(token, api('/auth/verify', { method: 'POST', body: { token } }));
    verifying.get(token)
      .then((d) => { if (!live) return; setState({ status: 'ok', email: d.user.email }); if (user && user.id === d.user.id) setUser(d.user); })
      .catch((e) => { if (live) setState({ status: 'error', message: e.message }); });
    return () => { live = false; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AuthLayout title="Confirm your email" subtitle="One click and you're set.">
      {state.status === 'working' && <p className="text-small text-fg-muted">Checking your link…</p>}
      {state.status === 'ok' && <Alert tone="success"><b>{state.email}</b> is confirmed. You'll now get email notifications when you're away.</Alert>}
      {state.status === 'error' && <Alert>{state.message}</Alert>}
      <p className="mt-8 text-center text-small text-fg-muted"><Link to={user ? '/projects' : '/login'} className={linkClass}>{user ? 'Go to your projects' : 'Sign in'}</Link></p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const { submit, errors, message, busy } = useSubmit(register);
  // Coming from an invite link: the invited address is filled in.
  const invitedEmail = useLocation().state?.email ?? '';
  return (
    <AuthLayout title="Create your account" subtitle="Free. Start a project and invite your team.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label="Name" error={errors.name}><Input name="name" autoComplete="name" required /></Field>
        <Field label="Email" error={errors.email}><Input name="email" type="email" autoComplete="email" required defaultValue={invitedEmail} /></Field>
        <Field label="Password" error={errors.password} hint="At least 8 characters, with a letter and a number.">
          <PasswordInput autoComplete="new-password" />
        </Field>
        {message && <Alert>{message}</Alert>}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">Create account</Button>
      </form>
      <OAuthButtons />
      <p className="mt-8 text-center text-small text-fg-muted">Already have an account? <Link to="/login" className={linkClass}>Sign in</Link></p>
    </AuthLayout>
  );
}
