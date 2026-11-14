import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Bug, Check, ChevronDown, CircleAlert, Lightbulb, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { usePublicLang } from '../lib/i18n.js';
import { Button, Field, Input, KeyChip, Textarea, glassColour } from '../ds/core.jsx';
import { PublicFrame, PublicGone, PublicSkeleton } from '../components/PublicFrame.jsx';
import ReportQuality from '../components/ReportQuality.jsx';

// Cloudflare Turnstile ("I am human"), only when the server has it switched on.
function Turnstile({ siteKey, onToken }) {
  const box = useRef(null);
  useEffect(() => {
    let widget;
    const render = () => { widget = window.turnstile.render(box.current, { sitekey: siteKey, callback: onToken, 'expired-callback': () => onToken('') }); };
    if (window.turnstile) render();
    else {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = render;
      document.head.appendChild(s);
    }
    return () => { if (widget !== undefined) window.turnstile?.remove(widget); };
  }, [siteKey, onToken]);
  return <div ref={box} />;
}

// "Something is broken" or "I have an idea": two real radio buttons dressed as cards.
function KindChoice({ value, onChange, t }) {
  const options = [
    { key: 'bug', Icon: Bug, label: t('portal.bug'), hint: t('portal.bugHint') },
    { key: 'feature', Icon: Lightbulb, label: t('portal.idea'), hint: t('portal.ideaHint') },
  ];
  return (
    <div role="radiogroup" aria-label={`${t('portal.bug')} / ${t('portal.idea')}`} className="grid grid-cols-2 gap-2">
      {options.map(({ key, Icon, label, hint }) => (
        <label
          key={key}
          className={clsx(
            'ds-focus-within relative flex cursor-pointer flex-col gap-1 rounded-card border p-3 transition-[border-color,background-color,box-shadow] duration-(--dur-fast) sm:p-3.5',
            value === key ? 'border-key-line bg-key-bg shadow-raised' : 'border-line hover:border-line-strong hover:bg-hover',
          )}
        >
          <input type="radio" name="kind" value={key} checked={value === key} onChange={() => onChange(key)} className="sr-only" />
          <span className="flex items-center gap-2 text-small font-semibold text-fg">
            <Icon className={clsx('size-4 shrink-0', value === key ? 'text-key' : 'text-fg-subtle')} aria-hidden />{label}
          </span>
          <span className="text-caption text-fg-subtle">{hint}</span>
        </label>
      ))}
    </div>
  );
}

const stepNames = (t) => [t('portal.step1'), t('portal.step2'), t('portal.step3')];

