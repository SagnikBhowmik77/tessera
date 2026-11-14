import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronDown, ChevronUp, FlaskConical, Network, ScrollText, ShieldCheck, Square, Video } from 'lucide-react';
import { api } from '../lib/api.js';
import { fileSize, formatDateTime, timeAgo } from '../lib/format.js';
import { Badge, Button, Modal, Spinner } from './ui.jsx';
import { EmptyNote } from '../ds/core.jsx';

// Debug files (E12): the log viewer, HAR analysis, screen recording, and CI test results.

const LEVEL_STYLE = {
  error: 'text-danger',
  warn: 'text-warning',
  info: 'text-fg',
  debug: 'text-fg-subtle',
};

function LogViewer({ path, onClose }) {
  const [level, setLevel] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [errIndex, setErrIndex] = useState(-1);
  const box = useRef(null);
  useEffect(() => { const t = setTimeout(() => setSearch(q), 250); return () => clearTimeout(t); }, [q]);
  const { data, error, isFetching } = useQuery({
    queryKey: ['log', path, level, search],
    queryFn: () => api(`${path}/log?${new URLSearchParams({ ...(level && { level }), ...(search && { q: search }) })}`),
    placeholderData: (p) => p,
  });
  const jump = (dir) => {
    if (!data?.errors.length) return;
    const next = (errIndex + dir + data.errors.length) % data.errors.length;
    setErrIndex(next);
    box.current?.querySelector(`[data-line="${data.errors[next]}"]`)?.scrollIntoView({ block: 'center' });
  };
  return (
    <Modal open wide title={data ? `Log: ${data.name}` : 'Log'} onClose={onClose}>
      {error && <p className="text-small text-danger">{error.message}</p>}
      {!data ? <Spinner className="text-fg-subtle" /> : (
        <div className="space-y-3 text-small">
          {data.secrets.length > 0 && (
            <p className="flex items-start gap-2 rounded-tile bg-warning/10 px-3 py-2 text-caption text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              This log seems to contain {data.secrets.map((s) => `${s.count} ${s.kind}`).join(', ')}. It is stored as it was uploaded; consider deleting it and uploading a cleaned copy.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Level">
              {[['', `All ${data.total}`], ...data.levels.map((l) => [l, `${l} ${data.counts[l]}`])].map(([k, label]) => (
                <Button key={k || 'all'} size="sm" variant={level === k ? 'primary' : 'ghost'} onClick={() => setLevel(k)} aria-pressed={level === k}>{label}</Button>
              ))}
            </div>
            <input className="input h-8 w-48" placeholder="Search the log" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the log" />
            {data.errors.length > 0 && !level && !search && (
              <span className="ml-auto flex items-center gap-1 text-caption text-fg-subtle">
                Error {errIndex + 1 || '–'} of {data.errors.length}
                <Button size="icon" variant="ghost" aria-label="Previous error" onClick={() => jump(-1)}><ChevronUp className="size-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Next error" onClick={() => jump(1)}><ChevronDown className="size-4" /></Button>
              </span>
            )}
            {isFetching && <Spinner className="text-fg-subtle" />}
          </div>
          {data.from && <p className="text-caption text-fg-subtle">From {formatDateTime(data.from)} to {formatDateTime(data.to)} (lines with a time zone).</p>}
          <div ref={box} className="max-h-[60vh] overflow-auto rounded-tile bg-sunken py-1 font-code text-micro leading-5">
            {data.lines.map((l) => (
              <div key={l.n} data-line={l.n} className={clsx('flex gap-3 px-2', LEVEL_STYLE[l.level] ?? 'text-fg-muted', data.errors[errIndex] === l.n && 'bg-danger/12')}>
                <span className="w-10 shrink-0 select-none text-right text-fg-subtle">{l.n}</span>
                <span className="whitespace-pre-wrap break-all">{l.text}</span>
              </div>
            ))}
            {!data.lines.length && <EmptyNote size="xs" className="px-3 py-2">No lines match.</EmptyNote>}
          </div>
          {data.matched > data.lines.length && <p className="text-caption text-fg-subtle">Showing the first {data.lines.length} of {data.matched} matching lines. Narrow it with a level or a search.</p>}
        </div>
      )}
    </Modal>
  );
}

const ms = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

function RequestRow({ r }) {
  return (
    <li className="flex gap-2 py-1 text-caption">
      <span className={clsx('w-10 shrink-0 font-code', r.status === 0 || r.status >= 400 ? 'text-danger' : 'text-fg-subtle')}>{r.status || 'ERR'}</span>
      <span className="w-12 shrink-0 font-code text-fg-subtle">{r.method}</span>
      <span className="min-w-0 flex-1 break-all">{r.url}</span>
      <span className="w-16 shrink-0 text-right tabular-nums">{ms(r.time)}</span>
      <span className="w-16 shrink-0 text-right tabular-nums text-fg-subtle">{fileSize(r.bytes)}</span>
    </li>
  );
}

function HarReport({ path, onClose }) {
  const { data, error } = useQuery({ queryKey: ['har', path], queryFn: () => api(`${path}/har`) });
  return (
    <Modal open wide title={data ? `Requests: ${data.name}` : 'Requests'} onClose={onClose}>
      {error && <p className="text-small text-danger">{error.message}</p>}
      {!data ? <Spinner className="text-fg-subtle" /> : (
        <div className="space-y-4 text-small">
          {data.cleaned && (
            <p className="flex items-start gap-2 rounded-tile bg-success/10 px-3 py-2 text-caption text-success">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Cleaned before it was saved: {data.cleaned.cookies} cookies, {data.cleaned.headers} sensitive headers, {data.cleaned.params} token or password fields,
              {' '}{data.cleaned.bodies} request or response bodies{data.cleaned.secrets ? `, ${data.cleaned.secrets} other secrets` : ''}.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[['Requests', data.requests], ['Failed', data.failed.length], ['Total time', ms(data.wallTime)], ['Downloaded', fileSize(data.totalBytes)]].map(([k, v]) => (
              <div key={k} className="rounded-tile border border-line p-2 "><p className="text-caption text-fg-subtle">{k}</p><p className="text-h3 font-semibold tabular-nums">{v}</p></div>
            ))}
          </div>
          {data.browser && <p className="text-caption text-fg-subtle">Recorded in {data.browser}{data.redirects ? ` · ${data.redirects} redirects` : ''}</p>}
          {data.failed.length > 0 && <section><h3 className="text-caption font-semibold uppercase text-danger">Failed</h3><ul>{data.failed.map((r, i) => <RequestRow key={i} r={r} />)}</ul></section>}
          <section><h3 className="text-caption font-semibold uppercase text-fg-subtle">Slowest</h3><ul>{data.slowest.map((r, i) => <RequestRow key={i} r={r} />)}</ul></section>
          {data.largest.length > 0 && <section><h3 className="text-caption font-semibold uppercase text-fg-subtle">Largest</h3><ul>{data.largest.map((r, i) => <RequestRow key={i} r={r} />)}</ul></section>}
          <section>
            <h3 className="text-caption font-semibold uppercase text-fg-subtle">By server</h3>
            <table className="mt-1 w-full text-caption">
              <thead className="text-left text-fg-subtle"><tr><th className="font-medium">Host</th><th className="text-right font-medium">Requests</th><th className="text-right font-medium">Failed</th><th className="text-right font-medium">Size</th></tr></thead>
              <tbody>{data.hosts.map((h) => <tr key={h.host}><td className="break-all py-0.5">{h.host}</td><td className="text-right tabular-nums">{h.requests}</td><td className="text-right tabular-nums">{h.failed}</td><td className="text-right tabular-nums">{fileSize(h.bytes)}</td></tr>)}</tbody>
            </table>
          </section>
        </div>
      )}
    </Modal>
  );
}

// Buttons under an attachment: read a log, look into a HAR.
export function FileActions({ a, path }) {
  const [open, setOpen] = useState(null);
  const har = a.name.toLowerCase().endsWith('.har');
  const log = !har && (a.contentType.startsWith('text/') || a.contentType === 'application/json');
  if (!har && !log) return null;
  return (
    <div className="flex items-center gap-1 border-t border-line px-1.5 py-1 ">
      {log && <Button size="sm" variant="ghost" onClick={() => setOpen('log')}><ScrollText className="size-3.5" />Read</Button>}
      {har && <Button size="sm" variant="ghost" onClick={() => setOpen('har')}><Network className="size-3.5" />Requests</Button>}
      {har && a.cleaned && <ShieldCheck className="ml-auto size-3.5 text-success" aria-label="Cleaned before saving" />}
      {open === 'log' && <LogViewer path={path} onClose={() => setOpen(null)} />}
      {open === 'har' && <HarReport path={path} onClose={() => setOpen(null)} />}
    </div>
  );
}

// Screen recording: up to 60 seconds of one screen, window or tab, no sound, kept under 9 MB
// (attachments are at most 10 MB, and the free database is small). Nothing leaves the browser
// until the person has watched it and chosen to attach it.
const MAX_SECONDS = 60;
const MAX_BYTES = 9 * 1024 * 1024;
export function ScreenRecorder({ onRecorded }) {
  const [state, setState] = useState('idle');
  const [seconds, setSeconds] = useState(0);
  const [result, setResult] = useState(null);
  const rec = useRef(null);
  const supported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined';
  useEffect(() => () => { rec.current?.stream.getTracks().forEach((tr) => tr.stop()); }, []);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  if (!supported) return null;

  const start = async () => {
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); } catch { return; }
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((x) => MediaRecorder.isTypeSupported(x));
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_000_000 });
    const chunks = [];
    let size = 0;
    let stopReason = null;
    const began = Date.now();
    const tick = setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS && recorder.state === 'recording') { stopReason = `Stopped at the ${MAX_SECONDS}-second limit.`; recorder.stop(); }
    }, 250);
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      size += e.data.size;
      if (size > MAX_BYTES && recorder.state === 'recording') { stopReason = 'Stopped at the 9 MB size limit.'; recorder.stop(); }
    };
    recorder.onstop = () => {
      clearInterval(tick);
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      setResult({ blob, url: URL.createObjectURL(blob), seconds: Math.round((Date.now() - began) / 1000), note: stopReason });
      setState('review');
    };
    // Stopping the share from the browser's own bar ends the recording too.
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (recorder.state === 'recording') recorder.stop(); });
    recorder.start(1000);
    rec.current = { recorder, stream };
    setSeconds(0);
    setState('recording');
  };
  const stop = () => { if (rec.current?.recorder.state === 'recording') rec.current.recorder.stop(); };
  const discard = () => { setResult(null); setState('idle'); };
  const attach = () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    onRecorded(new File([result.blob], `recording-${stamp}.webm`, { type: 'video/webm' }));
    discard();
  };

  return (
    <>
      {state === 'recording' ? (
        <Button size="sm" variant="primary" onClick={stop}><Square className="size-3.5" />Stop {seconds}s / {MAX_SECONDS}s</Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={start} title={`Record your screen (up to ${MAX_SECONDS} seconds, no sound)`}><Video className="size-3.5" />Record</Button>
      )}
      <Modal open={state === 'review' && Boolean(result)} wide title="Attach this recording?" onClose={discard}
        footer={<><Button onClick={discard}>Discard</Button><Button variant="primary" onClick={attach}>Attach</Button></>}>
        {result && (
          <div className="space-y-2 text-small">
            <video src={result.url} controls className="max-h-[50vh] w-full rounded-tile bg-black" />
            <p className="text-caption text-fg-subtle">{result.seconds} seconds, {fileSize(result.blob.size)}. {result.note ?? ''} Check it shows nothing private before attaching: everyone on the project can watch it.</p>
          </div>
        )}
      </Modal>
    </>
  );
}

