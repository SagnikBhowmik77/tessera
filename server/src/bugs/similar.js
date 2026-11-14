// "This looks like TES-12": finds existing tickets that read like the one being written.
// Plain TF-IDF with cosine similarity, computed on the server from the project's own
// tickets. No AI service, no external calls, and the shared words explain each match.

const STOPWORDS = new Set(`a an and are as at be but by can cannot could did do does doesnt dont for from has have
how i if in into is it its just me my no not of on or our please should so some still than that the their them
then there these they this to too up us was we were what when where which while who why will with would you your
after before again also any get gets got here only very via vs`.split(/\s+/));

// A light stemmer: "crashes", "crashed", "crashing" -> "crash".
function stem(w) {
  if (w.length <= 4) return w;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) return w.slice(0, -suffix.length);
  }
  return w;
}

export function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

// Titles say the most, labels next, the description adds context.
const docTerms = ({ title, labels = [], description = '' }) => [
  ...tokenize(title), ...tokenize(title), ...tokenize(title),
  ...labels.flatMap((l) => tokenize(l)), ...labels.flatMap((l) => tokenize(l)),
  ...tokenize(String(description).slice(0, 1000)),
];

const counts = (terms) => terms.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());

// tickets: [{ number, title, labels, description, ... }]; query: { title, description, labels }.
// Returns the best matches above `min`, each with a 0-1 score and the words they share.
export function rankSimilar(tickets, query, { limit = 5, min = 0.2 } = {}) {
  const docs = tickets.map((t) => ({ ticket: t, tf: counts(docTerms(t)) }));
  const q = counts(docTerms(query));
  if (!q.size || !docs.length) return [];

  const df = new Map();
  for (const d of docs) for (const term of d.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  const n = docs.length + 1;
  const idf = (term) => Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
  const vector = (tf) => {
    const v = new Map();
    for (const [term, c] of tf) v.set(term, (1 + Math.log(c)) * idf(term));
    return v;
  };
  const norm = (v) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;

  const qv = vector(q);
  const qn = norm(qv);
  const scored = docs.map((d) => {
    const dv = vector(d.tf);
    let dot = 0;
    const shared = [];
    for (const [term, w] of qv) {
      const x = dv.get(term);
      if (x) { dot += w * x; shared.push([term, w * x]); }
    }
    const score = dot / (qn * norm(dv));
    const because = shared.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([term]) => term);
    return { ticket: d.ticket, score: Math.round(score * 100) / 100, because };
  });
  return scored.filter((s) => s.score >= min).sort((a, b) => b.score - a.score).slice(0, limit);
}
