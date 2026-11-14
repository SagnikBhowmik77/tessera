import { useEffect } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { Badge, Logo, PriorityDot, Spinner, TypeIcon } from '../components/ui.jsx';
import { KeyChip } from '../ds/core.jsx';

// A board shared by link (E11): read-only, no account, refreshed every minute while open.
export default function SharedBoardPage() {
  const { token } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ['shared-board', token], queryFn: () => api(`/shared/${token}`), retry: false, refetchInterval: 60_000 });
  useEffect(() => { if (data) document.title = `${data.project.name} board`; }, [data]);
  return (
    <div className="min-h-dvh ds-canvas ds-public-light px-4 py-8">
      <div className="mx-auto max-w-7xl space-y-4">
        {isLoading && <div className="grid place-items-center py-20"><Spinner className="size-6 text-fg-subtle" /></div>}
        {error && (
          <div className="card mx-auto max-w-xl p-8 text-center">
            <h1 className="text-h2 font-semibold text-fg">This board link isn't available</h1>
            <p className="mt-2 text-small text-fg-subtle">The link may be wrong, or the team has turned it off.</p>
          </div>
        )}
        {data && (
          <>
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h1 className="font-display text-h1 italic text-fg">{data.project.name}</h1>
                <p className="text-caption text-fg-subtle">Read-only view shared by the team · updated {formatDateTime(data.generatedAt)}</p>
              </div>
              <Badge>{data.tickets.length} tickets</Badge>
            </header>
            <div className="scroll-thin flex gap-3 overflow-x-auto pb-2">
              {data.statuses.map((s) => {
                const cards = data.tickets.filter((x) => x.status === s.key);
                return (
                  <section key={s.key} className="w-72 shrink-0 space-y-2 rounded-tile bg-hover p-2 ">
                    <h2 className="px-1 text-caption font-semibold uppercase tracking-wide text-fg-subtle">{s.name} <span className="font-normal">({cards.length})</span></h2>
                    {cards.map((c) => (
                      <article key={c.key} className="card space-y-1.5 p-2.5 text-small">
                        <p className="break-words font-medium leading-snug">{c.title}</p>
                        <div className="flex flex-wrap items-center gap-1.5 text-caption text-fg-subtle">
                          <TypeIcon type={c.type} />
                          <KeyChip>{c.key}</KeyChip>
                          <PriorityDot priority={c.priority} />
                          {c.storyPoints != null && <Badge>{c.storyPoints} pt</Badge>}
                          {c.dueDate && <span>due {c.dueDate}</span>}
                          {c.labels.map((l) => <Badge key={l}>{l}</Badge>)}
                          {c.assignee && <span className="ml-auto">{c.assignee}</span>}
                        </div>
                      </article>
                    ))}
                  </section>
                );
              })}
            </div>
          </>
        )}
        <p className="flex items-center justify-center gap-1.5 text-caption text-fg-subtle"><Logo className="size-4" />Powered by Tessera</p>
      </div>
    </div>
  );
}
