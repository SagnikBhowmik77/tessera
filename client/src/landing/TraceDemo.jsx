import { useDeferredValue, useId, useMemo, useState } from 'react';
import clsx from 'clsx';
import { CircleCheck, Fingerprint, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react';
// The server's own modules, unchanged: the same redaction and parser the API runs on every paste.
import { redactSecrets } from '../../../server/src/bugs/redact.js';
import { parseError } from '../../../server/src/bugs/stacktrace.js';
import { Badge, Button, TypeMark } from '../ds/core.jsx';
import DemoFrame, { Segmented } from './DemoFrame.jsx';
import { TRACES, nextBuild } from './samples.js';

const LANGUAGE = { javascript: 'JavaScript', python: 'Python', java: 'Java', dotnet: '.NET', go: 'Go', php: 'PHP', ruby: 'Ruby', rust: 'Rust', unknown: 'Not recognised' };
const short = (file) => String(file ?? '').split(/[\\/]/).pop();

function analyse(text) {
  const { text: clean, removed } = redactSecrets(text);
  const error = parseError(clean);
  const headline = [error.type, error.message].filter(Boolean).join(': ') || 'Error';
  return { error, removed, title: headline.length > 120 ? `${headline.slice(0, 117)}…` : headline };
}

export default function TraceDemo() {
  const id = useId();
  const [sample, setSample] = useState(TRACES[0].id);
  const [text, setText] = useState(TRACES[0].text);
  // The fingerprint of the crash as first pasted: a later paste with the same one joins its ticket.
  const [first, setFirst] = useState(() => analyse(TRACES[0].text).error.fingerprint);
  const deferred = useDeferredValue(text);
  const { error, removed, title } = useMemo(() => analyse(deferred), [deferred]);

  const pick = (value) => {
    const t = TRACES.find((x) => x.id === value);
    setSample(value);
    setText(t.text);
    setFirst(analyse(t.text).error.fingerprint);
  };
  const same = error.fingerprint === first;
  const frames = error.frames.slice(0, 6);

  return (
    <DemoFrame title="Paste a stack trace, get a bug" source="server/src/bugs/stacktrace.js" sourceNote="redact.js, the same parser and redaction the API runs on every paste">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented label="Sample error" options={TRACES.map((t) => ({ value: t.id, label: t.label }))} value={sample} onChange={pick} />
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => pick(sample)}>Reset</Button>
          </div>
          <label htmlFor={`${id}-text`} className="block text-caption font-medium text-fg-muted">Error as pasted (edit it: the result follows)</label>
          <textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={11}
            className="ds-focus ds-scroll block w-full resize-y whitespace-pre rounded-tile border border-line bg-field px-3 py-2 font-mono text-micro leading-relaxed text-fg"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={Sparkles} onClick={() => setText(nextBuild(text))}>Paste it again from the next build</Button>
            <span className="text-caption text-fg-subtle">Every line number moves; it is still the same crash.</span>
          </div>
        </div>

        <div className="min-w-0 space-y-4" aria-live="polite">
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><ShieldCheck className="size-3.5" aria-hidden />Removed before saving</h4>
            {removed.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {removed.map((r) => <li key={r.kind}><Badge tone="success">{r.kind}{r.count > 1 ? ` × ${r.count}` : ''}</Badge></li>)}
              </ul>
            ) : <p className="text-caption text-fg-subtle">Nothing that looks like a secret.</p>}
          </section>

          <section className="rounded-card border border-line bg-raised p-3">
            <div className="flex items-start gap-2">
              <TypeMark type="bug" className="mt-0.5" />
              <p className="min-w-0 flex-1 break-words text-small font-medium text-fg">{title}</p>
            </div>
            <p className="mt-1.5 pl-6 text-caption text-fg-subtle">
              {LANGUAGE[error.language] ?? error.language}
              {error.causes.length > 0 && <> · caused by <span className="font-mono text-fg-muted">{error.causes.map((c) => c.type).join(' → ')}</span></>}
            </p>
            {frames.length > 0 && (
              <ol className="mt-3 space-y-1 pl-6" aria-label="Stack frames, newest first">
                {frames.map((f, i) => (
                  <li key={`${i}-${f.fn}-${f.line}`} className={clsx('flex min-w-0 items-center gap-2 text-caption', f.inApp ? 'text-fg' : 'text-fg-subtle')}>
                    <Badge tone={f.inApp ? 'accent' : 'neutral'} className="w-[4.75rem] justify-center">{f.inApp ? 'your code' : 'library'}</Badge>
                    <span className="min-w-0 truncate font-mono text-micro" title={`${f.fn ?? '?'} ${f.file ?? ''}:${f.line ?? ''}`}>
                      {(f.fn ?? '?').split('.').slice(-2).join('.')} <span className="text-fg-subtle">{short(f.file)}{f.line ? `:${f.line}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Fingerprint className="size-3.5" aria-hidden />Fingerprint</h4>
            <p className="flex flex-wrap items-center gap-2 text-caption">
              <code className="rounded-hair bg-hover px-1.5 py-0.5 font-mono text-micro text-fg-muted">{error.fingerprint.slice(0, 12)}</code>
              {same
                ? <span className="inline-flex items-center gap-1 font-medium text-success"><CircleCheck className="size-3.5" aria-hidden />Same crash: counted on the ticket it already has</span>
                : <span className="font-medium text-info">A different crash: this would be a new ticket</span>}
            </p>
            <p className="mt-1 text-caption text-fg-subtle">Made from the language, the error type and the top frames of your own code, without line numbers.</p>
          </section>
        </div>
      </div>
    </DemoFrame>
  );
}