// Where you are: three bars that fill as each step is reached, and the step's name (announced
// when it changes, since focus moves on to the step's first field).
function Steps({ step, t }) {
  const names = stepNames(t);
  return (
    <div className="mt-6">
      <p className="flex items-baseline justify-between gap-3 text-caption" aria-live="polite">
        <span className="font-medium text-fg">{names[step - 1]}</span>
        <span className="tabular-nums text-fg-subtle">{t('portal.stepOf', { n: step })}</span>
      </p>
      <ol className="mt-2 grid grid-cols-3 gap-1.5">
        {names.map((n, i) => (
          <li key={n} aria-current={i + 1 === step ? 'step' : undefined} className="h-1.5 overflow-hidden rounded-full bg-press">
            <span aria-hidden className={clsx('block h-full origin-left rounded-full bg-key transition-transform duration-(--dur-slow) ease-(--motion-out)', i + 1 <= step ? 'scale-x-100' : 'scale-x-0')} />
            <span className="sr-only">{n}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// The thank-you: a small window of glass set pane by pane in the team's colour (or Tessera's), the
// middle pane a tick, then the reference to keep and the private link to follow the report.
function Sent({ done, brand, t, onAnother }) {
  const trackPath = done.trackUrl ? new URL(done.trackUrl).pathname : null;
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const order = [0, 1, 2, 7, 8, 3, 6, 5, 4];
  return (
    <section className="rounded-panel bg-surface px-6 py-10 text-center shadow-raised sm:px-10">
      <div aria-hidden className="mx-auto mb-7 grid w-max grid-cols-3 gap-1.5">
        {Array.from({ length: 9 }, (_, i) => (i === 4 ? (
          <span key={i} className="ds-tile-set grid size-7 place-items-center rounded-shard ds-gradient text-on-gradient shadow-raised" style={{ animationDelay: '480ms' }}>
            <Check className="size-4" strokeWidth={3} />
          </span>
        ) : (
          <span
            key={i}
            className="ds-tile-set size-7 rounded-shard"
            style={{
              animationDelay: `${order[i] * 55}ms`,
              background: brand?.accent ? `color-mix(in oklab, var(--accent) ${34 + ((i * 23) % 50)}%, transparent)` : glassColour(i / 8),
            }}
          />
        )))}
      </div>
      <h1 ref={heading} tabIndex={-1} className="font-display text-h1 text-balance text-fg outline-none">{t('portal.thanks', { name: brand?.name })}</h1>
      <p className="mx-auto mt-3 max-w-md text-pretty text-small text-fg-muted">
        {t('portal.reference')} <KeyChip className="h-6 px-2 text-caption">{done.reference}</KeyChip>.
        {done.alreadyKnown ? ` ${t('portal.known')}` : ''}
        {done.willEmail ? ` ${t('portal.willEmail')}` : ''}
      </p>
      {trackPath && (
        <a href={trackPath} className="ds-focus group mx-auto mt-6 flex max-w-sm items-center gap-3 rounded-card border border-key-line bg-key-bg px-4 py-3 text-left transition-shadow duration-(--dur-fast) hover:shadow-lift">
          <span className="min-w-0 flex-1">
            <span className="block text-small font-semibold text-fg">{t('portal.follow')}</span>
            <span className="block text-caption text-fg-muted">{t('portal.followHint')}</span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-key transition-transform duration-(--dur-fast) group-hover:translate-x-0.5" aria-hidden />
        </a>
      )}
      <Button variant="ghost" className="mt-5" onClick={onAnother}>{t('portal.another')}</Button>
    </section>
  );
}

// Which step holds each field, so a refusal from the server opens the step that needs fixing.
const STEP_OF = { title: 1, type: 1, description: 2, errorText: 2, name: 3, email: 3 };

// The public bug-report page. No account needed; the link itself is the access. Three short steps
// (what happened, the details, how to reach you) over one form, so Enter moves on and the last
// step sends. The interface text follows the visitor's language (E11).
export default function PortalPage() {
  const { token } = useParams();
  const [t, lang, setLang] = usePublicLang();
  const { data, isLoading, error } = useQuery({ queryKey: ['portal-page', token], queryFn: () => api(`/portal/${token}`), retry: false });
  const [form, setForm] = useState({ title: '', description: '', type: 'bug', name: '', email: '', errorText: '', website: '' });
  const [step, setStep] = useState(1);
  const [moved, setMoved] = useState(false);
  const [captcha, setCaptcha] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [details, setDetails] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const brand = data?.brand ?? (data ? { name: data.project.name } : null);
  const pageTitle = brand ? t('portal.title', { name: brand.name }) : null;
  useEffect(() => { if (pageTitle) document.title = pageTitle; }, [pageTitle]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // Moving between steps puts focus on the step's first field (never on the first load).
  const go = (to) => { setMoved(true); setErrors({}); setStep(to); };
  const next = () => {
    if (step === 1 && form.title.trim().length < 3) { setErrors({ title: t('portal.titleNeeded') }); return; }
    go(step + 1);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (step < 3) { next(); return; }
    setBusy(true);
    setErrors({});
    const body = Object.fromEntries(Object.entries({ ...form, turnstileToken: captcha }).filter(([, v]) => v !== ''));
    try {
      setDone(await api(`/portal/${token}/reports`, { method: 'POST', body: { title: '', ...body } }));
    } catch (err) {
      const fields = err.fieldErrors();
      const first = Object.keys(fields).map((k) => STEP_OF[k]).filter(Boolean).sort()[0];
      if (first && first !== step) { setMoved(true); setStep(first); }
      setErrors(Object.keys(fields).length ? fields : { form: err.message });
    } finally { setBusy(false); }
  };
  const another = () => { setDone(null); setStep(1); setMoved(true); setForm((f) => ({ ...f, title: '', description: '', errorText: '' })); };

  return (
    <PublicFrame project={data?.project} brand={brand} t={t} lang={lang} setLang={setLang} hero={token}>
      {isLoading && <PublicSkeleton />}
      {error && <PublicGone title={t('portal.unavailable')} hint={t('portal.unavailableHint')} />}
      {data && (done ? (
        <Sent done={done} brand={brand} t={t} onAnother={another} />
      ) : (
        <form className="rounded-panel bg-surface p-5 shadow-raised sm:p-8" onSubmit={submit} noValidate aria-label={pageTitle}>
          <h1 className="font-display text-h1 text-balance text-fg">{pageTitle}</h1>
          {data.intro && <p className="mt-2 text-pretty text-body text-fg-muted">{data.intro}</p>}
          <Steps step={step} t={t} />

          <div key={step} className="ds-fade mt-5 space-y-5">
            {step === 1 && (
              <>
                <KindChoice value={form.type} onChange={(type) => setForm((f) => ({ ...f, type }))} t={t} />
                <Field label={t('portal.what')} error={errors.title}>
                  <Input value={form.title} onChange={set('title')} maxLength={200} placeholder={t('portal.whatPlaceholder')} autoFocus={moved} />
                </Field>
              </>
            )}

            {step === 2 && (
              <>
                <Field label={t('portal.details')} error={errors.description} hint={t('portal.detailsHint')}>
                  <Textarea rows={5} value={form.description} onChange={set('description')} maxLength={10000} autoFocus={moved} />
                  {/* The report-quality tips read English text, so they only show in English. */}
                  {form.type === 'bug' && lang === 'en' && <ReportQuality text={form.description} onInsert={(add) => setForm((f) => ({ ...f, description: f.description.trimEnd() + add }))} />}
                </Field>
                <div>
                  <button
                    type="button"
                    aria-expanded={details}
                    aria-controls="portal-error-text"
                    className="ds-focus -ml-1 flex items-center gap-1 rounded-tile px-1 py-0.5 text-caption font-medium text-fg-muted transition-colors duration-(--dur-fast) hover:text-fg"
                    onClick={() => setDetails((d) => !d)}
                  >
                    <ChevronDown className={clsx('size-3.5 transition-transform duration-(--dur-fast)', details && 'rotate-180')} aria-hidden />{t('portal.pasteError')}
                  </button>
                  {details && (
                    <Textarea id="portal-error-text" className="ds-drop mt-2 font-code text-caption" rows={5} value={form.errorText} onChange={set('errorText')} placeholder={t('portal.errorPlaceholder')} aria-label={t('portal.errorLabel')} />
                  )}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <p className="text-small text-fg-muted">{t('portal.reachHint')}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('portal.name')}><Input value={form.name} onChange={set('name')} maxLength={80} autoComplete="name" autoFocus={moved} /></Field>
                  <Field label={t('portal.email')} error={errors.email} hint={t('portal.emailHint')}><Input type="email" value={form.email} onChange={set('email')} autoComplete="email" /></Field>
                </div>
                <aside className="flex gap-3 rounded-card border border-line bg-sunken/60 p-3.5 text-caption text-fg-muted" aria-labelledby="portal-privacy">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-key" aria-hidden />
                  <div>
                    <h2 id="portal-privacy" className="font-semibold text-fg">{t('portal.privacyTitle')}</h2>
                    <p className="mt-0.5 text-pretty">{t('portal.privacy')}</p>
                  </div>
                </aside>
                {data.turnstileSiteKey && <Turnstile siteKey={data.turnstileSiteKey} onToken={setCaptcha} />}
              </>
            )}

            {/* A trap for bots: hidden from people and screen readers. */}
            <input type="text" name="website" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            {errors.form && (
              <p className="flex items-start gap-2 rounded-tile bg-danger/10 px-3 py-2 text-small text-danger" role="alert">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{errors.form}
              </p>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2 border-t border-line pt-5">
            {step > 1 && <Button variant="ghost" icon={ArrowLeft} onClick={() => go(step - 1)}>{t('portal.back')}</Button>}
            {step < 3 ? (
              <Button type="submit" variant="primary" size="lg" className="ml-auto min-w-36">{t('portal.next')}<ArrowRight className="size-4" aria-hidden /></Button>
            ) : (
              <Button type="submit" variant="primary" size="lg" loading={busy} className="ml-auto min-w-36" disabled={Boolean(data.turnstileSiteKey) && !captcha}>{t('portal.send')}</Button>
            )}
          </div>
        </form>
      ))}
    </PublicFrame>
  );
}
