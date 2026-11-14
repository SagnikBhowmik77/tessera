import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, Check, CircleAlert, Clock, GitMerge, Rocket } from 'lucide-react';
import { api } from '../lib/api.js';
import { formatDay, usePublicLang } from '../lib/i18n.js';
import { Avatar, Button, KeyChip, Textarea, glassColour } from '../ds/core.jsx';
import { PublicFrame, PublicGone, PublicSkeleton } from '../components/PublicFrame.jsx';

// An outside reporter's private page (E11): where their report is, a conversation with the team,
// and "is it fixed for you?". The link from their email is the only access.
const STEPS = ['received', 'accepted', 'in_progress', 'fixed'];

// Four panes, set in glass as the report moves along; the ones still ahead are empty outlines.
function Progress({ at, t }) {
  return (
    <ol className="grid grid-cols-4">
      {STEPS.map((s, i) => {
        const reached = i <= at;
        return (
          <li key={s} aria-current={i === at ? 'step' : undefined} className="relative flex flex-col items-center text-center">
            {i > 0 && (
              <span aria-hidden className={clsx('absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2', reached ? 'ds-gradient' : 'bg-line')} style={reached ? { opacity: 0.6 } : undefined} />
            )}
            <span
              aria-hidden
              className={clsx(
                'relative grid size-8 place-items-center rounded-tile text-caption font-semibold',
                reached ? 'text-on-gradient shadow-raised' : 'border border-dashed border-line-strong bg-surface text-fg-subtle',
                i === at && 'ring-2 ring-key-line ring-offset-2 ring-offset-surface',
              )}
              style={reached ? { background: glassColour(i / 3) } : undefined}
            >
              {i < at ? <Check className="size-4" strokeWidth={2.75} /> : i + 1}
            </span>
            <span className={clsx('mt-2 px-0.5 text-caption leading-tight', i === at ? 'font-semibold text-fg' : reached ? 'text-fg-muted' : 'text-fg-subtle')}>
              {t(`track.${s}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Note({ icon: Icon, children }) {
  return (
    <p className="flex items-start gap-2.5 rounded-tile bg-sunken px-3 py-2.5 text-small text-fg">
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />{children}
    </p>
  );
}

export default function TrackPage() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const [t, lang, setLang] = usePublicLang();
  const qc = useQueryClient();
  const key = ['track', token];
  const { data: report, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api(`/track/${token}`).then((d) => d.report), retry: false });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [thanks, setThanks] = useState(null);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { if (report) document.title = `${report.reference} · ${report.project.name}`; }, [report]);
  // Links in the "fixed" email carry ?answer=…; nothing is sent until the person clicks here
  // (mail scanners open links on their own).
  const fromEmail = ['fixed', 'broken'].includes(params.get('answer')) ? params.get('answer') : null;

  const send = async (path, body) => {
    setBusy(true);
    setProblem(null);
    try {
      const r = (await api(`/track/${token}/${path}`, { method: 'POST', body })).report;
      qc.setQueryData(key, r);
      return r;
    } catch (e) { setProblem(e.message); return null; } finally { setBusy(false); }
  };
  const answer = async (value) => {
    if (await send('answer', { answer: value })) { setThanks(value); setParams({}, { replace: true }); }
  };

  const at = report ? STEPS.indexOf(report.state) : -1;
  return (
    <PublicFrame project={report && { ...report.project, key: report.project.key ?? report.reference.split('-')[0] }} t={t} lang={lang} setLang={setLang}>
      {isLoading && <PublicSkeleton className="min-h-[34rem]" />}
      {error && <PublicGone title={t('track.unavailable')} hint={t('track.unavailableHint')} />}
      {report && (
        <div className="space-y-3">
          <section className="space-y-6 rounded-panel bg-surface p-5 shadow-raised sm:p-8">
            <div>
              <p className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle">
                <KeyChip>{report.reference}</KeyChip>{t('track.yourReport', { name: report.project.name })}
              </p>
              <h1 className="mt-3 font-display text-h1 text-balance text-fg">{report.title}</h1>
              <p className="mt-1.5 text-caption text-fg-subtle">{t('track.reported', { date: formatDay(report.reportedAt, lang) })}</p>
            </div>

            {report.state === 'closed' ? <Note icon={Archive}>{t('track.closed')}</Note> : <Progress at={at} t={t} />}

            {(report.merged || report.live || report.waitingForRelease) && (
              <div className="space-y-2">
                {report.merged && <Note icon={GitMerge}>{t('track.merged')}</Note>}
                {report.live && <Note icon={Rocket}>{t('track.live', { release: report.live.release })}</Note>}
                {report.waitingForRelease && <Note icon={Clock}>{t('track.waiting')}</Note>}
              </div>
            )}

            {report.canAnswer && (
              <div className={clsx('rounded-card border p-4', fromEmail ? 'border-key-line bg-key-bg' : 'border-line')}>
                {thanks ? (
                  <p className="flex items-center gap-2 text-small font-medium text-fg" role="status">
                    <Check className="size-4 shrink-0 text-success" aria-hidden />{t(thanks === 'fixed' ? 'track.thanksFixed' : 'track.thanksBroken')}
                  </p>
                ) : (
                  <>
                    {fromEmail && <p className="mb-1 text-caption text-fg-muted">{t('track.fromEmail')}</p>}
                    <p className="text-body font-semibold text-fg">{t('track.question')}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant={fromEmail === 'fixed' || report.answer?.value === 'fixed' ? 'primary' : 'secondary'} disabled={busy} onClick={() => answer('fixed')}>{t('track.yesFixed')}</Button>
                      <Button variant={fromEmail === 'broken' ? 'primary' : 'secondary'} disabled={busy} onClick={() => answer('broken')}>{t('track.stillBroken')}</Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="rounded-panel bg-surface p-5 shadow-raised sm:p-8" aria-labelledby="track-conversation">
            <h2 id="track-conversation" className="text-h3 font-semibold text-fg">{t('track.conversation')}</h2>
            {!report.messages.length && <p className="mt-2 text-small text-fg-subtle">{t('track.none')}</p>}
            {report.messages.length > 0 && (
              <ul className="mt-4 space-y-3">
                {report.messages.map((m) => {
                  const mine = m.from === 'you';
                  return (
                    <li key={m.id} className={clsx('flex items-end gap-2', mine && 'flex-row-reverse')}>
                      {!mine && <Avatar name={m.name} size="sm" />}
                      <div className={clsx('max-w-[85%] rounded-card px-3.5 py-2.5', mine ? 'rounded-br-hair border border-key-line bg-key-bg' : 'rounded-bl-hair bg-sunken')}>
                        <p className="text-micro text-fg-subtle">{mine ? t('track.you') : `${m.name} · ${t('track.team')}`} · {formatDay(m.at, lang)}</p>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-small text-fg">{m.body}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {report.canWrite && (
              <form className="mt-5 space-y-2" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && await send('messages', { body: text.trim() })) setText(''); }}>
                <Textarea rows={3} maxLength={5000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('track.write')} aria-label={t('track.write')} />
                <div className="flex justify-end">
                  <Button type="submit" variant="primary" loading={busy} disabled={!text.trim()}>{t('track.send')}</Button>
                </div>
              </form>
            )}
            {problem && (
              <p className="mt-3 flex items-start gap-2 rounded-tile bg-danger/10 px-3 py-2 text-small text-danger" role="alert">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{problem}
              </p>
            )}
          </section>
        </div>
      )}
    </PublicFrame>
  );
}