function TestRow({ x, kind, pid, canWork, onTicket }) {
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{x.name}</span>
        {x.suite && <span className="text-caption text-fg-subtle">{x.suite}</span>}
        <Badge tone={kind === 'flaky' ? 'amber' : 'red'}>{kind === 'flaky' ? `${x.failRate}% failing, ${x.flips} flips` : `failing ${x.failingFor} runs in a row`}</Badge>
        {x.sameCommit && <Badge tone="amber">passed and failed on one commit</Badge>}
        <span className="ml-auto">
          {x.ticket ? <Link to={`/projects/${pid}/tickets/${x.ticket}`} className="font-code text-caption underline">{x.ticket}</Link>
            : canWork && <Button size="sm" onClick={() => onTicket(x.key)}>Make a ticket</Button>}
        </span>
      </div>
      {x.lastFailure?.message && <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-hair bg-sunken p-2 text-micro">{x.lastFailure.message}</pre>}
    </li>
  );
}

// CI test results on the Deploys page: flaky and failing tests from JUnit reports.
export function TestsPanel({ project }) {
  const qc = useQueryClient();
  const pid = project.id;
  const { data } = useQuery({ queryKey: ['tests', pid], queryFn: () => api(`/projects/${pid}/tests`) });
  const file = useRef(null);
  const [busy, setBusy] = useState(false);
  const canWork = ['admin', 'manager', 'developer'].includes(project.myRole) && !project.archivedAt;
  const refresh = () => qc.invalidateQueries({ queryKey: ['tests', pid] });
  const upload = async (f) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      const { run } = await api(`/projects/${pid}/tests`, { method: 'POST', form });
      toast.success(`Imported ${run.totals.tests} tests (${run.totals.failed} failed)`);
      refresh();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const makeTicket = async (key) => {
    try { const r = await api(`/projects/${pid}/tests/ticket`, { method: 'POST', body: { key } }); toast.success(`Created ${r.key}`); refresh(); } catch (e) { toast.error(e.message); }
  };
  const row = { pid, canWork, onTicket: makeTicket };
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-small font-semibold"><FlaskConical className="size-4" aria-hidden />CI tests</h2>
        {data && <span className="text-caption text-fg-subtle">last {data.window} run{data.window === 1 ? '' : 's'}</span>}
        {canWork && (
          <span className="ml-auto">
            <Button size="sm" loading={busy} onClick={() => file.current.click()}>Upload JUnit XML</Button>
            <input ref={file} type="file" accept=".xml,text/xml,application/xml" hidden onChange={(e) => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; }} />
          </span>
        )}
      </div>
      {!data ? <Spinner className="text-fg-subtle" /> : !data.window ? (
        <EmptyNote>No test runs yet. Upload a JUnit XML report, or send one from CI with an upload token (the command is under Deploy settings).</EmptyNote>
      ) : (
        <>
          <div>
            <h3 className="text-caption font-semibold uppercase text-fg-subtle">Flaky ({data.flaky.length})</h3>
            {!data.flaky.length ? <EmptyNote>No test both passed and failed in these runs.</EmptyNote> : <ul className="divide-y divide-line text-small ">{data.flaky.map((x) => <TestRow key={x.key} x={x} kind="flaky" {...row} />)}</ul>}
          </div>
          {data.broken.length > 0 && (
            <div>
              <h3 className="text-caption font-semibold uppercase text-danger">Failing ({data.broken.length})</h3>
              <ul className="divide-y divide-line text-small ">{data.broken.map((x) => <TestRow key={x.key} x={x} kind="broken" {...row} />)}</ul>
            </div>
          )}
          <div>
            <h3 className="text-caption font-semibold uppercase text-fg-subtle">Recent runs</h3>
            <ul className="text-caption">
              {data.runs.slice(0, 10).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 py-1">
                  <Badge tone={r.totals.failed ? 'red' : 'teal'}>{r.totals.failed ? `${r.totals.failed} failed` : 'passed'}</Badge>
                  <span>{r.totals.tests} tests</span>
                  {r.name && <span className="text-fg-subtle">{r.name}</span>}
                  {r.branch && <span className="font-code text-fg-subtle">{r.branch}</span>}
                  {r.commit && <span className="font-code text-fg-subtle">{r.commit.slice(0, 7)}</span>}
                  <span className="ml-auto text-fg-subtle" title={formatDateTime(r.at)}>{timeAgo(r.at)} · {r.source === 'ci' ? 'CI' : 'uploaded'}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
