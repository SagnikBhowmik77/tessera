// JUnit XML (E12): the test-report format nearly every runner can write (node --test with the
// junit reporter, Vitest, Jest via jest-junit, pytest --junitxml, Go via go-junit-report, Gradle,
// Maven). A small reader for just this format: elements, attributes, text, CDATA and entities.

export class JUnitError extends Error {}

const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }
  return ENTITY[e.toLowerCase()] ?? m;
});

// A tree of { name, attrs, children, text }. Anything that is not a well-formed tag is refused.
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  while (TOKEN.lastIndex < xml.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(xml);
    if (!m) throw new JUnitError(`The XML is broken at character ${at}`);
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (top.name !== m[2]) throw new JUnitError(`The XML is broken near </${m[2]}>`);
      stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new JUnitError(`The XML ends before </${stack.at(-1).name}>`);
  return root;
}

const millis = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null; };

// Returns { cases: [{ key, suite, name, status, duration, message }], totals }.
export function parseJUnit(xml) {
  if (typeof xml !== 'string' || !xml.trimStart().startsWith('<')) throw new JUnitError('This is not an XML file');
  const root = parseXml(xml.replace(/^﻿/, ''));
  const cases = [];
  const walk = (el, suite) => {
    for (const child of el.children) {
      if (child.name === 'testsuite' || child.name === 'testsuites') walk(child, child.attrs.name || suite);
      else if (child.name === 'testcase') {
        const name = child.attrs.name ?? '(unnamed)';
        const group = child.attrs.classname || suite || '';
        const bad = child.children.find((c) => c.name === 'failure' || c.name === 'error');
        const skipped = child.children.some((c) => c.name === 'skipped');
        const message = bad ? [bad.attrs.message, bad.text.trim()].filter(Boolean).join('\n').slice(0, 2000) : null;
        cases.push({
          key: `${group}::${name}`.slice(0, 500), suite: group.slice(0, 300), name: name.slice(0, 300),
          status: bad ? 'failed' : skipped ? 'skipped' : 'passed', duration: millis(child.attrs.time), message,
        });
      }
    }
  };
  walk(root, '');
  if (!cases.length) throw new JUnitError('No <testcase> found. Upload a JUnit XML test report.');
  const totals = {
    tests: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    duration: cases.reduce((n, c) => n + (c.duration ?? 0), 0),
  };
  return { cases, totals };
}
