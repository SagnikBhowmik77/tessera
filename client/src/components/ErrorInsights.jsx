import { Suspense, lazy, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { ArrowLeftRight, TrendingUp, BellOff, Bell, GitCommitHorizontal, GitPullRequest, History, VolumeX } from 'lucide-react';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { formatDate, formatDateTime, timeAgo } from '../lib/format.js';
import { Badge, Button, KeyLink, Spinner } from './ui.jsx';
import { SuspectCommit } from './GithubTools.jsx';
import { useProject } from '../lib/queries.js';
import { EmptyNote } from '../ds/core.jsx';

const Timeline = lazy(() => import('./ErrorTimeline.jsx'));

// Bug intelligence II (E5A): impact, regression timeline, affected environments, fix memory and
// muting, for a ticket made from an error. Everything here is computed by the server from the
// reports actually received and the ticket's own history.

const LEVEL_TONE = { severe: 'red', high: 'amber', moderate: 'brand', low: 'zinc' };
const LEVEL_LABEL = { severe: 'Severe', high: 'High', moderate: 'Moderate', low: 'Low' };

export function ImpactBadge({ impact, className }) {
  if (!impact) return null;
  return (
    <Badge tone={LEVEL_TONE[impact.level]} className={className}>
      <span className="tabular-nums">{impact.score}</span> {LEVEL_LABEL[impact.level]}
    </Badge>
  );
}

const MUTE_OPTIONS = [['1h', '1 hour'], ['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days'], ['forever', 'Until unmuted']];

function MuteControl({ pid, number, mute, canWork }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [span, setSpan] = useState('7d');
  const [reason, setReason] = useState('');
  // Resolves once the panel has the new state, so the form doesn't close onto stale data.
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: qk.ticket(pid, number) }),
    qc.invalidateQueries({ queryKey: ['error-insights', pid, String(number)] }),
    qc.invalidateQueries({ queryKey: qk.history(pid, number) }),
    qc.invalidateQueries({ queryKey: ['errors', pid] }),
  ]);
  const muteIt = useMutation({
    mutationFn: () => api(`/projects/${pid}/tickets/${number}/error/mute`, { method: 'PUT', body: { for: span, ...(reason.trim() && { reason: reason.trim() }) } }),
    onSuccess: async () => { await refresh(); setOpen(false); setReason(''); toast.success('Muted. New reports are still counted.'); },
    onError: (e) => toast.error(e.message),
  });
  const unmute = useMutation({
    mutationFn: () => api(`/projects/${pid}/tickets/${number}/error/mute`, { method: 'DELETE' }),
    onSuccess: async () => { await refresh(); toast.success('Unmuted'); },
    onError: (e) => toast.error(e.message),
  });

  if (mute?.active) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-tile bg-hover px-3 py-2 text-caption ">
        <VolumeX className="size-3.5 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <b>Muted</b> {mute.forever ? 'until someone unmutes it' : `until ${formatDateTime(mute.until)}`}.
          {' '}New reports are counted but don&apos;t reopen it, notify anyone or run rules.
          {mute.reason && <> Reason: <i>{mute.reason}</i></>}
        </span>
        {canWork && <Button size="sm" variant="ghost" loading={unmute.isPending} onClick={() => unmute.mutate()}><Bell className="size-3.5" />Unmute</Button>}
      </div>
    );
  }
  if (!canWork) return null;
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><BellOff className="size-3.5" />Mute…</Button>;
  return (
    <div className="space-y-2 rounded-tile border border-line bg-surface p-3 text-caption">
      <p className="text-fg-muted">While muted, reports are still counted and kept, but they won&apos;t reopen this ticket, notify anyone or run automation rules.</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Mute for">
        {MUTE_OPTIONS.map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={span === key} onClick={() => setSpan(key)}
            className={clsx('rounded-tile border px-2 py-1', span === key ? 'border-transparent bg-fg text-canvas' : 'border-line')}>
            {label}
          </button>
        ))}
      </div>
      <input className="input h-8 text-caption" maxLength={200} placeholder="Why (optional), e.g. only on the old app version" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for muting" />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={muteIt.isPending} onClick={() => muteIt.mutate()}>Mute</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}


