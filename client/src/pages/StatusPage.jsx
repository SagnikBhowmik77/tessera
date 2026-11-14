import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { formatDateTime, timeAgo } from '../lib/format.js';
import { Logo, Spinner } from '../components/ui.jsx';
import { EmptyNote } from '../ds/core.jsx';

// The public status page (E8): what the team chose to publish, nothing else.
export default function StatusPage() {
  const { token } = useParams();
  const { data, error, isLoading } = useQuery({ queryKey: ['status', token], queryFn: () => api(`/status/${token}`), refetchInterval: 60_000 });
  if (isLoading) return <div className="grid min-h-screen place-items-center"><Spinner className="size-6 text-fg-subtle" /></div>;
  if (error) return <div className="grid min-h-screen place-items-center p-6 text-center text-small text-fg-subtle">{error.message}</div>;
  const ok = data.state === 'operational';
  return (
    <div className="min-h-screen bg-hover px-4 py-10 ">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="font-display text-h1 italic text-fg">{data.name} status</h1>
        <div className={ok ? 'card flex items-center gap-3 border-success/40 p-4 ' : 'card flex items-center gap-3 border-danger/45 p-4 '}>
          {ok ? <CheckCircle2 className="size-6 text-success" /> : <AlertTriangle className="size-6 text-danger" />}
          <div>
            <p className="font-semibold">{ok ? 'All systems operational' : `${data.incidents.length} ongoing incident${data.incidents.length === 1 ? '' : 's'}`}</p>
            {data.lastDeploy && <p className="text-caption text-fg-subtle">Last update: release <span className="font-code">{data.lastDeploy.release}</span>, {timeAgo(data.lastDeploy.at)}</p>}
          </div>
        </div>
        {data.incidents.length > 0 && (
          <section className="card p-4">
            <h2 className="mb-2 text-small font-semibold">Ongoing</h2>
            <ul className="space-y-2 text-small">{data.incidents.map((i, k) => <li key={k}><p className="font-medium">{i.title}</p><p className="text-caption text-fg-subtle">since {formatDateTime(i.since)}</p></li>)}</ul>
          </section>
        )}
        {data.crashes24h !== null && <p className="text-caption text-fg-subtle">Crash reports in the last 24 hours: {data.crashes24h}</p>}
        <section className="card p-4">
          <h2 className="mb-2 text-small font-semibold">Recent updates</h2>
          {!data.deploys.length ? <EmptyNote>None in the last 90 days.</EmptyNote> : (
            <ul className="space-y-1.5 text-small">
              {data.deploys.map((d, k) => (
                <li key={k} className="flex items-center gap-2">
                  {d.status === 'success' ? <CheckCircle2 className="size-4 text-success" aria-label="Succeeded" /> : <XCircle className="size-4 text-danger" aria-label="Failed" />}
                  <span className="font-code">{d.release}</span><span className="ml-auto text-caption text-fg-subtle">{formatDateTime(d.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="flex items-center justify-center gap-1.5 pt-4 text-caption text-fg-subtle"><Logo className="size-4" />Powered by Tessera</p>
      </div>
    </div>
  );
}
