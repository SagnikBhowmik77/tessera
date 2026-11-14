import { Check, ListChecks } from 'lucide-react';

// What a useful bug report has. Plain rules on the text (no AI): each one looks for the words
// people actually use, in English, and a numbered or bulleted list counts as steps.
const CHECKS = [
  {
    key: 'steps',
    label: 'Steps to reproduce',
    test: (t) => /\b(steps?|reproduce|repro|to recreate)\b/i.test(t) || (t.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm)?.length ?? 0) >= 2,
  },
  {
    key: 'expected',
    label: 'What you expected',
    test: (t) => /\b(expect(ed|ing)?|should( have)?|supposed to|instead of|meant to)\b/i.test(t),
  },
  {
    key: 'environment',
    label: 'Where it happened (browser, device or version)',
    test: (t) => /\b(chrome|firefox|safari|edge|opera|brave|browser|ios|android|windows|mac ?os|macos|linux|ubuntu|iphone|ipad|pixel|samsung|device|version|staging|production|prod|localhost|node|python|java)\b/i.test(t)
      || /\bv?\d+\.\d+(\.\d+)?\b/.test(t),
  },
];

const TEMPLATE = {
  steps: '**Steps to reproduce**\n1. \n2. \n',
  expected: '**Expected**\n\n**What happened instead**\n',
  environment: '**Environment**\nBrowser / device / app version: \n',
};

// The headings inserted below don't count as content: only what is written under them does.
const withoutTemplate = (text) => String(text ?? '')
  .replace(/^\*\*(Steps to reproduce|Expected|What happened instead|Environment)\*\*[ \t]*$/gim, '')
  .replace(/^Browser \/ device \/ app version:/gim, '')
  .replace(/^[ \t]*\d+[.)][ \t]*$/gm, '');

export function missingParts(text) {
  const t = withoutTemplate(text);
  return CHECKS.filter((c) => !c.test(t));
}

// The checklist shown under a bug's description while it is written. Never blocks sending.
export default function ReportQuality({ text, onInsert }) {
  if (!String(text ?? '').trim()) return null;
  const missing = new Set(missingParts(text).map((c) => c.key));
  // Headings already inserted for these parts: point at them instead of offering them again.
  const t = String(text);
  const hasHeading = { steps: /\*\*Steps to reproduce\*\*/.test(t), expected: /\*\*Expected\*\*/.test(t), environment: /\*\*Environment\*\*/.test(t) };
  const toAdd = [...missing].filter((k) => !hasHeading[k]);
  if (missing.size === 0) {
    return <p className="mt-1.5 flex items-center gap-1.5 text-caption text-success"><Check className="size-3.5" aria-hidden />Steps, expected result and environment are all there.</p>;
  }
  const add = () => onInsert(`\n\n${toAdd.map((k) => TEMPLATE[k]).join('\n')}`);
  return (
    <div className="mt-2 rounded-tile bg-sunken px-3 py-2.5 text-caption" role="status">
      <p className="flex items-center gap-1.5 font-medium text-fg-muted"><ListChecks className="size-3.5" aria-hidden />A bug is fixed faster with:</p>
      <ul className="mt-1 space-y-0.5">
        {CHECKS.map((c) => (
          <li key={c.key} className={missing.has(c.key) ? 'text-fg' : 'text-fg-subtle line-through'}>
            <span aria-hidden className={missing.has(c.key) ? 'text-warning' : 'text-success'}>{missing.has(c.key) ? '○' : '●'}</span> {c.label}
          </li>
        ))}
      </ul>
      {toAdd.length > 0 ? (
        <button type="button" onClick={add} className="ds-focus mt-2 rounded-hair font-semibold text-accent underline underline-offset-2">
          Add headings for the missing parts
        </button>
      ) : <p className="mt-2 text-fg-subtle">Fill in the headings above.</p>}
    </div>
  );
}