function Shares({ title, items, total }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 text-micro font-medium uppercase tracking-wide text-fg-subtle">{title}</p>
      <ul className="space-y-1">
        {items.slice(0, 5).map((it) => {
          const pct = Math.round((it.count / total) * 100);
          return (
            <li key={it.name} className="text-caption">
              <div className="flex justify-between gap-2"><span className="truncate">{it.name}</span><span className="tabular-nums text-fg-subtle">{it.count} · {pct}%</span></div>
              <div className="mt-0.5 h-1.5 rounded-full bg-hover"><div className="h-1.5 rounded-full bg-info" style={{ width: `${pct}%` }} /></div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const LinkRef = ({ link }) => (
  <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-code text-accent underline " title={link.title}>
    {link.kind === 'pull_request' ? <GitPullRequest className="size-3" /> : <GitCommitHorizontal className="size-3" />}{link.ref}
  </a>
);

export function FixMemory({ fixes = [], related = [], pid }) {
  if (!fixes.length && !related.length) {
    return <EmptyNote size="xs">No earlier fix for this crash or a similar one in this project yet.</EmptyNote>;
  }
  return (
    <div className="space-y-3 text-caption">
      {fixes.length > 0 && (
        <ul className="space-y-1.5">
          {fixes.map((f, i) => (
            <li key={i}>
              Finished {formatDate(f.at)}{f.by?.name ? ` by ${f.by.name}` : f.source !== 'app' ? ` (${f.source})` : ''}
              {f.links.length > 0 ? <> with {f.links.map((l, j) => <span key={j}>{j > 0 && ', '}<LinkRef link={l} /></span>)}</> : ', no commit or PR linked'}
              {f.cameBackAt && <span className="text-danger">. Came back {formatDate(f.cameBackAt)}</span>}.
            </li>
          ))}
        </ul>
      )}
      {related.length > 0 && (
        <div>
          {fixes.length > 0 && <p className="mb-1 text-fg-subtle">Similar crashes already fixed:</p>}
          <ul className="space-y-1.5">
            {related.map((r) => (
              <li key={r.key}>
                <KeyLink to={`/projects/${pid}/tickets/${r.key}`}>{r.key}</KeyLink> {r.title}
                <span className="text-fg-subtle"> · {r.because.join(', ')}{r.resolvedAt && ` · fixed ${formatDate(r.resolvedAt)}`}</span>
                {r.links.length > 0 && <> · {r.links.map((l, j) => <span key={j}>{j > 0 && ', '}<LinkRef link={l} /></span>)}</>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ErrorInsights({ pid, ticket, canWork }) {
  const [why, setWhy] = useState(false);
  const { data: project } = useProject(pid);
  const { data, isLoading, error } = useQuery({
    // Refetched whenever the ticket changes (new report, status, mute).
    queryKey: ['error-insights', pid, String(ticket.number), ticket.updatedAt],
    queryFn: () => api(`/projects/${pid}/tickets/${ticket.number}/error/insights`).then((d) => d.insights),
  });
  if (isLoading) return <div className="mt-3"><Spinner className="text-fg-subtle" /></div>;
  if (error) return <p className="mt-3 text-caption text-danger">{error.message}</p>;
  const { impact, history, environments, timeline, fixes, related, mute } = data;
  return (
    <div className="mt-4 space-y-4 border-t border-danger/20 pt-4 ">
      <MuteControl pid={pid} number={ticket.number} mute={mute} canWork={canWork} />
      {data.spike?.spiking && (
        <p className="flex items-start gap-2 rounded-tile bg-danger/12 px-3 py-2 text-caption text-danger">
          <TrendingUp className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span><b>Spiking:</b> {data.spike.lastHour} reports in the last hour, against {data.spike.baseline < 0.1 ? 'almost none' : `about ${data.spike.baseline} an hour`} over the week before.{data.spike.alertedAt && ` An alert went out ${timeAgo(data.spike.alertedAt)}.`}</span>
        </p>
      )}

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-caption font-semibold">Impact</h4>
          <ImpactBadge impact={impact} />
          <button type="button" className="text-caption text-fg-subtle underline" onClick={() => setWhy((w) => !w)} aria-expanded={why}>{why ? 'Hide why' : 'Why?'}</button>
        </div>
        {why && (
          <table className="mt-2 w-full text-caption">
            <tbody>
              {impact.parts.map((p) => (
                <tr key={p.key} className="border-b border-line last:border-0 ">
                  <td className="py-1">{p.label}</td>
                  <td className="py-1 text-right tabular-nums text-fg-subtle">{p.value}</td>
                  <td className="w-16 py-1 text-right tabular-nums">{p.points} / {p.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h4 className="mb-1 flex items-center gap-1.5 text-caption font-semibold"><History className="size-3.5" aria-hidden />Reports over time</h4>
        <Suspense fallback={<div className="h-32" aria-hidden />}><Timeline timeline={timeline} /></Suspense>
        {history.untracked > 0 && (
          <p className="mt-1 text-micro text-fg-subtle">
            {history.untracked} earlier report{history.untracked === 1 ? ' was' : 's were'} counted before per-report history was kept, so {history.untracked === 1 ? 'it is' : 'they are'} in the total but not in this chart.
          </p>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-caption font-semibold">Where it happens</h4>
        {environments.total - environments.unknown === 0 ? (
          <EmptyNote size="xs">No report came with browser or OS details.</EmptyNote>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Shares title="Browser" items={environments.browsers} total={environments.total} />
            <Shares title="Operating system" items={environments.os} total={environments.total} />
          </div>
        )}
        {(environments.releases?.length > 0 || environments.appEnvironments?.length > 0) && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Shares title="Release" items={environments.releases ?? []} total={environments.total} />
            <Shares title="Environment" items={environments.appEnvironments ?? []} total={environments.total} />
          </div>
        )}
        {environments.unknown > 0 && environments.total > environments.unknown && (
          <p className="mt-1 text-micro text-fg-subtle">{environments.unknown} of {environments.total} reports had no browser or OS details.</p>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-caption font-semibold">How it was fixed before</h4>
        <FixMemory fixes={fixes} related={related} pid={pid} />
        <div className="mt-4"><SuspectCommit pid={pid} ticket={ticket} canWork={canWork} hasToken={Boolean(project?.github?.token)} /></div>
        <Link to={`/projects/${pid}/errors/compare?a=${ticket.key}${related[0] ? `&b=${related[0].key}` : ''}`} className="mt-3 inline-flex items-center gap-1 text-caption text-accent underline "><ArrowLeftRight className="size-3.5" aria-hidden />Compare with another crash</Link>
      </div>
    </div>
  );
}
