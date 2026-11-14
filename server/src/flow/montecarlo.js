// The Monte Carlo forecast, with nothing but arithmetic: no database, no Node APIs. The Flow tab
// runs it on the server against a project's real history, and the landing page's demo imports
// this same file into the browser, so the demo can't drift from what the product does.

// Fewer finished tickets than this in the history and there is no forecast, only the reason.
export const MIN_FINISHED = 5;

// p-th percentile of an already sorted list (nearest rank).
export const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

// Seeded random numbers, so the same history always gives the same forecast.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// runs = 10,000 simulated futures, each day drawing one of the real past days.
export function monteCarlo({ samples, items = null, days = null, factor = 1, runs = 10_000, seed = 42 }) {
  const rand = mulberry32(seed);
  const draw = () => samples[Math.floor(rand() * samples.length)] * factor;
  const out = {};
  if (items !== null) {
    const needed = [];
    for (let r = 0; r < runs; r += 1) {
      let left = items;
      let d = 0;
      while (left > 0 && d < 3650) { left -= draw(); d += 1; }
      needed.push(d);
    }
    needed.sort((a, b) => a - b);
    out.whenDone = { p50: pct(needed, 50), p85: pct(needed, 85), p95: pct(needed, 95) };
  }
  if (days !== null) {
    const finished = [];
    for (let r = 0; r < runs; r += 1) {
      let n = 0;
      for (let d = 0; d < days; d += 1) n += draw();
      finished.push(Math.floor(n));
    }
    finished.sort((a, b) => a - b);
    // "At least this many" with 50/85/95% confidence: the low end of the outcomes.
    out.howMany = { p50: pct(finished, 50), p85: pct(finished, 15), p95: pct(finished, 5) };
  }
  return out;
}
