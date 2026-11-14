import { HttpError } from '../errors.js';
import { TestRun, Ticket } from '../models/index.js';
import { redactSecrets } from '../bugs/redact.js';
import { analyzeHar } from '../debug/har.js';
import { JUnitError, parseJUnit } from '../debug/junit.js';
import { LEVELS, parseLog } from '../debug/logparse.js';
import { readAttachment } from './attachment.service.js';
import { roleAtLeast } from './project.service.js';
import { createTicket, ticketKey } from './ticket.service.js';

// Debug files (E12): the log viewer, HAR analysis, and CI test results with flaky-test detection.

const isText = (a) => a.contentType.startsWith('text/') || (a.contentType === 'application/json' && !a.name.toLowerCase().endsWith('.har'));

// ---------- logs ----------

export async function logView(ticket, attachmentId, { level = null, q = '', offset = 0, limit = 1000 }) {
  const { attachment, buffer } = await readAttachment(ticket, attachmentId);
  if (!isText(attachment)) throw new HttpError(415, 'not_a_log', 'Only text files (.log, .txt, .json) open in the log viewer');
  const content = buffer.toString('utf8');
  const { lines, counts, from, to } = parseLog(content);
  const needle = q.trim().toLowerCase();
  const matched = lines.filter((l) => (!level || l.level === level) && (!needle || l.text.toLowerCase().includes(needle)));
  // Where each error starts, for "next error" jumps.
  const errors = lines.filter((l) => l.level === 'error' && !l.continuation).map((l) => l.n);
  // Logs are stored as uploaded; say so when they seem to contain secrets.
  const secrets = redactSecrets(content).removed;
  return {
    name: attachment.name, total: lines.length, counts, from, to, levels: LEVELS, errors,
    matched: matched.length, offset, lines: matched.slice(offset, offset + limit), secrets,
  };
}

// ---------- HAR ----------

export async function harView(ticket, attachmentId) {
  const { attachment, buffer } = await readAttachment(ticket, attachmentId);
  if (!attachment.name.toLowerCase().endsWith('.har')) throw new HttpError(415, 'not_a_har', 'This is not a .har file');
  let har;
  try { har = JSON.parse(buffer.toString('utf8')); } catch { throw new HttpError(422, 'bad_har', 'This .har file could not be read'); }
  if (!Array.isArray(har?.log?.entries)) throw new HttpError(422, 'bad_har', 'This .har file has no requests');
  return { name: attachment.name, cleaned: attachment.cleaned ?? null, ...analyzeHar(har) };
}

// ---------- test runs ----------

const KEEP_RUNS = 200;
const runJson = (r) => ({ id: String(r._id), name: r.name, branch: r.branch, commit: r.commit, source: r.source, at: r.at, totals: r.totals });

export async function importTestRun(project, { xml, branch = null, commit = null, name = null, source, user = null }) {
  let parsed;
  try { parsed = parseJUnit(xml); } catch (e) {
    if (e instanceof JUnitError) throw new HttpError(422, 'bad_junit', e.message);
    throw e;
  }
  if (parsed.cases.length > 5000) throw new HttpError(413, 'too_many_tests', 'At most 5,000 test cases per run');
  const run = await TestRun.create({ project: project._id, name, branch, commit, source, uploadedBy: user?._id ?? null, at: new Date(), totals: parsed.totals, cases: parsed.cases });
  const old = await TestRun.find({ project: project._id }, { _id: 1 }).sort({ at: -1 }).skip(KEEP_RUNS).lean();
  if (old.length) await TestRun.deleteMany({ _id: { $in: old.map((r) => r._id) } });
  return runJson(run);
}

export async function deleteTestRun(project, runId) {
  const r = await TestRun.deleteOne({ _id: runId, project: project._id });
  if (!r.deletedCount) throw new HttpError(404, 'run_not_found', 'That test run is not in this project');
}

