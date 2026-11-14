import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, CircleSlash, Code2, Copy, FileCode2, FileUp, FlaskConical, KeyRound, Trash2, Upload, Wand2 } from 'lucide-react';
import clsx from 'clsx';
import { copyText } from '../lib/clipboard.js';
import { api } from '../lib/api.js';
import { qk } from '../lib/queries.js';
import { fileSize, roleAtLeast, timeAgo } from '../lib/format.js';
import { Badge, Button, Spinner } from './ui.jsx';
import { SettingsSection as Section } from './SettingsSection.jsx';
import { ask } from './confirm.jsx';
import { EmptyNote } from '../ds/core.jsx';

// E5B: reproduction tracking in the ticket drawer, and where the code lives (Settings).

const STATUS = {
  reproduced: { tone: 'red', label: 'Reproduced' },
  not_reproduced: { tone: 'amber', label: 'Not reproduced yet' },
  unknown: { tone: 'zinc', label: 'Nobody has tried yet' },
};

export function ReproPanel({ project, ticket, canWork, userId }) {
  const qc = useQueryClient();
  const pid = project.id;
  const key = ['repro', pid, String(ticket.number), ticket.updatedAt];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api(`/projects/${pid}/tickets/${ticket.number}/repro`).then((d) => d.repro) });
  const [steps, setSteps] = useState('');
  const [editing, setEditing] = useState(false);
  const [environment, setEnvironment] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (!editing) setSteps(data?.steps ?? ''); }, [data?.steps, editing]);

  const done = (repro) => {
    qc.setQueryData(key, repro);
    qc.invalidateQueries({ queryKey: qk.ticket(pid, ticket.number) });
    qc.invalidateQueries({ queryKey: qk.history(pid, ticket.number) });
  };
  const call = (path, method, body) => api(`/projects/${pid}/tickets/${ticket.number}/repro${path}`, { method, body }).then((d) => d.repro);
  const saveSteps = useMutation({ mutationFn: () => call('/steps', 'PUT', { steps }), onSuccess: (r) => { setEditing(false); done(r); }, onError: (e) => toast.error(e.message) });
  const record = useMutation({
    mutationFn: (result) => call('/attempts', 'POST', { result, ...(environment.trim() && { environment: environment.trim() }), ...(note.trim() && { note: note.trim() }) }),
    onSuccess: (r) => { setNote(''); done(r); },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (id) => call(`/attempts/${id}`, 'DELETE'), onSuccess: done, onError: (e) => toast.error(e.message) });

  if (isLoading || !data) return <section><Spinner className="text-fg-subtle" /></section>;
  const s = data.summary;
  const isManager = roleAtLeast(project.myRole, 'manager');
  return (
    <section className="border-t border-line pt-6">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-small font-semibold"><FlaskConical className="size-4" aria-hidden />Reproduction</h3>
        <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
        {(s.reproduced > 0 || s.notReproduced > 0) && (
          <span className="text-caption text-fg-subtle">{s.reproduced} reproduced · {s.notReproduced} couldn&apos;t</span>
        )}
      </div>

      <div className="mt-3">
        <p className="mb-1 text-caption font-medium text-fg-subtle">Steps to reproduce</p>
        {editing ? (
          <>
            <textarea className="input min-h-24 text-small" maxLength={5000} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={'1. Open the cart\n2. Enter SAVE10\n3. Press Apply'} aria-label="Steps to reproduce" autoFocus />
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="primary" loading={saveSteps.isPending} onClick={() => saveSteps.mutate()}>Save steps</Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setSteps(data.steps); }}>Cancel</Button>
            </div>
          </>
        ) : data.steps ? (
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-small">{data.steps}</p>
            {canWork && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
          </div>
        ) : canWork ? (
          <button type="button" onClick={() => setEditing(true)} className="ds-focus -mx-1 w-[calc(100%+0.5rem)] rounded-tile px-1 py-1 text-left text-small text-fg-subtle transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg-muted">Write the steps…</button>
        ) : <EmptyNote>No steps written yet.</EmptyNote>}
      </div>

      {data.attempts.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-caption">
          {[...data.attempts].reverse().map((a) => (
            <li key={a.id} className="flex items-start gap-2">
              {a.result === 'reproduced' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden /> : <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />}
              <span className="min-w-0 flex-1">
                <b>{a.by?.name ?? 'Someone'}</b> {a.result === 'reproduced' ? 'reproduced it' : "couldn't reproduce it"}
                {a.environment && <> on <i>{a.environment}</i></>}
                <span className="text-fg-subtle"> · {timeAgo(a.at)}</span>
                {a.note && <span className="block text-fg-muted">{a.note}</span>}
              </span>
              {canWork && (a.by?.id === userId || isManager) && (
                <button type="button" className="text-fg-subtle hover:text-danger" aria-label="Remove this attempt" onClick={() => remove.mutate(a.id)}><Trash2 className="size-3.5" /></button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWork && (
        <div className="mt-3 space-y-2 border-t border-line pt-3 ">
          <p className="text-caption font-medium text-fg-subtle">Record your attempt</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input h-8 text-caption" maxLength={100} value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="Where you tried, e.g. Chrome on Windows, staging" aria-label="Where you tried" />
            <input className="input h-8 text-caption" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note about the attempt" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={record.isPending && record.variables === 'reproduced'} onClick={() => record.mutate('reproduced')}><CheckCircle2 className="size-3.5" />I reproduced it</Button>
            <Button size="sm" loading={record.isPending && record.variables === 'not_reproduced'} onClick={() => record.mutate('not_reproduced')}><CircleSlash className="size-3.5" />I couldn&apos;t</Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Settings: where the code lives ----------


export function SourceSettings({ project, refresh }) {
  const src = project.source ?? {};
  const [form, setForm] = useState({ repo: src.repo ?? '', branch: src.branch ?? 'main', pathPrefix: src.pathPrefix ?? '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm({ repo: src.repo ?? '', branch: src.branch ?? 'main', pathPrefix: src.pathPrefix ?? '' }), [src.repo, src.branch, src.pathPrefix]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async (clear = false) => {
    setBusy(true);
    try {
      await api(`/projects/${project.id}/source`, { method: 'PUT', body: clear ? { repo: null } : { repo: form.repo.trim() || null, branch: form.branch.trim() || 'main', pathPrefix: form.pathPrefix.trim() } });
      toast.success(clear ? 'Source links turned off' : 'Saved');
      refresh();
    } catch (e) { toast.error(e.details?.[0]?.message ?? e.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Source code" description="Links each frame of your code in a stack trace to that file and line on GitHub. The link opens the branch as it is now, so lines may have moved since the crash.">
      <div className="space-y-3 text-small">
        {src.repo && <p className="text-caption text-fg-subtle">{src.learnedFrom === 'github' ? 'Filled in from your GitHub webhook.' : 'Set by hand.'}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-caption">Repository<input className="input mt-1 h-8 font-code text-caption" value={form.repo} onChange={set('repo')} placeholder="owner/name" /></label>
          <label className="text-caption">Branch<input className="input mt-1 h-8 font-code text-caption" value={form.branch} onChange={set('branch')} placeholder="main" /></label>
        </div>
        <label className="block text-caption">Strip this from file paths (optional)
          <input className="input mt-1 h-8 font-code text-caption" value={form.pathPrefix} onChange={set('pathPrefix')} placeholder="/var/www/shop/" />
        </label>
        <p className="text-caption text-fg-subtle">
          Relative paths like <code className="font-code">app/models/order.rb</code> link as they are. Absolute paths (like <code className="font-code">/var/www/shop/src/Cart.php</code>) link only when they start with the text above.
          Bundled files with a build hash need source maps, and Java frames carry only a file name, so those are not linked.
        </p>
        <div className="flex gap-2">
          <Button variant="primary" loading={busy} disabled={form.repo === (src.repo ?? '') && form.branch === (src.branch ?? 'main') && form.pathPrefix === (src.pathPrefix ?? '')} onClick={() => save(false)}>Save</Button>
          {src.repo && <Button variant="ghost" onClick={() => save(true)}>Turn off</Button>}
        </div>
      </div>
    </Section>
  );
}

// ---------- Settings: crash capture (E6A) ----------

function CodeBlock({ label, code }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-caption text-fg-subtle">
        <span>{label}</span>
        <Button size="sm" variant="ghost" onClick={() => copyText(code, 'Copied')}><Copy className="size-3.5" />Copy</Button>
      </div>
      <pre className="overflow-x-auto rounded-tile border border-line bg-sunken p-3 font-code text-micro leading-relaxed text-fg">{code}</pre>
    </div>
  );
}

export function CrashCaptureSettings({ project }) {
  const qc = useQueryClient();
  const qkey = ['ingest-keys', project.id];
  const { data } = useQuery({ queryKey: qkey, queryFn: () => api(`/projects/${project.id}/ingest-keys`) });
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [made, setMade] = useState(null);
  const create = useMutation({
    mutationFn: () => api(`/projects/${project.id}/ingest-keys`, { method: 'POST', body: { name, origins: origins.split(/[\s,]+/).filter(Boolean) } }),
    onSuccess: (r) => { setMade(r); setName(''); setOrigins(''); qc.invalidateQueries({ queryKey: qkey }); },
    onError: (e) => toast.error(e.details?.[0]?.message ?? e.message),
  });
  const revoke = useMutation({
    mutationFn: (id) => api(`/projects/${project.id}/ingest-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qkey }); toast.success('Key revoked. Reports sent with it are refused from now on.'); },
    onError: (e) => toast.error(e.message),
  });
  if (!data) return null;
  const crashKeys = data.keys.filter((k) => (k.kind ?? 'ingest') === 'ingest');
  const active = crashKeys.filter((k) => !k.revokedAt);
  return (
    <Section title="Crash capture" description="Your apps send their own crashes here with an ingest key. New crashes wait in the triage inbox; repeats are counted on the ticket they belong to. A key can only send crashes, so it's safe inside a web page.">
      <div className="space-y-4 text-small">
        {data.sdkUrl.startsWith('http://localhost') && (
          <p className="text-caption text-warning">Tessera is running on this computer, so only apps on this computer can reach it. Real websites can send crashes once the API is deployed.</p>
        )}
        {made && (
          <div className="space-y-3 rounded-tile border border-line-strong bg-sunken p-3 ">
            <p className="text-caption"><b>Copy the key now.</b> Tessera keeps only a fingerprint of it and won&apos;t show it again.</p>
            <CodeBlock label={`Ingest key "${made.ingestKey.name}"`} code={made.key} />
            <CodeBlock label="In a web page (catches uncaught errors and rejected promises)" code={`<script src="${made.sdkUrl}" data-key="${made.key}" data-release="1.0.0" defer></script>`} />
            <CodeBlock label="Your own errors, from the page" code={'try {\n checkout();\n} catch (error) {\n Tessera.capture(error);\n throw error;\n}'} />
            <CodeBlock label="From a server or script" code={`curl -X POST ${made.endpoint} \\\n -H "Content-Type: application/json" \\\n -d '{"key":"${made.key}","type":"Error","message":"Payment worker crashed","stack":"..."}'`} />
            <Button size="sm" variant="ghost" onClick={() => setMade(null)}>I&apos;ve copied it</Button>
          </div>
        )}
        {crashKeys.length > 0 ? (
          <ul className="divide-y divide-line">
            {crashKeys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 py-2">
                <KeyRound className="size-4 text-fg-subtle" aria-hidden />
                <span className="font-medium">{k.name}</span>
                <code className="font-code text-caption text-fg-subtle">{k.prefix}…</code>
                {k.revokedAt ? <Badge>Revoked</Badge> : <Badge tone="teal">Active</Badge>}
                <span className="text-caption text-fg-subtle">
                  {k.origins.length ? `only ${k.origins.join(', ')}` : 'any website or server'} · {k.received} received{k.lastUsedAt ? ` · last ${timeAgo(k.lastUsedAt)}` : ' · never used'}
                </span>
                {!k.revokedAt && <Button size="sm" variant="ghost" className="ml-auto" loading={revoke.isPending && revoke.variables === k.id} onClick={async () => { if (await ask(`Revoke "${k.name}"? Apps still using it will be refused.`)) revoke.mutate(k.id); }}>Revoke</Button>}
              </li>
            ))}
          </ul>
        ) : <EmptyNote size="xs">No keys yet.</EmptyNote>}
        {active.length < 10 && (
          <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
            <input className="input h-9 text-small" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Shop website" aria-label="Key name" />
            <input className="input h-9 text-small" value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="Only these websites (optional): https://shop.example.com" aria-label="Allowed websites" />
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>New key</Button>
          </div>
        )}
        <p className="text-caption text-fg-subtle">
          Sent: the error, its stack, the page address without its query string, the release and environment you set, and the browser. Nothing else from the page.
          Limit a key to your websites so it can&apos;t be used from anywhere else; leave it open for servers.
        </p>
      </div>
    </Section>
  );
}

// ---------- Stack frames, with what source maps recovered (E6B) ----------

const baseName = (f) => String(f ?? '').split(/[?#]/)[0].split(/[\\/]/).pop();
const BUNDLED = /[.-][0-9a-zA-Z_-]{8,}\.(?:m?js|cjs)$/;

export function StackFrames({ frames, error, pid, ticket, canWork }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(() => frames.findIndex((f) => f.context));
  const remap = useMutation({
    mutationFn: () => api(`/projects/${pid}/tickets/${ticket.number}/error/unminify`, { method: 'POST' }),
    onSuccess: (r) => {
      if (!r.mapped) { toast('No uploaded source map matches these scripts yet. Upload them in Settings → Source maps.'); return; }
      toast.success(`Mapped ${r.mapped} frame${r.mapped === 1 ? '' : 's'}${r.sameAs ? `. ${r.sameAs} is the same original crash; both tickets stay as they are.` : ''}`, { duration: 6000 });
      qc.invalidateQueries({ queryKey: qk.ticket(pid, ticket.number) });
      qc.invalidateQueries({ queryKey: qk.history(pid, ticket.number) });
    },
    onError: (e) => toast.error(e.message),
  });
  const bundled = !error.unminified && error.language === 'javascript' && error.frames.some((f) => BUNDLED.test(baseName(f.file)));
  return (
    <>
      {error.unminified && (
        <p className="mt-2 flex items-center gap-1.5 text-micro text-fg-muted">
          <FileCode2 className="size-3.5" aria-hidden />
          {error.unminified.mapped} of {error.unminified.of} frames shown as your original code, from the source maps of release {error.unminified.releases.join(', ')}. Hover a frame for where it was in the built file.
        </p>
      )}
      {frames.length > 0 && (
        <ol className="mt-3 space-y-0.5 font-code text-micro">
          {frames.map((f, i) => (
            <li key={i} className={clsx('rounded-hair px-1.5 py-0.5', f.inApp ? 'bg-raised text-fg' : 'text-fg-subtle')}>
              <div className="flex items-center gap-1" title={f.minified ? `Built file: ${baseName(f.minified.file)}:${f.minified.line}:${f.minified.column}${f.minified.fn ? ` in ${f.minified.fn}` : ''}` : undefined}>
                <span className="truncate">
                  {f.fn ?? '<anonymous>'}{' '}
                  {f.source ? (
                    <a href={f.source} target="_blank" rel="noreferrer" className="text-accent underline " title="Open this line on GitHub (the branch as it is now)">{f.file?.split(/[\\/]/).pop()}{f.line ? `:${f.line}` : ''}</a>
                  ) : (
                    <span className="text-fg-subtle">{f.minified ? f.file : f.file?.split(/[\\/]/).pop()}{f.line ? `:${f.line}` : ''}{f.column ? `:${f.column}` : ''}</span>
                  )}
                </span>
                {f.context && (
                  <button type="button" className="ml-auto shrink-0 text-fg-subtle hover:text-accent" aria-expanded={open === i} aria-label="Show the code around this line" onClick={() => setOpen((o) => (o === i ? -1 : i))}><Code2 className="size-3.5" /></button>
                )}
              </div>
              {open === i && f.context && (
                <pre className="mt-1 overflow-x-auto rounded-tile border border-line bg-sunken p-2 font-code text-micro leading-relaxed text-fg-muted">
                  {f.context.pre.map((l, k) => <div key={`p${k}`}><span className="mr-3 inline-block w-8 select-none text-right text-fg-muted">{f.line - f.context.pre.length + k}</span>{l}</div>)}
                  <div className="bg-danger/15 text-fg"><span className="mr-3 inline-block w-8 select-none text-right text-danger">{f.line}</span>{f.context.line}</div>
                  {f.context.post.map((l, k) => <div key={`n${k}`}><span className="mr-3 inline-block w-8 select-none text-right text-fg-muted">{f.line + 1 + k}</span>{l}</div>)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
      {bundled && canWork && (
        <Button size="sm" variant="ghost" className="mt-2" loading={remap.isPending} onClick={() => remap.mutate()}><Wand2 className="size-3.5" />Unminify with uploaded source maps</Button>
      )}
    </>
  );
}

// ---------- Settings: source maps (E6B) ----------

export function SourceMapSettings({ project }) {
  const qc = useQueryClient();
  const pid = project.id;
  const { data } = useQuery({ queryKey: ['sourcemaps', pid], queryFn: () => api(`/projects/${pid}/sourcemaps`) });
  const { data: keys } = useQuery({ queryKey: ['ingest-keys', pid], queryFn: () => api(`/projects/${pid}/ingest-keys`) });
  const [release, setRelease] = useState('');
  const [files, setFiles] = useState([]);
  const [inputKey, setInputKey] = useState(0);
  const [tokenName, setTokenName] = useState('');
  const [made, setMade] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['sourcemaps', pid] });
  const send = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('release', release.trim());
      for (const f of files) form.append('files', f);
      return api(`/projects/${pid}/sourcemaps`, { method: 'POST', form });
    },
    onSuccess: (r) => { toast.success(`Uploaded ${r.maps.length} map${r.maps.length === 1 ? '' : 's'} for ${r.release}`); setFiles([]); setInputKey((k) => k + 1); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const drop = useMutation({
    mutationFn: (rel) => api(`/projects/${pid}/sourcemaps?release=${encodeURIComponent(rel)}`, { method: 'DELETE' }),
    onSuccess: (r) => { toast.success(`Deleted ${r.deleted} map${r.deleted === 1 ? '' : 's'} of ${r.release}`); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const makeToken = useMutation({
    mutationFn: () => api(`/projects/${pid}/ingest-keys`, { method: 'POST', body: { name: tokenName, kind: 'upload' } }),
    onSuccess: (r) => { setMade(r); setTokenName(''); qc.invalidateQueries({ queryKey: ['ingest-keys', pid] }); },
    onError: (e) => toast.error(e.details?.[0]?.message ?? e.message),
  });
  const revoke = useMutation({
    mutationFn: (id) => api(`/projects/${pid}/ingest-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ingest-keys', pid] }); toast.success('Token revoked'); },
    onError: (e) => toast.error(e.message),
  });
  if (!data) return null;
  const tokens = (keys?.keys ?? []).filter((k) => k.kind === 'upload');
  const uploadUrl = keys ? `${new URL(keys.endpoint).origin}/api/sourcemaps` : '';
  return (
    <Section title="Source maps" description="Upload the .map files of each release, and crashes from its minified scripts show your original files, lines and function names. Maps stay private to the project; they are never served to anyone.">
      <div className="space-y-4 text-small">
        {data.releases.length ? (
          <ul className="divide-y divide-line">
            {data.releases.map((r) => (
              <li key={r.release} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-code font-medium">{r.release}</span>
                  <span className="text-caption text-fg-subtle">{r.maps.length} map{r.maps.length === 1 ? '' : 's'} · {fileSize(r.size)} · {timeAgo(r.uploadedAt)}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" loading={drop.isPending && drop.variables === r.release} onClick={async () => { if (await ask(`Delete the maps of ${r.release}? Crashes already unminified stay as they are.`)) drop.mutate(r.release); }}>Delete</Button>
                </div>
                <p className="mt-0.5 truncate font-code text-micro text-fg-subtle">{r.maps.map((m) => m.file).join(', ')}</p>
              </li>
            ))}
          </ul>
        ) : <EmptyNote size="xs">No maps uploaded yet.</EmptyNote>}
        <p className="text-caption text-fg-subtle">{data.count} of {data.limit} maps kept. Each map can be up to 5 MB.</p>
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
          <input className="input h-9 font-code text-small" maxLength={100} value={release} onChange={(e) => setRelease(e.target.value)} placeholder="Release, e.g. 1.4.2" aria-label="Release" />
          <label className="ds-focus-within flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-tile border border-dashed border-line-strong px-3 text-small text-fg-muted transition-colors duration-(--dur-fast) hover:border-accent hover:text-fg">
            <input key={inputKey} type="file" multiple accept=".map,application/json" className="sr-only" onChange={(e) => setFiles([...e.target.files])} aria-label="Source map files" />
            <FileUp className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{files.length ? (files.length === 1 ? files[0].name : `${files.length} files chosen`) : 'Choose .map files'}</span>
          </label>
          <Button variant="primary" loading={send.isPending} disabled={!release.trim() || !files.length} onClick={() => send.mutate()}><Upload className="size-4" />Upload</Button>
        </div>
        <p className="text-caption text-fg-subtle">Use the same release name your page sends (<code className="font-code">data-release</code>). Built files with a hash in their name (app.4f9a2c1e.js) are matched even without one.</p>

        <div className="space-y-2 border-t border-line pt-3 ">
          <p className="text-caption font-medium">Upload from your build (CI)</p>
          {made && (
            <div className="space-y-3 rounded-tile border border-line-strong bg-sunken p-3 ">
              <p className="text-caption"><b>Copy the token now</b> and keep it secret, in your CI&apos;s secrets. Tessera won&apos;t show it again. It can only upload maps to this project.</p>
              <CodeBlock label={`Upload token "${made.ingestKey.name}"`} code={made.key} />
              <CodeBlock label="After each build" code={`curl -X POST ${uploadUrl} \\\n -H "Authorization: Bearer $TESSERA_UPLOAD_TOKEN" \\\n -F "release=1.4.2" \\\n -F "files=@dist/assets/app.4f9a2c1e.js.map"`} />
              <Button size="sm" variant="ghost" onClick={() => setMade(null)}>I&apos;ve copied it</Button>
            </div>
          )}
          {tokens.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-2 text-caption">
              <KeyRound className="size-3.5 text-fg-subtle" aria-hidden /><span className="font-medium">{k.name}</span>
              <code className="font-code text-fg-subtle">{k.prefix}…</code>
              {k.revokedAt ? <Badge>Revoked</Badge> : <Badge tone="teal">Active</Badge>}
              <span className="text-fg-subtle">{k.received} maps uploaded{k.lastUsedAt ? ` · last ${timeAgo(k.lastUsedAt)}` : ''}</span>
              {!k.revokedAt && <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => { if (await ask(`Revoke "${k.name}"?`)) revoke.mutate(k.id); }}>Revoke</Button>}
            </div>
          ))}
          <div className="flex gap-2">
            <input className="input h-9 text-small" maxLength={60} value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Token name, e.g. GitHub Actions" aria-label="Upload token name" />
            <Button loading={makeToken.isPending} disabled={!tokenName.trim()} onClick={() => makeToken.mutate()}>New upload token</Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---------- Settings: the report button on the team's own websites (E6C) ----------

export function WidgetSettings({ portal, put, disabled }) {
  const w = portal.widget ?? { enabled: false, origins: [] };
  const [sites, setSites] = useState(w.origins.join(', '));
  useEffect(() => setSites(w.origins.join(', ')), [w.origins.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = () => sites.split(/[\s,]+/).filter(Boolean);
  const snippet = w.token ? `<script src="${w.scriptUrl}" data-portal="${w.token}" defer></script>` : '';
  return (
    <div className="mt-5 space-y-3 border-t border-line pt-4 text-small ">
      <p className="font-medium">Report button on your website</p>
      <p className="text-caption text-fg-subtle">
        Adds a small &ldquo;Report a problem&rdquo; button to your own site. Reports arrive in the triage inbox like portal reports, with the page address (no query string),
        the browser and window size. People can add a screenshot of the page and mark it up, and can choose to include the page&apos;s recent console errors after seeing them.
      </p>
      <label className="block text-caption">Websites it may be used on
        <input className="input mt-1 h-9 text-small" value={sites} onChange={(e) => setSites(e.target.value)} placeholder="https://shop.example.com, https://www.shop.example.com" disabled={disabled} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={w.enabled ? 'secondary' : 'primary'} disabled={disabled || !portal.enabled} onClick={() => put({ widget: { enabled: !w.enabled, origins: list() } })}>{w.enabled ? 'Turn the button off' : 'Turn the button on'}</Button>
        {w.enabled && sites !== w.origins.join(', ') && <Button size="sm" onClick={() => put({ widget: { origins: list() } })}>Save websites</Button>}
      </div>
      {!portal.enabled && <p className="text-caption text-fg-subtle">Turn on public reports first; the button uses the same inbox.</p>}
      {w.enabled && snippet && <CodeBlock label="Add this to your site's pages" code={snippet} />}
      {w.enabled && w.scriptUrl.startsWith('http://localhost') && <p className="text-caption text-warning">Tessera is running on this computer, so only pages on this computer can use the button until the API is deployed.</p>}
    </div>
  );
}
