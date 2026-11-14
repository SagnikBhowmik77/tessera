import { useState } from 'react';
import clsx from 'clsx';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { ROLE_LABEL, formatDate } from '../lib/format.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, Spinner } from '../components/ui.jsx';
import { HeroWindow } from '../components/cinematic.jsx';

// Each project gets its own window pattern (the same one every time).
const seedOf = (text) => [...String(text)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 100003, 7);

// Where the invite email's link lands. Works signed out (to sign up or log in first).
export default function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, logout } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ['invite', token], queryFn: () => api(`/invites/${token}`).then((d) => d.invite), retry: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const respond = async (action) => {
    setBusy(true);
    setProblem('');
    try {
      const res = await api(`/invites/${token}/${action}`, { method: 'POST' });
      if (action === 'accept') {
        qc.invalidateQueries({ queryKey: qk.projects });
        navigate(`/projects/${res.project.id}`);
      } else navigate(user ? '/projects' : '/login');
    } catch (e) { setProblem(e.message); } finally { setBusy(false); }
  };
  const back = { from: `/invite/${token}`, email: data?.email };
  return (
    <div className="grid min-h-dvh place-items-center ds-canvas px-4">
      <div className="card w-full max-w-md overflow-hidden text-center shadow-lift">
        <HeroWindow seed={seedOf(data?.project?.name ?? token)} width={160} height={52} className="h-28 border-b border-line bg-sunken" />
        {/* Held at the invite's height while it loads, so the centred card does not move when it arrives. */}
        <div className={clsx('px-6 pb-8 pt-6 sm:px-8', !error && 'min-h-[17.5rem]')}>
        {isLoading && <div className="grid h-56 place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>}
        {error && (
          <>
            <h1 className="mt-4 text-h2 font-semibold text-fg">This invite can't be used</h1>
            <p className="mt-2 text-small text-fg-subtle">It may have expired, been used already, or been replaced by a newer invite. Ask for a new one.</p>
          </>
        )}
        {data && (
          <>
            <MailCheck className="mx-auto mt-4 size-6 text-accent" />
            <h1 className="mt-2 text-h2 font-semibold text-fg">Join {data.project.name}</h1>
            <p className="mt-2 text-small text-fg-subtle">
              {data.invitedBy ?? 'Someone'} invited <b className="text-fg">{data.email}</b> as {ROLE_LABEL[data.role].toLowerCase()}.
              The invite works until {formatDate(data.expiresAt)}.
            </p>
            {problem && <p className="mt-4 rounded-tile bg-danger/10 px-3 py-2 text-small text-danger  " role="alert">{problem}</p>}
            {user && user.email !== data.email ? (
              // Signed in as someone else: the server would refuse, so offer the way out instead.
              <>
                <p className="mt-4 text-small text-warning">You're logged in as {user.email}. Only {data.email} can accept this invite.</p>
                <div className="mt-6 flex justify-center">
                  <Button variant="primary" onClick={logout}>Sign out and switch account</Button>
                </div>
              </>
            ) : user ? (
              <div className="mt-6 flex justify-center gap-2">
                <Button onClick={() => respond('decline')} disabled={busy}>Decline</Button>
                <Button variant="primary" loading={busy} onClick={() => respond('accept')}>Accept and open the project</Button>
              </div>
            ) : (
              <div className="mt-6 flex flex-col gap-2">
                <Link to="/register" state={back} className="btn btn-primary">Create an account</Link>
                <Link to="/login" state={back} className="btn btn-secondary">I already have an account</Link>
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