// Flaky: both passed and failed in the window, and either disagreed with itself on the same commit
// (a retry passed what had just failed) or flipped between pass and fail at least twice.
// Broken: failed in at least the last two runs with no pass in between.
export async function testReport(project, { runs = 30 } = {}) {
  const rows = (await TestRun.find({ project: project._id }).sort({ at: -1 }).limit(runs).lean()).reverse();
  const byKey = new Map();
  for (const run of rows) {
    for (const c of run.cases) {
      if (c.status === 'skipped') continue;
      const list = byKey.get(c.key) ?? [];
      list.push({ status: c.status, commit: run.commit, at: run.at, message: c.message, duration: c.duration, suite: c.suite, name: c.name, branch: run.branch });
      byKey.set(c.key, list);
    }
  }
  const flaky = [];
  const broken = [];
  const timing = [];
  for (const [key, list] of byKey) {
    const fails = list.filter((r) => r.status === 'failed');
    const passes = list.length - fails.length;
    let flips = 0;
    for (let i = 1; i < list.length; i += 1) if (list[i].status !== list[i - 1].status) flips += 1;
    const commits = new Map();
    for (const r of list) if (r.commit) commits.set(r.commit, new Set([...(commits.get(r.commit) ?? []), r.status]));
    const sameCommit = [...commits.values()].some((s) => s.size === 2);
    let trailing = 0;
    for (let i = list.length - 1; i >= 0 && list[i].status === 'failed'; i -= 1) trailing += 1;
    const last = list.at(-1);
    const lastFail = fails.at(-1);
    const base = {
      key, suite: last.suite, name: last.name, runs: list.length, failures: fails.length,
      failRate: Math.round((fails.length / list.length) * 100), flips, sameCommit,
      lastFailure: lastFail ? { at: lastFail.at, commit: lastFail.commit, branch: lastFail.branch, message: lastFail.message } : null,
    };
    if (fails.length && passes && (sameCommit || flips >= 2)) flaky.push(base);
    else if (trailing >= 2) broken.push({ ...base, failingFor: trailing });
    const durations = list.map((r) => r.duration).filter((d) => d != null);
    if (durations.length) timing.push({ key, suite: last.suite, name: last.name, avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) });
  }
  const tickets = await Ticket.find({ project: project._id, testKey: { $in: [...flaky, ...broken].map((f) => f.key) }, deletedAt: null }, { number: 1, testKey: 1 }).lean();
  const ticketOf = new Map(tickets.map((t) => [t.testKey, ticketKey(project, t.number)]));
  const withTicket = (x) => ({ ...x, ticket: ticketOf.get(x.key) ?? null });
  return {
    window: rows.length,
    runs: [...rows].reverse().map(runJson),
    flaky: flaky.sort((a, b) => b.failRate - a.failRate || b.flips - a.flips).map(withTicket),
    broken: broken.sort((a, b) => b.failingFor - a.failingFor).map(withTicket),
    slowest: timing.sort((a, b) => b.avg - a.avg).slice(0, 10),
  };
}

// A ticket for a flaky or failing test, with what the runs showed. One per test.
export async function ticketFromTest(project, membership, user, key) {
  if (!roleAtLeast(membership.role, 'developer')) throw new HttpError(403, 'forbidden', 'Only people who work on tickets can do this');
  const report = await testReport(project, { runs: 50 });
  const isFlaky = report.flaky.some((t) => t.key === key);
  const test = [...report.flaky, ...report.broken].find((t) => t.key === key);
  if (!test) throw new HttpError(404, 'test_not_found', 'That test is not flaky or failing in the recent runs');
  if (test.ticket) throw new HttpError(409, 'already_ticket', `This test already has a ticket: ${test.ticket}`);
  const lines = [
    `**${isFlaky ? 'Flaky' : 'Failing'} test** \`${test.suite ? `${test.suite} › ` : ''}${test.name}\``,
    '',
    `- Failed ${test.failures} of the last ${test.runs} runs (${test.failRate}%), switching between pass and fail ${test.flips} time${test.flips === 1 ? '' : 's'}.`,
    ...(test.sameCommit ? ['- It both passed and failed on the same commit, so the code alone does not decide the result.'] : []),
    ...(test.lastFailure ? [`- Last failure: ${new Date(test.lastFailure.at).toISOString().slice(0, 16).replace('T', ' ')} UTC${test.lastFailure.commit ? ` on ${test.lastFailure.commit.slice(0, 7)}` : ''}${test.lastFailure.branch ? ` (${test.lastFailure.branch})` : ''}.`] : []),
    ...(test.lastFailure?.message ? ['', '```', test.lastFailure.message.slice(0, 1500), '```'] : []),
  ];
  const { ticket } = await createTicket(project, user, {
    title: `${isFlaky ? 'Flaky' : 'Failing'} test: ${test.name}`.slice(0, 200), description: lines.join('\n'), type: 'bug',
    priority: isFlaky ? 'medium' : 'high', labels: [isFlaky ? 'flaky-test' : 'failing-test'],
  }, { quiet: true });
  await Ticket.updateOne({ _id: ticket.id }, { $set: { testKey: key } });
  return { key: ticket.key };
}
