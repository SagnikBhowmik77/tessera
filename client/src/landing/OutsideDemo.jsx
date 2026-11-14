import { useId, useState } from 'react';
import clsx from 'clsx';
import { Check, Inbox, Link2, RotateCcw, UserRound } from 'lucide-react';
import { LANGUAGES, translate } from '../lib/i18n.js';
import { Badge, Button, TypeMark } from '../ds/core.jsx';
import DemoFrame from './DemoFrame.jsx';

// The outside-in loop on one screen: someone without an account reports a problem, the team
// works it, and the reporter follows along on a private page (and answers "fixed" or "still
// broken"). The reporter's side uses the public pages' own text, in any of their six languages.

const PROJECT = 'Orbit Checkout';
const STEPS = ['received', 'accepted', 'in_progress', 'fixed'];

function Pane({ icon: Icon, title, children, className }) {
  return (
    <section aria-label={title} className={clsx('flex min-w-0 flex-col rounded-card border border-line bg-canvas', className)}>
      <h4 className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-caption font-medium text-fg"><Icon className="size-3.5 text-fg-subtle" aria-hidden />{title}</h4>
      <div className="flex-1 p-3">{children}</div>
    </section>
  );
}

export default function OutsideDemo() {
  const id = useId();
  const [lang, setLang] = useState('en');
  const t = (key, vars) => translate(lang, key, vars);
  const [title, setTitle] = useState('');
  const [email, setEmail] = useState('');
  const [missing, setMissing] = useState(false);
  const [report, setReport] = useState(null); // { title, email }
  const [status, setStatus] = useState('received');
  const [answer, setAnswer] = useState(null); // 'fixed' | 'broken'
  const [reopened, setReopened] = useState(false);

  const send = (e) => {
    e.preventDefault();
    if (!title.trim()) { setMissing(true); return; }
    setReport({ title: title.trim(), email: email.trim() });
    setStatus('received');
    setAnswer(null);
    setReopened(false);
  };
  const reset = () => { setReport(null); setTitle(''); setEmail(''); setMissing(false); };
  const reply = (a) => {
    setAnswer(a);
    if (a === 'broken') { setStatus('in_progress'); setReopened(true); }
  };
  const at = STEPS.indexOf(status);

  return (
    <DemoFrame title="Outside-in: report, track, confirm" source="client/src/lib/i18n.js" sourceNote="the public pages' own words in all six of their languages">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-lang`} className="text-caption font-medium text-fg-muted">The reporter&rsquo;s language</label>
        <select
          id={`${id}-lang`}
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="ds-focus h-8 rounded-tile border border-line bg-field px-2 text-caption text-fg"
        >
          {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Pane icon={UserRound} title="A client, without an account">
          <div lang={lang}>
            {!report ? (
              <form onSubmit={send} className="space-y-2.5" noValidate>
                <p className="font-display text-h2 text-fg">{t('portal.title', { name: PROJECT })}</p>
                <div>
                  <label htmlFor={`${id}-what`} className="block text-caption font-medium text-fg-muted">{t('portal.what')}</label>
                  <input
                    id={`${id}-what`}
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); setMissing(false); }}
                    placeholder={t('portal.whatPlaceholder')}
                    maxLength={140}
                    aria-invalid={missing || undefined}
                    aria-describedby={missing ? `${id}-need` : undefined}
                    className="ds-focus mt-1 h-9 w-full rounded-tile border border-line bg-field px-2.5 text-small text-fg placeholder:text-fg-subtle aria-invalid:border-danger"
                  />
                  {missing && <p id={`${id}-need`} className="mt-1 text-caption text-danger">{t('portal.titleNeeded')}</p>}
                </div>
                <div>
                  <label htmlFor={`${id}-email`} className="block text-caption font-medium text-fg-muted">{t('portal.email')}</label>
                  <input
                    id={`${id}-email`}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    aria-describedby={`${id}-email-hint`}
                    className="ds-focus mt-1 h-9 w-full rounded-tile border border-line bg-field px-2.5 text-small text-fg placeholder:text-fg-subtle"
                  />
                  <p id={`${id}-email-hint`} className="mt-1 text-caption text-fg-subtle">{t('portal.emailHint')}</p>
                </div>
                <Button type="submit" variant="primary" size="sm">{t('portal.send')}</Button>
              </form>
            ) : (
              <div className="space-y-2.5">
                <p className="flex items-start gap-1.5 text-small font-medium text-fg"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{t('portal.thanks', { name: PROJECT })}</p>
                <p className="text-caption text-fg-muted">{t('portal.followHint')}</p>
                <p className="flex items-center gap-1.5 truncate rounded-tile bg-hover px-2 py-1.5 font-mono text-micro text-fg-muted"><Link2 className="size-3 shrink-0" aria-hidden />…/track/(private link)</p>
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={reset}>{t('portal.another')}</Button>
              </div>
            )}
          </div>
        </Pane>

        <Pane icon={Inbox} title="Your team, in Tessera">
          {!report ? (
            <p className="text-caption text-fg-subtle">The triage inbox is empty. Send the report on the left and it lands here.</p>
          ) : (
            <div className="space-y-2.5">
              <div className="rounded-tile bg-raised p-2.5 shadow-raised">
                <div className="flex items-center gap-1.5">
                  <TypeMark type="bug" className="size-3.5" />
                  <p className="min-w-0 flex-1 truncate text-small font-medium text-fg" title={report.title}>{report.title}</p>
                </div>
                <p className="mt-1 text-micro text-fg-subtle">From the public page · {report.email ? 'left an email' : 'no email, follows on the page'}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge tone={status === 'fixed' ? 'success' : status === 'closed' ? 'neutral' : 'info'}>
                    {status === 'received' ? 'In triage' : status === 'closed' ? 'Rejected' : translate('en', `track.${status}`)}
                  </Badge>
                  {reopened && <Badge tone="warning">Reopened by the reporter</Badge>}
                  {answer === 'fixed' && <Badge tone="success">Reporter confirmed the fix</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {status === 'received' && <><Button size="sm" variant="primary" onClick={() => setStatus('accepted')}>Accept</Button><Button size="sm" onClick={() => setStatus('closed')}>Reject</Button></>}
                {status === 'accepted' && <Button size="sm" variant="primary" onClick={() => setStatus('in_progress')}>Start work</Button>}
                {status === 'in_progress' && <Button size="sm" variant="primary" onClick={() => { setStatus('fixed'); setAnswer(null); }}>Mark it fixed</Button>}
                {status === 'fixed' && !answer && <p className="text-caption text-fg-subtle">Waiting for the reporter to confirm.</p>}
              </div>
            </div>
          )}
        </Pane>

        <Pane icon={Link2} title="The reporter's private tracking page">
          {!report ? (
            <p className="text-caption text-fg-subtle">Every report gets its own private link. It shows up here once the report is sent.</p>
          ) : (
            <div lang={lang} className="space-y-3">
              <p className="text-small font-medium text-fg">{t('track.yourReport', { name: PROJECT })}</p>
              {status === 'closed' ? (
                <p className="text-caption text-fg-muted">{t('track.closed')}</p>
              ) : (
                <ol className="space-y-1.5">
                  {STEPS.map((s, i) => (
                    <li key={s} className={clsx('flex items-center gap-2 text-caption', i <= at ? 'text-fg' : 'text-fg-subtle')}>
                      <span className={clsx('grid size-4 place-items-center rounded-full border', i <= at ? 'border-transparent bg-success text-on-glass' : 'border-line-strong')} aria-hidden>
                        {i <= at && <Check className="size-2.5" strokeWidth={3} />}
                      </span>
                      {t(`track.${s}`)}
                      <span className="sr-only">{i <= at ? '(done)' : '(not yet)'}</span>
                    </li>
                  ))}
                </ol>
              )}
              {status === 'fixed' && !answer && (
                <div className="space-y-1.5">
                  <p className="text-caption font-medium text-fg">{t('track.question')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" onClick={() => reply('fixed')}>{t('track.yesFixed')}</Button>
                    <Button size="sm" onClick={() => reply('broken')}>{t('track.stillBroken')}</Button>
                  </div>
                </div>
              )}
              {answer && <p className="text-caption text-fg-muted" aria-live="polite">{t(answer === 'fixed' ? 'track.thanksFixed' : 'track.thanksBroken')}</p>}
            </div>
          )}
        </Pane>
      </div>
    </DemoFrame>
  );
}
