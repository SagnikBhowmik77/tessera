import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleAlert, ThumbsUp } from 'lucide-react';
import { api } from '../lib/api.js';
import { usePublicLang } from '../lib/i18n.js';
import { Badge, STATUS_META, TypeMark } from '../ds/core.jsx';
import { PublicFrame, PublicGone, PublicSkeleton } from '../components/PublicFrame.jsx';

// The public roadmap (E11). People have no account here: their browser makes a random id once and
// sends it with each vote (the server keeps only a hash of it). Without storage, it lasts the visit.
const VOTER_KEY = 'tessera.roadmapVoter';
let memoryVoter = null;
function voterId() {
  try {
    let v = localStorage.getItem(VOTER_KEY);
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(VOTER_KEY, v); }
    return v;
  } catch {
    memoryVoter ??= crypto.randomUUID();
    return memoryVoter;
  }
}
const STAGES = ['planned', 'in_progress', 'done'];

export default function RoadmapPage() {
  const { token } = useParams();
  const [t, lang, setLang] = usePublicLang();
  const qc = useQueryClient();
  const [voter] = useState(voterId);
  const key = ['roadmap-page', token];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api(`/roadmap/${token}`, { headers: { 'x-roadmap-voter': voter } }), retry: false });
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const pageTitle = data ? t('roadmap.title', { name: data.project.name }) : null;
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { if (pageTitle) document.title = pageTitle; }, [pageTitle]);

  const vote = async (number) => {
    setBusy(number);
    setProblem(null);
    try {
      const r = await api(`/roadmap/${token}/items/${number}/vote`, { method: 'POST', headers: { 'x-roadmap-voter': voter } });
      qc.setQueryData(key, (d) => ({ ...d, items: d.items.map((i) => (i.number === number ? { ...i, votes: r.votes, voted: r.voted } : i)) }));
    } catch (e) { setProblem(e.message); } finally { setBusy(null); }
  };

  // The same frame as the report and tracking pages, wider for three columns.
  return (
    <PublicFrame project={data?.project} t={t} lang={lang} setLang={setLang} width="max-w-5xl">
      {isLoading && <PublicSkeleton className="min-h-[24rem]" />}
      {error && <div className="mx-auto max-w-xl"><PublicGone title={t('roadmap.unavailable')} hint={t('roadmap.unavailableHint')} /></div>}
      {data && (
        <div className="space-y-5">
          <header>
            <h1 className="font-display text-h1 text-balance text-fg sm:text-display">{pageTitle}</h1>
            {data.intro && <p className="mt-2 text-pretty text-body text-fg-muted">{data.intro}</p>}
            <p className="mt-1 text-caption text-fg-subtle">{t('roadmap.how')}</p>
          </header>
          {problem && <p className="flex items-start gap-2 rounded-tile bg-danger/10 px-3 py-2 text-small text-danger" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{problem}</p>}
          <div className="grid gap-3 md:grid-cols-3">
            {STAGES.map((stage) => {
              const items = data.items.filter((i) => i.stage === stage);
              const meta = STATUS_META[stage === 'planned' ? 'todo' : stage];
              return (
                <section key={stage} aria-labelledby={`stage-${stage}`} className="min-w-0 space-y-2 rounded-panel border border-line bg-sunken p-3">
                  <h2 id={`stage-${stage}`} className="flex items-center gap-2 px-1 pt-1 text-small font-semibold text-fg">
                    <meta.Icon className={clsx('size-3.5 shrink-0', meta.tone)} strokeWidth={2.25} aria-hidden />
                    {t(`roadmap.${stage}`)}
                    <Badge>{items.length}</Badge>
                  </h2>
                  {!items.length && <p className="grid h-16 place-items-center rounded-card border border-dashed border-line-strong text-caption text-fg-subtle">{t('roadmap.empty')}</p>}
                  {items.map((i) => (
                    <article key={i.number} className="flex items-start gap-3 rounded-card bg-surface p-3 shadow-surface">
                      <div className="min-w-0 flex-1">
                        <p className="text-small font-medium text-fg [overflow-wrap:anywhere]">{i.title}</p>
                        {i.type === 'bug' && <span className="mt-1.5 inline-flex"><TypeMark type="bug" /></span>}
                      </div>
                      {stage === 'done' ? (
                        <span className="shrink-0 text-caption tabular-nums text-fg-subtle">{t('roadmap.votes', { n: i.votes })}</span>
                      ) : (
                        <button type="button" onClick={() => vote(i.number)} disabled={busy === i.number} aria-pressed={i.voted}
                          aria-label={`${t(i.voted ? 'roadmap.voted' : 'roadmap.vote')}: ${i.title} (${i.votes})`}
                          className={clsx('ds-focus flex min-w-10 shrink-0 flex-col items-center gap-0.5 rounded-tile border px-2 py-1.5 text-caption transition-colors duration-(--dur-fast)', i.voted ? 'border-key-line bg-key-bg text-key' : 'border-line-strong text-fg-muted hover:border-fg-faint hover:text-fg')}>
                          <ThumbsUp className="size-3.5" aria-hidden />
                          <span className="font-semibold tabular-nums">{i.votes}</span>
                        </button>
                      )}
                    </article>
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </PublicFrame>
  );
}
