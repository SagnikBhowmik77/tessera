import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Logo, Spinner } from '../components/ui.jsx';

// GitHub / Google send the browser here (via the API) with a one-time code in the URL fragment.
// The code is traded for the session; the fragment is wiped from the address bar straight away.
// The exchange is shared per code, so React's double effect in development can't use it twice.
const exchanges = new Map();

export default function OAuthPage() {
  const navigate = useNavigate();
  const { adoptToken } = useAuth();
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const from = params.get('from') || '/projects';
    const mode = params.get('mode');
    if (params.toString()) window.history.replaceState(null, '', '/oauth');
    if (params.get('error')) {
      setProblem({ message: params.get('error'), back: mode === 'link' ? '/account' : '/login' });
      return;
    }
    const code = params.get('code');
    if (!code) {
      if (!exchanges.size) setProblem({ message: 'This sign-in link is empty or was already used.', back: '/login' });
      return;
    }
    if (!exchanges.has(code)) exchanges.set(code, api('/auth/oauth/exchange', { method: 'POST', body: { code } }));
    exchanges.get(code)
      .then((res) => {
        if (res.linked) {
          navigate('/account', { replace: true, state: { notice: `${res.linked === 'github' ? 'GitHub' : 'Google'} is connected. You can now sign in with it.` } });
        } else if (res.twoFactorRequired) {
          // Same code step as a password login.
          navigate('/login', { replace: true, state: { ticket: res.ticket, from } });
        } else {
          adoptToken(res.token, res.user);
          navigate(from, { replace: true });
        }
      })
      .catch((e) => setProblem({ message: e.message, back: '/login' }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid min-h-dvh place-items-center ds-canvas px-4">
      <div className="card w-full max-w-sm p-8 text-center">
        <Logo className="mx-auto size-10" />
        {problem ? (
          <>
            <h1 className="mt-4 text-h2 font-semibold text-fg">Couldn't sign you in</h1>
            <p className="mt-2 text-small text-fg-muted" role="alert">{problem.message}</p>
            <Link to={problem.back} className="btn btn-primary mt-6 inline-flex">{problem.back === '/account' ? 'Back to your account' : 'Back to log in'}</Link>
          </>
        ) : (
          <>
            <Spinner className="mx-auto mt-6 size-6 text-fg-subtle" />
            <p className="mt-3 text-small text-fg-subtle">Signing you in…</p>
          </>
        )}
      </div>
    </div>
  );
}
