import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, Copy, KeyRound, Send, XCircle } from 'lucide-react';
import { api, apiBase } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { formatDateTime, timeAgo } from '../lib/format.js';
import { Badge, Button, Field, Modal } from './ui.jsx';
import { FieldSelect } from '../ds/core.jsx';
import { ask } from './confirm.jsx';

// Notifications and integrations (E13): email settings, personal API tokens, Slack / Discord
// alerts, outgoing webhooks and GitLab.

const EVENT_LABEL = {
  'ticket.created': 'New ticket', 'ticket.moved': 'Moved', 'ticket.done': 'Finished', 'ticket.assigned': 'Assigned',
  'ticket.commented': 'New comment', 'ticket.updated': 'Edited',
};
const PRIORITIES = ['critical', 'high', 'medium', 'low'];

function Toggles({ all, value, onChange, label = (x) => x }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((x) => (
        <label key={x} className="flex items-center gap-1.5 rounded-tile border border-line px-2 py-1 text-caption ">
          <input type="checkbox" className="accent-accent" checked={value.includes(x)} onChange={(e) => onChange(e.target.checked ? [...value, x] : value.filter((v) => v !== x))} />
          {label(x)}
        </label>
      ))}
    </div>
  );
}

// ---------- the signed-in person ----------

export function NotificationSettings({ Section }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['notify-settings'], queryFn: () => api('/me/notifications').then((d) => d.settings) });
  const zones = useMemo(() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } }, []);
  if (!data) return null;
  const put = async (body) => {
    try { const r = await api('/me/notifications', { method: 'PUT', body }); qc.setQueryData(['notify-settings'], r.settings); toast.success('Saved'); } catch (e) { toast.error(e.message); }
  };
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  return (
    <Section title="Notification emails" description="The bell always shows everything. These settings only change when emails arrive.">
      <div className="space-y-4 text-small">
        {!data.emailVerified && <p className="text-caption text-warning">Confirm your email address first; until then no notification emails are sent.</p>}
        <label className="flex items-center gap-2 text-caption">Time zone
          <select className="input h-8 w-auto" value={data.timeZone} onChange={(e) => put({ timeZone: e.target.value })}>
            {(zones.includes(data.timeZone) ? zones : [data.timeZone, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        {/* Rows 32px tall, so each radio has a 24px target area clear of its neighbours (WCAG 2.5.8). */}
        <fieldset>
          <legend className="mb-1 text-caption font-medium">How emails come</legend>
          {[['off', 'One email per update, while you are away from Tessera'], ['daily', 'One daily digest of what you have not read'], ['weekly', 'One weekly digest, on Mondays']].map(([k, label]) => (
            <label key={k} className="flex min-h-8 cursor-pointer items-center gap-2">
              <input type="radio" name="digest" className="size-4 accent-accent" checked={data.digest === k} onChange={() => put({ digest: k })} />{label}
            </label>
          ))}
          {data.digest !== 'off' && (
            <label className="ml-6 flex items-center gap-2 text-caption">at
              <select className="input h-8 w-auto" value={data.digestHour} onChange={(e) => put({ digestHour: Number(e.target.value) })}>
                {hours.map((h, i) => <option key={h} value={i}>{h}</option>)}
              </select>
              {data.lastDigestAt && <span className="text-fg-subtle">last sent {timeAgo(data.lastDigestAt)}</span>}
            </label>
          )}
        </fieldset>
        {data.digest === 'off' && (
          <fieldset className="space-y-1">
            <legend className="text-caption font-medium">Quiet hours</legend>
            <label className="flex flex-wrap items-center gap-2">
              <input type="checkbox" className="accent-accent" checked={data.quiet.enabled} onChange={(e) => put({ quiet: { enabled: e.target.checked } })} />
              Hold emails from
              <input type="time" className="input h-8 w-auto" value={data.quiet.from} onChange={(e) => put({ quiet: { from: e.target.value } })} aria-label="Quiet from" />
              to
              <input type="time" className="input h-8 w-auto" value={data.quiet.to} onChange={(e) => put({ quiet: { to: e.target.value } })} aria-label="Quiet until" />
            </label>
            <p className="text-caption text-fg-subtle">Held emails arrive as one summary when quiet hours end, if you haven't read them by then.</p>
          </fieldset>
        )}
      </div>
    </Section>
  );
}

export function ApiTokens({ Section }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['api-tokens'], queryFn: () => api('/me/tokens').then((d) => d.tokens) });
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [days, setDays] = useState(90);
  const [made, setMade] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('/me/tokens', { method: 'POST', body: { name: name.trim(), scope, expiresInDays: days || null } });
      setMade(token);
      setName('');
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (err) { toast.error(err.message); }
  };
  const revoke = async (t) => {
    if (!(await ask(`Revoke "${t.name}"? Scripts using it stop working at once.`))) return;
    try { await api(`/me/tokens/${t.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['api-tokens'] }); } catch (err) { toast.error(err.message); }
  };
  // The API answers at apiBase in production; in development the app's own address proxies /api.
  const apiAddress = apiBase || window.location.origin;
  return (
    <Section title="API tokens" description="For scripts and the Tessera CLI. A token acts as you in your projects. Read tokens can only look. No token can change your password, 2FA, sessions or tokens.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={create}>
        <Field label="Name"><input className="input w-44" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Laptop CLI" /></Field>
        <Field label="Can"><FieldSelect className="input w-36" value={scope} onChange={(e) => setScope(e.target.value)}><option value="read">read only</option><option value="write">read and write</option></FieldSelect></Field>
        <Field label="Expires"><FieldSelect className="input w-32" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={30}>in 30 days</option><option value={90}>in 90 days</option><option value={365}>in a year</option><option value={0}>never</option></FieldSelect></Field>
        <Button type="submit" variant="primary" disabled={!name.trim()} className="mb-0.5"><KeyRound className="size-3.5" />Create</Button>
      </form>
      <ul className="mt-4 divide-y divide-line text-small ">
        {(data ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{t.name}</span>
            <span className="font-code text-caption text-fg-subtle">{t.prefix}…</span>
            <Badge tone={t.scope === 'write' ? 'amber' : 'zinc'}>{t.scope === 'write' ? 'read and write' : 'read only'}</Badge>
            {t.revokedAt ? <Badge tone="red">revoked</Badge> : t.expired ? <Badge tone="red">expired</Badge> : t.expiresAt && <span className="text-caption text-fg-subtle">expires {formatDateTime(t.expiresAt)}</span>}
            <span className="ml-auto text-caption text-fg-subtle">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
            {!t.revokedAt && !t.expired && <Button size="sm" variant="ghost" onClick={() => revoke(t)}>Revoke</Button>}
          </li>
        ))}
      </ul>
      <Modal open={Boolean(made)} title="Copy your token now" onClose={() => setMade(null)} footer={<Button variant="primary" onClick={() => setMade(null)}>Done</Button>}>
        {made && (
          <div className="space-y-3 text-small">
            <p>This is the only time it is shown. Tessera keeps only a fingerprint of it.</p>
            <div className="flex gap-2"><input readOnly className="input font-code text-caption" value={made.token} aria-label="New token" /><Button onClick={() => copyText(made.token, 'Token copied')}><Copy className="size-3.5" />Copy</Button></div>
            <p className="text-caption text-fg-subtle">With the Tessera CLI (the <code>cli</code> folder of the repository):</p>
            <pre className="overflow-x-auto rounded-tile bg-sunken p-2 font-code text-micro text-fg">{`node cli/bin/tessera.mjs login ${apiAddress} <token>\nnode cli/bin/tessera.mjs list <PROJECT KEY> --mine`}</pre>
          </div>
        )}
      </Modal>
    </Section>
  );
}

// ---------- project integrations ----------

function Delivered({ d }) {
  if (!d) return <span className="text-caption text-fg-subtle">nothing sent yet</span>;
  return (
    <span className="flex items-center gap-1 text-caption text-fg-subtle" title={formatDateTime(d.at)}>
      {d.ok ? <CheckCircle2 className="size-3.5 text-success" aria-hidden /> : <XCircle className="size-3.5 text-danger" aria-hidden />}
      {d.ok ? 'delivered' : d.error ?? 'failed'} {timeAgo(d.at)}
    </span>
  );
}

export function OutboundSettings({ project, Section }) {
  const qc = useQueryClient();
  const pid = project.id;
  const key = ['outbound', pid];
  const { data } = useQuery({ queryKey: key, queryFn: () => api(`/projects/${pid}/integrations/outbound`) });
  const [alert, setAlert] = useState({ kind: 'slack', name: '', url: '', events: ['ticket.created', 'ticket.done'], priorities: [] });
  const [hook, setHook] = useState({ name: '', url: '', events: [] });
  const [secret, setSecret] = useState(null);
  if (!data) return null;
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const call = async (path, method, body) => {
    try { const r = await api(`/projects/${pid}/integrations/${path}`, { method, body }); refresh(); return r ?? {}; } catch (e) { toast.error(e.message); return null; }
  };
  const test = async (path) => {
    const r = await call(`${path}/test`, 'POST');
    if (r?.delivery) (r.delivery.ok ? toast.success(`Delivered (${r.delivery.status})`) : toast.error(`Not delivered: ${r.delivery.error}`));
  };
  const disabled = Boolean(project.archivedAt);
  return (
    <Section title="Alerts and webhooks" description="Post ticket changes to a Slack or Discord channel, or send them as signed JSON to your own endpoint. Chat webhook URLs are stored encrypted and never shown again.">
      <div className="space-y-5 text-small">
        <div className="space-y-2">
          <p className="font-medium">Chat alerts</p>
          {data.alerts.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-tile border border-line p-2 ">
              <Badge>{a.kind === 'slack' ? 'Slack' : 'Discord'}</Badge>
              <span className="font-medium">{a.name}</span>
              <span className="font-code text-micro text-fg-subtle">{a.hint}</span>
              {!a.active && <Badge tone="amber">{a.failures >= 20 ? 'paused after 20 failures' : 'paused'}</Badge>}
              <Delivered d={a.lastDelivery} />
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => test(`alerts/${a.id}`)}><Send className="size-3.5" />Test</Button>
                <Button size="sm" variant="ghost" onClick={() => call(`alerts/${a.id}`, 'PATCH', { active: !a.active })}>{a.active ? 'Pause' : 'Resume'}</Button>
                <Button size="sm" variant="ghost" onClick={async () => (await ask(`Remove "${a.name}"?`)) && call(`alerts/${a.id}`, 'DELETE')}>Remove</Button>
              </span>
              <div className="w-full text-caption text-fg-subtle">{a.events.map((e) => EVENT_LABEL[e]).join(', ')}{a.priorities.length ? ` · only ${a.priorities.join(', ')}` : ''}</div>
            </div>
          ))}
          <form className="space-y-2 rounded-tile bg-hover p-3 " onSubmit={async (e) => { e.preventDefault(); if (await call('alerts', 'POST', alert)) setAlert((s) => ({ ...s, name: '', url: '' })); }}>
            <div className="flex flex-wrap gap-2">
              <select className="input w-28" value={alert.kind} onChange={(e) => setAlert({ ...alert, kind: e.target.value })} aria-label="Chat app"><option value="slack">Slack</option><option value="discord">Discord</option></select>
              <input className="input w-40" placeholder="#bugs channel" value={alert.name} onChange={(e) => setAlert({ ...alert, name: e.target.value })} aria-label="Name" maxLength={80} />
              <input className="input min-w-64 flex-1 font-code text-caption" type="password" autoComplete="off" placeholder={alert.kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://discord.com/api/webhooks/…'} value={alert.url} onChange={(e) => setAlert({ ...alert, url: e.target.value })} aria-label="Webhook URL" />
            </div>
            <Toggles all={data.events} value={alert.events} onChange={(events) => setAlert({ ...alert, events })} label={(x) => EVENT_LABEL[x]} />
            <div className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle">Only these priorities (none ticked: all)<Toggles all={PRIORITIES} value={alert.priorities} onChange={(priorities) => setAlert({ ...alert, priorities })} /></div>
            <Button type="submit" size="sm" variant="primary" disabled={disabled || !alert.name.trim() || !alert.url.trim() || !alert.events.length}>Add alert</Button>
          </form>
        </div>

        <div className="space-y-2">
          <p className="font-medium">Outgoing webhooks</p>
          <p className="text-caption text-fg-subtle">Each delivery is a JSON POST with <code>X-Tessera-Event</code>, <code>X-Tessera-Delivery</code> and <code>X-Tessera-Signature: sha256=…</code> (an HMAC of the body with your secret). Failures are retried twice; after 20 failures in a row the webhook pauses.</p>
          {data.webhooks.map((h) => (
            <div key={h.id} className="flex flex-wrap items-center gap-2 rounded-tile border border-line p-2 ">
              <span className="font-medium">{h.name}</span>
              <span className="break-all font-code text-micro text-fg-subtle">{h.url}</span>
              {!h.active && <Badge tone="amber">paused</Badge>}
              <Delivered d={h.lastDelivery} />
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => test(`webhooks/${h.id}`)}><Send className="size-3.5" />Ping</Button>
                <Button size="sm" variant="ghost" onClick={() => call(`webhooks/${h.id}`, 'PATCH', { active: !h.active })}>{h.active ? 'Pause' : 'Resume'}</Button>
                <Button size="sm" variant="ghost" onClick={async () => (await ask(`Remove "${h.name}"?`)) && call(`webhooks/${h.id}`, 'DELETE')}>Remove</Button>
              </span>
              <div className="w-full text-caption text-fg-subtle">{h.events.map((e) => EVENT_LABEL[e]).join(', ')}</div>
            </div>
          ))}
          <form className="space-y-2 rounded-tile bg-hover p-3 " onSubmit={async (e) => { e.preventDefault(); const r = await call('webhooks', 'POST', { ...hook, events: hook.events.length ? hook.events : data.events }); if (r?.webhook) { setSecret(r.webhook.secret); setHook({ name: '', url: '', events: [] }); } }}>
            <div className="flex flex-wrap gap-2">
              <input className="input w-40" placeholder="Name" value={hook.name} onChange={(e) => setHook({ ...hook, name: e.target.value })} aria-label="Webhook name" maxLength={80} />
              <input className="input min-w-64 flex-1 font-code text-caption" placeholder="https://example.com/hooks/tessera" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} aria-label="Endpoint URL" />
            </div>
            <Toggles all={data.events} value={hook.events} onChange={(events) => setHook({ ...hook, events })} label={(x) => EVENT_LABEL[x]} />
            <p className="text-caption text-fg-subtle">None ticked: every event.</p>
            <Button type="submit" size="sm" variant="primary" disabled={disabled || !hook.name.trim() || !hook.url.trim()}>Add webhook</Button>
          </form>
        </div>

        {data.deliveries.length > 0 && (
          <details>
            <summary className="cursor-pointer text-caption font-medium">Recent deliveries ({data.deliveries.length})</summary>
            <ul className="mt-2 space-y-1 text-caption">
              {data.deliveries.map((d) => (
                <li key={d.id} className="flex flex-wrap gap-2">
                  {d.ok ? <CheckCircle2 className="size-3.5 text-success" aria-label="Delivered" /> : <XCircle className="size-3.5 text-danger" aria-label="Failed" />}
                  <span>{d.target.name}</span><span className="font-code text-fg-subtle">{d.event}</span>
                  <span className="text-fg-subtle">{d.status ?? '—'}{d.error ? ` · ${d.error}` : ''} · {d.duration} ms{d.attempts > 1 ? ` · ${d.attempts} tries` : ''}</span>
                  <span className="ml-auto text-fg-subtle">{timeAgo(d.at)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <Modal open={Boolean(secret)} title="Your signing secret" onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}>
        <div className="space-y-2 text-small">
          <p>Shown once. Check each delivery's <code>X-Tessera-Signature</code> with it.</p>
          <div className="flex gap-2"><input readOnly className="input font-code text-caption" value={secret ?? ''} aria-label="Signing secret" /><Button onClick={() => copyText(secret, 'Secret copied')}><Copy className="size-3.5" />Copy</Button></div>
        </div>
      </Modal>
    </Section>
  );
}

export function GitlabSettings({ project, Section }) {
  const qc = useQueryClient();
  const pid = project.id;
  const isAdmin = project.myRole === 'admin';
  const { data } = useQuery({ queryKey: ['gitlab', pid], queryFn: () => api(`/projects/${pid}/integrations/gitlab`).then((d) => d.gitlab) });
  const [token, setToken] = useState('');
  const [base, setBase] = useState('https://gitlab.com');
  if (!data) return null;
  const run = async (path, method, body) => {
    try { const r = await api(`/projects/${pid}/integrations/gitlab${path}`, { method, body }); qc.setQueryData(['gitlab', pid], r.gitlab); return r; } catch (e) { toast.error(e.message); return null; }
  };
  return (
    <Section title="GitLab" description="Commits and merge requests that mention a ticket (TES-12) link to it; &quot;Closes TES-12&quot; in a commit on the default branch or a merged merge request finishes it.">
      <div className="space-y-3 text-small">
        {!data.connected ? (
          isAdmin ? <Button onClick={() => run('', 'PUT')}>Connect GitLab</Button> : <p className="text-caption text-fg-subtle">An admin can connect GitLab.</p>
        ) : (
          <>
            <p className="text-caption text-fg-subtle">In GitLab: Settings → Webhooks. Add this URL with the secret token, and tick Push events and Merge request events.</p>
            <div className="flex gap-2"><input readOnly className="input h-8 font-code text-micro" value={data.hookUrl} aria-label="GitLab webhook URL" /><Button size="sm" onClick={() => copyText(data.hookUrl, 'URL copied')}><Copy className="size-3.5" />Copy</Button></div>
            {data.secret && <div className="flex gap-2"><input readOnly className="input h-8 font-code text-micro" value={data.secret} aria-label="Secret token" /><Button size="sm" onClick={() => copyText(data.secret, 'Secret copied')}><Copy className="size-3.5" />Copy</Button></div>}
            {isAdmin && (data.token ? (
              <p className="flex flex-wrap items-center gap-2 text-caption">Access token for <b>{data.token.login}</b> on {data.token.baseUrl}: merge requests show their pipeline.
                <Button size="sm" variant="ghost" onClick={() => run('/token', 'DELETE')}>Remove token</Button></p>
            ) : (
              <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run('/token', 'PUT', { token: token.trim(), baseUrl: base.trim() })) setToken(''); }}>
                <Field label="Access token (optional, read_api)"><input className="input w-64 font-code text-caption" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
                <Field label="GitLab address"><input className="input w-48" value={base} onChange={(e) => setBase(e.target.value)} /></Field>
                <Button type="submit" disabled={!token.trim()} className="mb-0.5">Save token</Button>
              </form>
            ))}
            {isAdmin && <Button size="sm" variant="ghost" onClick={async () => (await ask('Disconnect GitLab? Deliveries will be refused.')) && run('', 'DELETE')}>Disconnect</Button>}
          </>
        )}
      </div>
    </Section>
  );
}
