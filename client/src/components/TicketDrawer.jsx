import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  ArrowRightLeft, CalendarClock, CircleDot, FileText, GitBranch, GitPullRequest, Hash, History, Link2, Lock, Mail, MessageSquare, Paperclip, Pin,
  Repeat, Reply, Shapes, SignalHigh, Tag, Tags, Timer, Trash2, Upload, UserRound, X,
} from 'lucide-react';
import {
  Avatar as DsAvatar, IconButton, KeyChip, PriorityMark, STATUS_META, Select, Skeleton, StatusPill, TypeMark,
} from '../ds/core.jsx';
import { api, apiBlob } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { getSocket } from '../lib/socket.js';
import { qk, useTicket, useProjectLeave } from '../lib/queries.js';
import { leaveOn, shortDay } from '../lib/days.js';
import {
  PRIORITIES, TYPES, canEditTicket, fileSize, formatDateTime, roleAtLeast, timeAgo,
} from '../lib/format.js';
import { Avatar, Badge, Button, ConfirmDialog, Modal, Spinner, TypeIcon } from './ui.jsx';
import { Markdown } from './Markdown.jsx';
import Annotator from './Annotator.jsx';
import { SnoozeMenu, WatchButton, useTicketVisit } from './FollowControls.jsx';
import { AssigneeMenu, lightestOther, overloadMessage, useLoadByUser } from './AssigneeSelect.jsx';
import HandoffDialog from './HandoffDialog.jsx';
import PlanningPanel from './PlanningPanel.jsx';
import { SlaPills } from './AutomationSettings.jsx';
import { LabelSuggestions } from './SetupSettings.jsx';
import ErrorInsights from './ErrorInsights.jsx';
import { ReproPanel, StackFrames } from './BugTools.jsx';
import { GithubLinks } from './GithubTools.jsx';
import { MergeControl, ReportersPanel, RoadmapToggle, useReporters } from './OutsideTools.jsx';
import { FileActions, ScreenRecorder } from './DebugTools.jsx';
import { ask } from './confirm.jsx';
import { isNetworkError, loadDraft, queueComment, saveDraft, useOutbox } from '../lib/offline.js';
import { DateField, EmptyNote, InlineText, glassColour } from '../ds/core.jsx';

// A git branch for a ticket: fix/SC-12-coupon-field-rejects-valid-codes. The key stays in capitals
// so it can be matched back to the ticket; the title becomes a short ASCII slug cut at a word.
const BRANCH_PREFIX = { bug: 'fix', feature: 'feat', task: 'chore' };
export function branchName(ticket) {
  const words = ticket.title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const w of words) { if ((slug ? slug.length + 1 : 0) + w.length > 48) break; slug = slug ? `${slug}-${w}` : w; }
  return `${BRANCH_PREFIX[ticket.type] ?? 'chore'}/${ticket.key}${slug ? `-${slug}` : ''}`;
}

const isEditable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

// Shows an attachment that needs the login header (fetched as a blob).
function AuthImage({ path, alt, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    let objectUrl;
    apiBlob(path).then((b) => { if (!alive) return; objectUrl = URL.createObjectURL(b); setUrl(objectUrl); }).catch(() => {});
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return url ? <img src={url} alt={alt} className={className} /> : <div className={clsx('animate-pulse bg-hover', className)} />;
}

async function openFile(path, attachment) {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  if (attachment.contentType.startsWith('text/') || attachment.contentType === 'application/json') a.download = attachment.name;
  else a.target = '_blank';
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Attachments({ projectId, number, canUpload, isManager, userId, pendingFiles }) {
  const qc = useQueryClient();
  const base = `/projects/${projectId}/tickets/${number}/attachments`;
  const { data } = useQuery({ queryKey: qk.attachments(projectId, number), queryFn: () => api(base).then((d) => d.attachments) });
  const input = useRef(null);
  const upload = useMutation({
    mutationFn: (file) => { const form = new FormData(); form.append('file', file); return api(base, { method: 'POST', form }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.attachments(projectId, number) }),
    onError: (err) => toast.error(err.message),
  });
  const [removing, setRemoving] = useState(null);
  const remove = useMutation({
    mutationFn: (id) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); qc.invalidateQueries({ queryKey: qk.attachments(projectId, number) }); },
    onError: (err) => { setRemoving(null); toast.error(err.message); },
  });
  // Pictures go through the annotator first (box, arrow, blur); other files upload straight away.
  const [toMark, setToMark] = useState([]);
  const handle = (files) => {
    const list = [...files];
    for (const f of list.filter((x) => !x.type.startsWith('image/') || x.type === 'image/svg+xml')) upload.mutate(f);
    setToMark((q) => [...q, ...list.filter((x) => x.type.startsWith('image/') && x.type !== 'image/svg+xml')]);
  };
  const nextMark = (file) => {
    if (file) upload.mutate(file);
    setToMark((q) => q.slice(1));
  };
  useEffect(() => { if (pendingFiles?.length) handle(pendingFiles); }, [pendingFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data?.length && !canUpload) return null;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Paperclip className="size-3.5" />Files {data?.length ? `(${data.length})` : ''}</h3>
        {canUpload && (
          <>
            <span className="flex gap-1">
              <ScreenRecorder onRecorded={(file) => upload.mutate(file)} />
              <Button size="sm" variant="ghost" loading={upload.isPending} onClick={() => input.current.click()}><Upload className="size-3.5" />Add</Button>
            </span>
            <input ref={input} type="file" hidden multiple onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
          </>
        )}
      </div>
      {data?.length ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.map((a) => {
            const path = `${base}/${a.id}`;
            const image = a.contentType.startsWith('image/');
            const mine = a.uploader?.id === userId;
            return (
              <div key={a.id} className="group relative overflow-hidden rounded-tile border border-line">
                <button type="button" className="block w-full text-left" onClick={() => openFile(path, a).catch((e) => toast.error(e.message))}>
                  {image ? <AuthImage path={path} alt={a.name} className="h-24 w-full object-cover" />
                    : <div className="grid h-24 place-items-center bg-hover"><FileText className="size-7 text-fg-subtle" /></div>}
                  <div className="truncate px-2 py-1.5 text-caption">{a.name}<span className="ml-1 text-fg-subtle">{fileSize(a.size)}</span></div>
                </button>
                <FileActions a={a} path={path} />
                {canUpload && (mine || isManager) && (
                  <button type="button" onClick={() => setRemoving(a)} aria-label={`Remove ${a.name}`}
                    className="absolute right-1 top-1 hidden rounded-tile bg-overlay/90 p-1 text-fg group-hover:block"><X className="size-3" /></button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-tile border border-dashed border-line-strong px-3 py-4 text-center text-caption text-fg-subtle ">
          Drop a screenshot, log or .har file here, paste an image (Ctrl+V), or record your screen.
        </p>
      )}
      <ConfirmDialog open={!!removing} title="Delete this file?" busy={remove.isPending}
        onCancel={() => setRemoving(null)} onConfirm={() => remove.mutate(removing.id)}>
        <b>{removing?.name}</b> will be deleted for good. This can't be undone.
      </ConfirmDialog>
      {toMark[0] && <Annotator key={`${toMark[0].name}-${toMark.length}`} file={toMark[0]} onDone={nextMark} onCancel={() => nextMark(null)} />}
    </section>
  );
}

// Text box with an @-mention picker. Mentions are stored as @[Name](id).
function Composer({ members, onSubmit, initial = '', placeholder, onCancel, onTyping, busy, submitLabel = 'Comment', draftKey }) {
  // A draft is kept in this browser until it is sent (E14).
  const [text, setText] = useState(() => initial || loadDraft(draftKey));
  const [query, setQuery] = useState(null);
  const ref = useRef(null);
  const matches = query === null ? [] : members.filter((m) => m.user.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const onChange = (e) => {
    setText(e.target.value);
    saveDraft(draftKey, e.target.value);
    const before = e.target.value.slice(0, e.target.selectionStart);
    const m = /(?:^|\s)@([\p{L}\d ]{0,20})$/u.exec(before);
    setQuery(m ? m[1] : null);
    onTyping?.(true);
  };
  const pick = (member) => {
    const el = ref.current;
    const before = text.slice(0, el.selectionStart).replace(/@([\p{L}\d ]{0,20})$/u, `@[${member.user.name}](${member.user.id}) `);
    const next = before + text.slice(el.selectionStart);
    setText(next);
    saveDraft(draftKey, next);
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  };
  // Cleared at once (the comment is already showing above); put back if sending fails.
  const send = async () => {
    if (!text.trim()) return;
    const kept = text;
    setText('');
    saveDraft(draftKey, '');
    onTyping?.(false);
    try { await onSubmit(kept); } catch { setText(kept); saveDraft(draftKey, kept); }
  };
  return (
    <div className="relative">
      <textarea
        ref={ref}
        className="input min-h-20"
        rows={3}
        value={text}
        placeholder={placeholder}
        onChange={onChange}
        onBlur={() => onTyping?.(false)}
        onKeyDown={(e) => {
          if (matches.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pick(matches[0]); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
          if (e.key === 'Escape') setQuery(null);
        }}
      />
      {matches.length > 0 && (
        <ul className="card absolute left-2 top-full z-10 mt-1 w-56 overflow-hidden py-1 shadow-overlay">
          {matches.map((m) => (
            <li key={m.user.id}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(m); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-small hover:bg-hover">
                <Avatar user={m.user} size="sm" />{m.user.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-micro text-fg-subtle">@ to mention · Ctrl+Enter to send</span>
        {onCancel && <Button size="sm" onClick={onCancel}>Cancel</Button>}
        <Button size="sm" variant="primary" loading={busy} disabled={!text.trim()} onClick={send}>{submitLabel}</Button>
      </div>
    </div>
  );
}

function Comment({ c, userId, isManager, canComment, members, onReply, base, refresh, small, newSince, outside, canWork }) {
  const [editing, setEditing] = useState(false);
  const mine = c.author?.id === userId;
  // Written by someone else since my previous visit (catch me up).
  const fresh = Boolean(newSince) && !mine && new Date(c.createdAt) > new Date(newSince);
  const save = async (body) => {
    try { await api(`${base}/${c.id}`, { method: 'PATCH', body: { body } }); setEditing(false); refresh(); } catch (e) { toast.error(e.message); }
  };
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    setDeleting(true);
    try { await api(`${base}/${c.id}`, { method: 'DELETE' }); setConfirming(false); refresh(); } catch (e) { toast.error(e.message); } finally { setDeleting(false); }
  };
  const pin = async (on) => {
    try {
      await api(`${base}/${c.id}/pin`, { method: on ? 'PUT' : 'DELETE' });
      refresh();
      toast.success(on ? 'Pinned as a decision' : 'Removed from decisions');
    } catch (e) { toast.error(e.message); }
  };
  return (
    <div id={`comment-${c.id}`} className={clsx('flex scroll-mt-4 gap-2.5 transition-opacity duration-(--dur-base)', c.pending && 'opacity-60')} aria-busy={c.pending || undefined}>
      {c.author ? <Avatar user={c.author} size={small ? 'sm' : 'md'} /> : <span className="size-7 shrink-0 rounded-full bg-press" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-caption">
          <span className="font-semibold text-fg">{c.author?.name ?? (c.external?.source === 'reporter' ? `${c.external.login} (reporter)` : c.external?.source === 'github' ? <a href={c.external.url ?? undefined} target="_blank" rel="noreferrer" className="hover:underline">@{c.external.login} on GitHub</a> : 'Former member')}</span>
          {c.pending ? <span className="text-fg-subtle">Sending…</span> : <span className="text-fg-subtle" title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</span>}
          {c.editedAt && !c.deletedAt && <span className="text-fg-subtle">edited</span>}
          {fresh && <Badge tone="brand">new</Badge>}
          {c.kind === 'handoff' && <Badge tone="teal"><ArrowRightLeft className="size-3" />Handoff note</Badge>}
          {c.pinnedAt && !c.deletedAt && <Badge tone="amber"><Pin className="size-3" />Decision</Badge>}
          {/* On tickets from the public page, say who can see each comment. */}
          {outside && !c.deletedAt && (c.fromReporter
            ? <Badge tone="brand" title="Written on their tracking page"><Mail className="size-3" />From the reporter</Badge>
            : c.visibility === 'reporter'
            ? <Badge tone="teal" title={c.sentTo ? `Emailed to ${c.sentTo} on ${formatDateTime(c.sentAt)}` : 'Shown on their tracking page (they left no email)'}><Mail className="size-3" />Sent to reporter</Badge>
            : <span className="inline-flex items-center gap-0.5 text-fg-subtle" title="Only the team sees this"><Lock className="size-3" />Internal</span>)}
        </div>
        {c.deletedAt ? <p className="mt-1 text-small italic text-fg-subtle">This comment was deleted.</p>
          : editing ? <div className="mt-1"><Composer members={members} initial={c.body} onSubmit={save} onCancel={() => setEditing(false)} submitLabel="Save" /></div>
            : <Markdown text={c.body} className="mt-1" />}
        {!c.deletedAt && !editing && !c.pending && canComment && (
          <div className="mt-1 flex gap-3 text-caption text-fg-subtle">
            {onReply && <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={onReply}><Reply className="size-3" />Reply</button>}
            {mine && <button type="button" className="hover:text-fg" onClick={() => setEditing(true)}>Edit</button>}
            {canWork && <button type="button" className="hover:text-fg" onClick={() => pin(!c.pinnedAt)}>{c.pinnedAt ? 'Unpin decision' : 'Pin as decision'}</button>}
            {(mine || isManager) && <button type="button" className="hover:text-danger" onClick={() => setConfirming(true)}>Delete</button>}
          </div>
        )}
        <ConfirmDialog open={confirming} title="Delete this comment?" busy={deleting} onCancel={() => setConfirming(false)} onConfirm={remove}>
          The text is removed for everyone. Replies stay, under a "deleted comment" placeholder.
          {c.visibility === 'reporter' && ' It was already emailed to the reporter; deleting it here does not unsend that email.'}
        </ConfirmDialog>
      </div>
    </div>
  );
}

function Comments({ project, number, userId, canComment, onTyping, typingNames, newSince, contact, canWork }) {
  // On a ticket from the public page, a new top-level comment is either a team-only note or a
  // reply that is emailed to the reporter. Internal is always the default.
  const { data: reporters } = useReporters(project.id, number, canWork);
  const canReply = canWork && (Boolean(reporters?.length) || Boolean(contact?.email));
  const [mode, setMode] = useState('internal');
  const [trackerId, setTrackerId] = useState('');
  const target = reporters?.find((r) => r.id === trackerId) ?? reporters?.[0] ?? (contact?.email ? { name: contact.name, email: contact.email } : null);
  const where = !target ? '' : target.email ? `Emailed to ${target.email} and shown on their tracking page` : 'Shown on their tracking page (they left no email)';
  const toReporter = canReply && mode === 'reporter';
  const qc = useQueryClient();
  const base = `/projects/${project.id}/tickets/${number}/comments`;
  const { data, isLoading } = useQuery({ queryKey: qk.comments(project.id, number), queryFn: () => api(base).then((d) => d.comments) });
  const [replyTo, setReplyTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.comments(project.id, number) });
    qc.invalidateQueries({ queryKey: qk.history(project.id, number) });
  };
  const outbox = useOutbox().filter((i) => i.path === base);
  // The comment shows in the thread at once (faded, "Sending…"); if the server refuses it, it is
  // taken out again, the text goes back into the box (Composer) and the message says why.
  const post = async (body, parentId) => {
    setBusy(true);
    const visibility = !parentId && toReporter ? 'reporter' : 'internal';
    const payload = { body, ...(parentId && { parentId }), visibility, ...(visibility === 'reporter' && target?.id && { trackerId: target.id }) };
    const key = qk.comments(project.id, number);
    await qc.cancelQueries({ queryKey: key });
    const before = qc.getQueryData(key);
    const me = project.members.find((m) => m.user.id === userId)?.user;
    const temp = { id: `pending-${Date.now()}`, body, author: me, createdAt: new Date().toISOString(), replies: [], visibility, pending: true };
    qc.setQueryData(key, (list = []) => (parentId ? list.map((c) => (c.id === parentId ? { ...c, replies: [...c.replies, temp] } : c)) : [...list, temp]));
    try {
      await api(base, { method: 'POST', body: payload });
      setReplyTo(null);
      refresh();
      if (visibility === 'reporter') {
        toast.success(target?.email ? `Sent to ${target.email}` : 'Shown on their tracking page');
        setMode('internal');
      }
    } catch (e) {
      qc.setQueryData(key, before);
      // Offline: kept and sent when the connection is back (E14).
      if (isNetworkError(e)) {
        queueComment(base, payload, `#${number}`);
        setReplyTo(null);
        toast("You're offline. The comment will be sent when you're back online.");
        return;
      }
      toast.error(`Your comment wasn't posted: ${e.message} Your text is back in the box.`);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const isManager = roleAtLeast(project.myRole, 'manager');
  const common = { userId, isManager, canComment, members: project.members, base, refresh, newSince, outside: canReply || Boolean(contact?.email), canWork };
  return (
    <div className="space-y-5">
      {isLoading && <Spinner className="text-fg-subtle" />}
      {data?.length === 0 && <EmptyNote>No comments yet. Start the conversation below.</EmptyNote>}
      {data?.map((c) => (
        <div key={c.id} className="space-y-3">
          <Comment c={c} {...common} onReply={() => setReplyTo(c.id)} />
          {(c.replies.length > 0 || replyTo === c.id) && (
            <div className="ml-9 space-y-3 border-l-2 border-line pl-3 ">
              {c.replies.map((r) => <Comment key={r.id} c={r} {...common} small onReply={() => setReplyTo(c.id)} />)}
              {replyTo === c.id && <Composer members={project.members} placeholder="Reply…" busy={busy} onTyping={onTyping} onSubmit={(b) => post(b, c.id)} onCancel={() => setReplyTo(null)} submitLabel="Reply" draftKey={`${project.id}:${number}:reply:${c.id}`} />}
            </div>
          )}
        </div>
      ))}
      {typingNames.length > 0 && (
        <p role="status" className="flex items-center gap-2 text-caption text-fg-subtle">
          <span aria-hidden className="ds-typing flex items-end gap-0.5">{[0, 0.5, 1].map((t) => <span key={t} className="size-1.5 rounded-shard" style={{ background: glassColour(t) }} />)}</span>
          {typingNames.join(', ')} {typingNames.length > 1 ? 'are' : 'is'} typing
        </p>
      )}
      {canComment && canReply && (
        <div className="flex flex-wrap items-center gap-1 rounded-tile bg-hover p-1 text-caption " role="radiogroup" aria-label="Who sees this comment">
          {[['internal', Lock, 'Internal note', 'Only the team sees it'], ['reporter', Mail, 'Reply to reporter', where]].map(([key, Icon, label, hint]) => (
            <button key={key} type="button" role="radio" aria-checked={mode === key} onClick={() => setMode(key)} title={hint}
              className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded-tile px-2 py-1.5 font-medium',
                mode === key ? 'bg-raised text-fg shadow-raised ' : 'text-fg-subtle hover:text-fg')}>
              <Icon className="size-3.5" />{label}
            </button>
          ))}
        </div>
      )}
      {toReporter && (
        <p className="-mt-3 rounded-tile bg-success/10 px-2.5 py-2 text-caption text-success">
          {reporters?.length > 1 && (
            <select className="input mb-1.5 h-7 w-full py-0 text-caption" value={target?.id ?? ''} onChange={(e) => setTrackerId(e.target.value)} aria-label="Which reporter">
              {reporters.map((r) => <option key={r.id} value={r.id}>{r.name ?? 'No name'}{r.email ? ` (${r.email})` : ''}</option>)}
            </select>
          )}
          To <b>{target?.name ?? 'the reporter'}</b>{target?.email ? ` (${target.email})` : ''}: {where.toLowerCase()}. Mentions become plain names.
        </p>
      )}
      {outbox.length > 0 && <p className="text-caption text-warning" role="status">{outbox.length} comment{outbox.length === 1 ? '' : 's'} waiting to be sent when you're back online</p>}
      {canComment && (
        <Composer members={project.members} busy={busy} onTyping={onTyping} onSubmit={(b) => post(b)} draftKey={`${project.id}:${number}`}
          placeholder={toReporter ? 'Write your reply to the reporter…' : 'Write a comment…'}
          submitLabel={toReporter ? 'Send to reporter' : 'Comment'} />
      )}
    </div>
  );
}

// "Asha is on leave on the due day": a quiet warning, only for open tickets.
function AwayOnDue({ projectId, ticket, done }) {
  const day = ticket.dueDate;
  const { data: leave } = useProjectLeave(projectId, day, day, Boolean(day && ticket.assignee && !done));
  const away = ticket.assignee && day && !done && leaveOn(leave, ticket.assignee.id, day);
  if (!away) return null;
  return (
    <p className="-mt-1 mb-2 text-caption text-warning" role="status">
      {ticket.assignee.name} is on leave {shortDay(away.from)}–{shortDay(away.to)}{away.note ? ` (${away.note})` : ''}, which covers the due date.
    </p>
  );
}

// Who made a change: a person, or (with no person) where it came from.
function actorName(e) {
  if (e.actor) return e.actor.name;
  if (e.source === 'automation') return `Rule “${e.rule?.name ?? 'deleted rule'}”`;
  if (e.source === 'sla') return 'Service levels';
  if (e.source === 'sdk') return 'Your app (crash capture)';
  return e.source === 'github' ? 'GitHub' : e.source === 'portal' ? 'Public portal' : 'Tessera';
}

function describe(e, project) {
  const statusName = (k) => project.statuses.find((s) => s.key === k)?.name ?? k;
  const person = (id) => project.members.find((m) => m.user.id === id)?.user.name ?? 'a former member';
  switch (e.type) {
    case 'created': return e.source === 'import' ? 'created the ticket by importing a CSV file' : e.source === 'recurring' ? 'created the ticket from a recurring schedule' : 'created the ticket';
    case 'status_changed': return <>moved it from <b>{statusName(e.from)}</b> to <b>{statusName(e.to)}</b>{e.field === 'wip_override' && ' (over the WIP limit)'}</>;
    case 'assigned': return e.to ? <>assigned it to <b>{person(e.to)}</b></> : 'unassigned it';
    case 'updated':
      if (e.field?.startsWith('fields.')) {
        const def = (project.customFields ?? []).find((f) => `fields.${f.key}` === e.field);
        const show = (v) => (v === null || v === undefined ? 'none' : v === true ? 'yes' : v === false ? 'no' : String(v));
        return <>changed {def?.name ?? 'a removed field'} from <b>{show(e.from)}</b> to <b>{show(e.to)}</b></>;
      }
      if (e.field === 'description') return 'edited the description';
      if (e.field === 'title') return <>renamed it to <b>{e.to}</b></>;
      return <>changed {e.field === 'dueDate' ? 'the due date' : e.field === 'startDate' ? 'the start date' : e.field === 'storyPoints' ? 'story points' : e.field} from <b>{Array.isArray(e.from) ? e.from.join(', ') || 'none' : e.from ?? 'none'}</b> to <b>{Array.isArray(e.to) ? e.to.join(', ') || 'none' : e.to ?? 'none'}</b></>;
    case 'deleted': return 'moved it to the bin';
    case 'restored': return 'restored it';
    case 'commented': return e.to?.kind === 'handoff' ? 'left a handoff note' : 'commented';
    case 'decision_pinned': return <>pinned a decision{e.to?.excerpt && <>: <i>&ldquo;{e.to.excerpt}&rdquo;</i></>}</>;
    case 'decision_unpinned': return 'removed a decision';
    case 'attachment_added': return <>attached <b>{e.to?.name}</b></>;
    case 'attachment_removed': return <>removed <b>{e.from?.name}</b></>;
    case 'error_recurred': return <>reported the same error again ({e.to?.occurrences}×){e.to?.muted && ' while it was muted'}</>;
    case 'error_muted': return <>muted the error {e.to?.forever ? 'until someone unmutes it' : `until ${formatDateTime(e.to?.until)}`}{e.to?.reason && <>: <i>{e.to.reason}</i></>}</>;
    case 'error_unmuted': return e.to?.early ? 'unmuted the error' : 'cleared an expired mute';
    case 'linked': return <>linked {e.to?.kind === 'pull_request' ? 'pull request' : 'commit'} <a className="font-code text-accent underline " href={e.to?.url} target="_blank" rel="noreferrer">{e.to?.ref}</a></>;
    case 'triaged': return 'accepted it from triage';
    case 'relation_changed': return describeRelation(e);
    case 'blocked': return <>marked it blocked: <i>{e.to?.reason}</i></>;
    case 'unblocked': return 'unblocked it';
    case 'deployed': return <>shipped it to {e.to?.environment} in release <span className="font-code">{e.to?.release}</span></>;
    case 'error_unminified': return <>unminified the error with the source maps of {(e.to?.releases ?? []).join(', ')}</>;
    case 'error_spike': return <>saw a spike: <b>{e.to?.lastHour}</b> reports in an hour</>;
    case 'repro_updated':
      if (e.field === 'steps') return e.to?.empty ? 'cleared the steps to reproduce' : 'wrote the steps to reproduce';
      if (e.field === 'attempt_removed') return 'removed a reproduction attempt';
      return <>{e.to?.result === 'reproduced' ? 'reproduced it' : "couldn't reproduce it"}{e.to?.environment && <> on <i>{e.to.environment}</i></>}</>;
    case 'sla_breached': return <>marked it late: the <b>{e.field === 'response' ? 'first response' : 'resolution'}</b> target{e.to?.hours ? ` of ${e.to.hours} hours` : ''} was missed</>;
    default: return e.type;
  }
}

// Planning changes (E3): epic, parent, blockers (refs carry a key), sprint and milestone (a name).
function describeRelation(e) {
  const label = (r) => r?.key ?? r?.name;
  const from = label(e.from);
  const to = label(e.to);
  switch (e.field) {
    case 'epic': return to ? <>added it to epic <b>{to}</b></> : <>took it out of epic <b>{from}</b></>;
    case 'parent': return to ? <>made it a sub-task of <b>{to}</b></> : <>made it a top-level ticket again (was under <b>{from}</b>)</>;
    case 'blocked_by': return to ? <>marked it as waiting on <b>{to}</b></> : <>removed the wait on <b>{from}</b></>;
    case 'sprint':
      if (from && to) return <>moved it from <b>{from}</b> to <b>{to}</b></>;
      return to ? <>planned it into <b>{to}</b></> : <>moved it from <b>{from}</b> to the backlog</>;
    case 'milestone': return to ? <>set the milestone to <b>{to}</b>{from && <> (was {from})</>}</> : <>removed it from milestone <b>{from}</b></>;
    default: return 'changed its planning';
  }
}

// Pinned decisions, at the top of the ticket so nobody has to reread the thread to find them.
// Shares the comments query, so pinning or unpinning updates it straight away.
function Decisions({ projectId, number }) {
  const base = `/projects/${projectId}/tickets/${number}/comments`;
  const { data } = useQuery({ queryKey: qk.comments(projectId, number), queryFn: () => api(base).then((d) => d.comments) });
  const pinned = (data ?? []).flatMap((c) => [c, ...c.replies]).filter((c) => c.pinnedAt && !c.deletedAt)
    .sort((a, b) => new Date(a.pinnedAt) - new Date(b.pinnedAt));
  if (!pinned.length) return null;
  return (
    <section className="rounded-card border border-warning/30 bg-warning/8 p-3.5" aria-label="Decisions">
      <h3 className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-warning">
        <Pin className="size-3.5" />Decision{pinned.length === 1 ? '' : 's'} ({pinned.length})
      </h3>
      <ol className="mt-2 space-y-2.5">
        {pinned.map((c) => (
          <li key={c.id} className="text-small">
            <Markdown text={c.body} className="line-clamp-4" />
            <p className="mt-0.5 text-caption text-fg-subtle">
              {c.author?.name ?? 'Former member'}, pinned by {c.pinnedBy?.name ?? 'a former member'} {timeAgo(c.pinnedAt)} ·{' '}
              <button type="button" className="font-medium text-accent hover:underline "
                onClick={() => document.getElementById(`comment-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                Show in thread
              </button>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// "Since you last looked": what other people changed since my previous visit.
function CatchUp({ visit, project }) {
  const [all, setAll] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const shown = all ? visit.changes : visit.changes.slice(-4);
  const earlier = visit.changes.length - shown.length;
  return (
    <section className="rounded-card border border-line bg-surface p-3.5 text-small " aria-label="Changes since your last visit">
      <div className="flex items-center gap-2">
        <History className="size-4 text-accent" />
        <b className="font-semibold">Since you last looked</b>
        <span className="text-caption text-fg-subtle" title={formatDateTime(visit.previousVisit)}>{timeAgo(visit.previousVisit)}</span>
        <button type="button" className="ml-auto text-fg-subtle hover:text-fg" onClick={() => setHidden(true)} aria-label="Hide"><X className="size-4" /></button>
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.map((e) => (
          <li key={e.id} className="flex gap-2 text-fg-muted">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
            <span>
              <b className="font-medium text-fg">{actorName(e)}</b>{' '}
              {describe(e, project)}
              <span className="ml-1.5 text-caption text-fg-subtle">{timeAgo(e.at)}</span>
            </span>
          </li>
        ))}
      </ul>
      {(earlier > 0 || visit.more > 0) && (
        <button type="button" className="mt-2 text-caption font-semibold text-accent" onClick={() => setAll(true)} hidden={all && !visit.more}>
          {all ? `and ${visit.more} more in Activity` : `Show ${earlier} earlier change${earlier === 1 ? '' : 's'}`}
        </button>
      )}
    </section>
  );
}

function Activity({ project, number }) {
  const { data } = useQuery({
    queryKey: qk.history(project.id, number),
    queryFn: () => api(`/projects/${project.id}/tickets/${number}/history`).then((d) => d.events),
  });
  if (!data) return <Spinner className="text-fg-subtle" />;
  return (
    <ol className="space-y-3">
      {[...data].reverse().map((e) => (
        <li key={e.id} className="flex gap-2.5 text-small">
          {e.actor ? <Avatar user={e.actor} size="sm" /> : <span className="grid size-5 place-items-center rounded-full bg-press text-micro text-fg-muted ">{e.source === 'github' ? <GitPullRequest className="size-3" /> : '•'}</span>}
          <span className="text-fg-muted">
            <b className="font-medium text-fg">{actorName(e)}</b>{' '}
            {describe(e, project)}
            <span className="ml-1.5 text-caption text-fg-subtle" title={formatDateTime(e.at)}>{timeAgo(e.at)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ErrorPanel({ error, pid, ticket, canWork }) {
  const [all, setAll] = useState(false);
  const frames = all ? error.frames : error.frames.slice(0, 6);
  return (
    <section className="rounded-card border border-danger/25 bg-danger/6 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-code text-small font-semibold text-danger">{error.type ?? 'Error'}</span>
        <Badge tone="red"><Repeat className="size-3" />{error.occurrences}× · last {timeAgo(error.lastSeenAt)}</Badge>
        <Badge>{error.language}</Badge>
        {error.environment && <Badge tone="teal">{[error.environment.browser, error.environment.os].filter(Boolean).join(' on ')}</Badge>}
        {error.muted?.active && <Badge>Muted</Badge>}
      </div>
      {error.message && <p className="mt-1.5 break-words font-code text-caption text-danger">{error.message}</p>}
      <StackFrames frames={frames} error={error} pid={pid} ticket={ticket} canWork={canWork} />
      {error.frames.length > 6 && <button type="button" className="mt-2 text-caption text-danger underline " onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${error.frames.length} frames`}</button>}
      <ErrorInsights pid={pid} ticket={ticket} canWork={canWork} />
    </section>
  );
}

// One custom field's editor, by type. Text-like values save when the box loses focus.
function CustomFieldInput({ def, value, disabled, onSave }) {
  const common = { className: 'input h-8 text-caption', disabled, 'aria-label': def.name };
  if (def.type === 'select') {
    return (
      <select {...common} value={value ?? ''} onChange={(e) => onSave(e.target.value || null)}>
        <option value="">None</option>
        {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (def.type === 'checkbox') {
    return <input type="checkbox" className="size-4 accent-accent" checked={value === true} disabled={disabled} aria-label={def.name} onChange={(e) => onSave(e.target.checked)} />;
  }
  if (def.type === 'date') return <DateField value={value} disabled={disabled} aria-label={def.name} onChange={onSave} />;
  const toValue = (v) => (v.trim() === '' ? null : def.type === 'number' ? Number(v) : v.trim());
  return (
    <div className="flex items-center gap-1">
      <input
        key={String(value ?? '')} {...common} type={def.type === 'number' ? 'number' : def.type === 'url' ? 'url' : 'text'}
        defaultValue={value ?? ''} placeholder="—" maxLength={500}
        onBlur={(e) => { const v = toValue(e.target.value); if (v !== (value ?? null)) onSave(v); }}
      />
      {def.type === 'url' && value && <a href={value} target="_blank" rel="noreferrer noopener" className="shrink-0 text-caption text-accent underline ">Open</a>}
    </div>
  );
}

// One property: an icon and a name on the left, its control on the right.
function Row({ label, icon: Icon = Tag, children }) {
  return (
    <div className="grid min-h-9 grid-cols-[6.5rem_1fr] items-start gap-2 py-0.5 compact:min-h-8 compact:py-0">
      <span className="flex h-8 items-center gap-2 text-caption text-fg-subtle">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// While the ticket loads: the shape of the drawer, not a spinner.
function DrawerSkeleton() {
  return (
    <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_17rem]" aria-busy="true" aria-label="Loading the ticket">
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="hidden space-y-3 border-l border-line bg-sunken p-5 lg:block">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7" />)}
      </div>
    </div>
  );
}

export default function TicketDrawer({ project, number, userId, onClose }) {
  const qc = useQueryClient();
  const pid = project.id;
  const { data: ticket, error, isLoading } = useTicket(pid, number);
  const [tab, setTab] = useState('comments');
  // false, or the ticket's updatedAt when editing began (E10 edit conflict protection).
  const [editingDesc, setEditingDesc] = useState(false);
  // The project's labels are suggested only while labels are being edited (not listed all the time).
  const [labelsOpen, setLabelsOpen] = useState(false);
  const titleBase = useRef(null);
  const [conflict, setConflict] = useState(null);
  const navigate = useNavigate();
  const [viewers, setViewers] = useState([]);
  const [typing, setTyping] = useState({});
  const [dropped, setDropped] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "Since you last looked", Watch and Snooze for this ticket (recorded once per opening).
  const [visit, patchVisit] = useTicketVisit(pid, number, Boolean(ticket));
  // Picking someone who is already heavy or overloaded asks first (the picker saves straight away).
  const [busyPick, setBusyPick] = useState(null);
  // Moving a ticket from one owner to another asks for a handoff note (optional).
  const [handoff, setHandoff] = useState(null);

  const archived = Boolean(project.archivedAt);
  const canEdit = !archived && canEditTicket(project, ticket, userId);
  const isDev = !archived && roleAtLeast(project.myRole, 'developer');
  const isManager = roleAtLeast(project.myRole, 'manager');
  const canComment = !archived;
  const status = project.statuses.find((s) => s.key === ticket?.status);
  const workers = project.members.filter((m) => m.role !== 'viewer');

  // Presence and typing for this ticket.
  const lastTyping = useRef(0);
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const timers = {};
    // A drawer opened straight from a link mounts before the page has joined the project's room
    // (child effects run first), and the server refuses a view until then. So join and ask again:
    // joining twice is harmless. Without this, presence silently never registered on deep links.
    const view = () => socket.emit('ticket:view', { projectId: pid, number }, (r) => {
      if (r?.ok) { setViewers(r.users); return; }
      if (r?.error !== 'join_project_first') return;
      socket.emit('project:join', pid, (j) => {
        if (j?.ok) socket.emit('ticket:view', { projectId: pid, number }, (again) => { if (again?.ok) setViewers(again.users); });
      });
    });
    const onPresence = (p) => { if (p.projectId === pid && p.number === number) setViewers(p.users); };
    const onTyping = (p) => {
      if (p.projectId !== pid || p.number !== number || p.user.id === userId) return;
      setTyping((t) => ({ ...t, [p.user.id]: p.typing ? p.user.name : undefined }));
      clearTimeout(timers[p.user.id]);
      if (p.typing) timers[p.user.id] = setTimeout(() => setTyping((t) => ({ ...t, [p.user.id]: undefined })), 6000);
    };
    view();
    socket.on('connect', view);
    socket.on('presence', onPresence);
    socket.on('typing', onTyping);
    return () => {
      socket.emit('ticket:unview');
      socket.off('connect', view);
      socket.off('presence', onPresence);
      socket.off('typing', onTyping);
      Object.values(timers).forEach(clearTimeout);
    };
  }, [pid, number, userId]);
  const emitTyping = (on) => {
    const now = Date.now();
    if (on && now - lastTyping.current < 2500) return;
    lastTyping.current = on ? now : 0;
    getSocket()?.emit('ticket:typing', { typing: on });
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !isEditable(document.activeElement)) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const afterChange = (t) => {
    qc.setQueryData(qk.ticket(pid, number), t);
    qc.invalidateQueries({ queryKey: qk.tickets(pid) });
    qc.invalidateQueries({ queryKey: qk.history(pid, number) });
    qc.invalidateQueries({ queryKey: qk.workload(pid) });
    // A handoff note arrives as a new comment.
    qc.invalidateQueries({ queryKey: qk.comments(pid, number) });
  };
  // Edits show at once; the server's answer replaces the guess, and a refusal puts the ticket back
  // exactly as it was, with a message that names what didn't save.
  const FIELD_NAMES = { title: 'the title', description: 'the description', status: 'the status', priority: 'the priority', type: 'the type', assigneeId: 'the assignee', dueDate: 'the due date', startDate: 'the start date', storyPoints: 'the points', labels: 'the labels', fields: 'that field' };
  const update = useMutation({
    mutationFn: (changes) => api(`/projects/${pid}/tickets/${number}`, { method: 'PATCH', body: changes }),
    onMutate: async (changes) => {
      const key = qk.ticket(pid, number);
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData(key);
      if (before) {
        const guess = { ...before, ...changes };
        if ('assigneeId' in changes) guess.assignee = changes.assigneeId ? project.members.find((m) => m.user.id === changes.assigneeId)?.user ?? before.assignee : null;
        if (changes.fields) guess.fields = { ...before.fields, ...changes.fields };
        qc.setQueryData(key, guess);
      }
      return { before };
    },
    onSuccess: (d) => afterChange(d.ticket),
    onError: (err, changes, saved) => {
      if (saved?.before) qc.setQueryData(qk.ticket(pid, number), saved.before);
      if (err.code === 'edit_conflict') {
        qc.invalidateQueries({ queryKey: qk.ticket(pid, number) });
        setConflict({ message: err.message, fields: err.details.fields, theirs: err.details.current, mine: changes });
      } else if (err.code === 'wip_limit' && isManager) {
        ask(`${err.message}\n\nMove it anyway? The override is recorded in the history.`, { confirmLabel: 'Move anyway' })
          .then((ok) => ok && update.mutate({ ...changes, overrideWip: true }));
      } else {
        const what = FIELD_NAMES[Object.keys(changes).find((k) => FIELD_NAMES[k])] ?? 'the change';
        toast.error(`Couldn't save ${what}: ${err.message} It's back to how it was.`);
      }
    },
  });
  // Resolves true when saved, false when refused (onError has already said why), for the "Saved" tick.
  const save = (changes) => update.mutateAsync(changes).then(() => true, () => false);

  const remove = async () => {
    try {
      await api(`/projects/${pid}/tickets/${number}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: qk.tickets(pid) });
      onClose();
      toast((tt) => (
        <span className="flex items-center gap-3">Moved {ticket.key} to the bin
          <button type="button" className="font-semibold text-accent" onClick={async () => {
            toast.dismiss(tt.id);
            try { await api(`/projects/${pid}/tickets/${number}/restore`, { method: 'POST' }); qc.invalidateQueries({ queryKey: qk.tickets(pid) }); } catch (e) { toast.error(e.message); }
          }}>Undo</button>
        </span>
      ), { duration: 8000 });
    } catch (e) { toast.error(e.message); }
  };

  const typingNames = Object.values(typing).filter(Boolean);
  const others = viewers.filter((v) => v.id !== userId);
  const canDelete = !archived && (isManager || (isDev && ticket?.reporter?.id === userId));
  const load = useLoadByUser(pid);
  const descRef = useRef(null);
  const labelText = useMemo(() => ticket?.labels.join(', ') ?? '', [ticket]);

  // Focus moves into the drawer when it opens and back to where it was when it closes.
  const panel = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => { if (before instanceof HTMLElement && document.contains(before)) before.focus(); };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div aria-hidden className="ds-fade absolute inset-0 bg-canvas/60 backdrop-blur-sm" onClick={onClose} />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className="ds-drawer-right relative flex h-full w-full max-w-4xl flex-col bg-surface shadow-overlay outline-none sm:rounded-l-panel"
        style={{ viewTransitionName: 'ticket' }}
        aria-label={ticket ? `${ticket.key} ${ticket.title}` : 'Ticket'}
        onPaste={(e) => { const files = [...e.clipboardData.files]; if (isDev && files.length) setDropped(files); }}
        onDragOver={(e) => { if (isDev) e.preventDefault(); }}
        onDrop={(e) => { if (!isDev) return; e.preventDefault(); const files = [...e.dataTransfer.files]; if (files.length) setDropped(files); }}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 sm:px-5">
          {ticket && <TypeMark type={ticket.type} />}
          <KeyChip data-no-preview>{ticket?.key ?? `#${number}`}</KeyChip>
          {status && <StatusPill status={status.category} label={status.name} size="sm" />}
          {ticket?.deletedAt && <Badge tone="red">In the bin</Badge>}
          {ticket?.triage && <Badge tone="amber">Triage</Badge>}
          {ticket?.duplicateOf && <Badge>Duplicate of {ticket.duplicateOf}</Badge>}
          {others.length > 0 && (
            <span className="ml-1 flex items-center gap-2 text-caption text-fg-subtle">
              <span className="flex -space-x-1.5">{others.map((o) => <DsAvatar key={o.id} name={o.name} id={o.id} size="sm" presence />)}</span>
              <span>{others.length === 1 ? `${others[0].name.split(' ')[0]} is here` : `${others.length} others here`}</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label="Copy link" icon={Link2} size="sm" onClick={() => copyText(window.location.href, 'Link copied')} />
            {ticket && visit && <WatchButton base={`/projects/${pid}/tickets/${number}`} watching={visit.watching} onChange={(watching) => patchVisit({ watching })} />}
            {ticket && visit && !ticket.deletedAt && <SnoozeMenu base={`/projects/${pid}/tickets/${number}`} snoozedUntil={visit.snoozedUntil} onChange={(snoozedUntil) => patchVisit({ snoozedUntil })} />}
            {ticket && (
              <IconButton label="Copy branch name" icon={GitBranch} size="sm"
                onClick={() => { const name = branchName(ticket); copyText(name, <span>Copied <code className="font-code text-caption">{name}</code></span>); }} />
            )}
            {canDelete && ticket && !ticket.deletedAt && <IconButton label="Delete ticket" icon={Trash2} size="sm" onClick={() => setConfirmDelete(true)} />}
            <IconButton label="Close" shortcut="Esc" icon={X} size="sm" onClick={onClose} />
          </div>
        </header>

        {isLoading && <DrawerSkeleton />}
        {error && <div className="grid flex-1 place-items-center p-8 text-center text-small text-fg-subtle">{error.status === 404 ? 'This ticket does not exist in this project.' : error.message}</div>}

        {ticket && (
          <div className="ds-scroll grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1fr_17rem]">
            <div className="min-w-0 space-y-6 p-4 sm:p-6">
              {visit?.changes?.length > 0 && <CatchUp visit={visit} project={project} />}
              <Decisions projectId={pid} number={number} />
              {/* Edited where it stands: Enter saves, Escape puts it back, a tick says it saved. */}
              <InlineText
                value={ticket.title}
                label="Title"
                required
                readOnly={!canEdit}
                maxLength={200}
                className="field-sizing-content -mx-1.5 w-[calc(100%+0.75rem)] resize-none rounded-tile bg-transparent px-1.5 py-0.5 text-h2 font-semibold tracking-tight text-fg sm:text-h1 outline-none transition-colors duration-(--dur-fast) hover:bg-hover focus:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                onFocus={() => { titleBase.current = ticket.updatedAt; }}
                onSave={(v) => save({ title: v, expectedUpdatedAt: titleBase.current ?? ticket.updatedAt })}
              />

              <section>
                {editingDesc ? (
                  <div className="space-y-2">
                    <textarea ref={descRef} className="input font-code text-caption" rows={10} defaultValue={ticket.description} autoFocus />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setEditingDesc(false)}>Cancel</Button>
                      <Button size="sm" variant="primary" onClick={() => { save({ description: descRef.current.value, expectedUpdatedAt: editingDesc }); setEditingDesc(false); }}>Save</Button>
                    </div>
                  </div>
                ) : ticket.description ? (
                  <div className={clsx(canEdit && 'cursor-text rounded-tile p-1 -m-1 hover:bg-hover')} onDoubleClick={() => canEdit && setEditingDesc(ticket.updatedAt)}>
                    <Markdown text={ticket.description} />
                    {canEdit && <button type="button" className="mt-2 text-caption text-fg-subtle hover:text-fg" onClick={() => setEditingDesc(ticket.updatedAt)}>Edit description</button>}
                  </div>
                ) : canEdit ? (
                  <button type="button" onClick={() => setEditingDesc(ticket.updatedAt)} className="ds-focus -mx-1 w-[calc(100%+0.5rem)] rounded-tile px-1 py-1 text-left text-body text-fg-subtle transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg-muted">Add a description…</button>
                ) : <EmptyNote>No description.</EmptyNote>}
              </section>

              <PlanningPanel project={project} number={number} ticket={ticket} canEdit={canEdit && !ticket.deletedAt} canWork={isDev && !ticket.deletedAt} />

              {ticket.error && <ErrorPanel error={ticket.error} pid={pid} ticket={ticket} canWork={isDev && !ticket.deletedAt} />}

              {(ticket.type === 'bug' || ticket.error) && <ReproPanel project={project} ticket={ticket} canWork={isDev && !ticket.deletedAt} userId={userId} />}

              <GithubLinks project={project} ticket={ticket} canWork={isDev && !ticket.deletedAt} />

              <ReportersPanel pid={pid} number={number} enabled={isDev && (ticket.source === 'portal' || Boolean(ticket.contact))} />

              {isDev && !ticket.deletedAt && (
                <div className="flex flex-wrap items-center gap-2">
                  {!ticket.duplicateOf && <MergeControl project={project} ticket={ticket} onMerged={() => qc.invalidateQueries({ queryKey: qk.ticket(pid, number) })} />}
                  {isManager && <RoadmapToggle key={ticket.id} project={project} ticket={ticket} />}
                  <Button size="sm" onClick={async () => {
                    try { await api(`/projects/${pid}/poker`, { method: 'POST', body: { ticket: String(number) } }); navigate(`/projects/${pid}/together?tab=poker`); } catch (e) { toast.error(e.message); }
                  }}>Estimate together</Button>
                </div>
              )}

              <Attachments projectId={pid} number={number} canUpload={isDev && !ticket.deletedAt} isManager={isManager} userId={userId} pendingFiles={dropped} />

              <section>
                <div role="tablist" aria-label="Conversation" className="mb-5 flex gap-1 border-b border-line"
                  onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = tab === 'comments' ? 'activity' : 'comments'; setTab(next); document.getElementById(`drawer-tab-${next}`)?.focus(); } }}>
                  {[['comments', 'Comments', MessageSquare], ['activity', 'Activity', History]].map(([t, label, Icon]) => (
                    <button key={t} id={`drawer-tab-${t}`} type="button" role="tab" aria-selected={tab === t} aria-controls="drawer-tabpanel" tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}
                      className={clsx('ds-focus relative mb-1 inline-flex h-8 items-center gap-1.5 rounded-tile px-2.5 text-small font-medium transition-colors duration-(--dur-fast)', tab === t ? 'text-fg' : 'text-fg-subtle hover:bg-hover hover:text-fg')}>
                      <Icon className="size-4" aria-hidden />{label}
                      {tab === t && <span aria-hidden className="absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-fg" />}
                    </button>
                  ))}
                </div>
                <div id="drawer-tabpanel" role="tabpanel" aria-labelledby={`drawer-tab-${tab}`}>
                {tab === 'comments'
                  ? <Comments project={project} number={number} userId={userId} newSince={visit?.previousVisit} contact={ticket.contact} canWork={isDev && !ticket.deletedAt} canComment={canComment && !ticket.deletedAt} onTyping={emitTyping} typingNames={typingNames} />
                  : <Activity project={project} number={number} />}
                </div>
              </section>
            </div>

            <aside aria-label="Properties" className="border-t border-line bg-sunken/60 p-4 sm:p-5 lg:border-l lg:border-t-0">
              <Row label="Status" icon={CircleDot}>
                <Select size="sm" aria-label="Status" value={ticket.status} disabled={!isDev || Boolean(ticket.deletedAt)} onChange={(v) => save({ status: v })}
                  options={project.statuses.map((s) => {
                    const meta = STATUS_META[s.category] ?? STATUS_META.todo;
                    return { value: s.key, label: s.name, leading: <meta.Icon className={clsx('size-3.5 shrink-0', meta.tone)} strokeWidth={2.25} aria-hidden /> };
                  })} />
              </Row>
              <Row label="Assignee" icon={UserRound}>
                {canEdit ? (
                  <AssigneeMenu aria-label="Assignee" className="w-full" projectId={pid} workers={workers} value={ticket.assignee?.id ?? ''}
                    onChange={(id) => {
                      const member = workers.find((m) => m.user.id === id);
                      const message = member && overloadMessage(load.get(id), member.user.name);
                      const alt = message ? lightestOther(load, workers, id) : null;
                      if (member && ticket.assignee && ticket.assignee.id !== id) setHandoff({ id, name: member.user.name, message, alt });
                      else if (message) setBusyPick({ id, name: member.user.name, message, alt });
                      else save({ assigneeId: id || null });
                    }} />
                ) : ticket.assignee ? (
                  <span className="flex items-center gap-2 text-small"><Avatar user={ticket.assignee} size="sm" />{ticket.assignee.name}</span>
                ) : isDev ? (
                  <Button size="sm" onClick={() => save({ assigneeId: userId })}>Assign to me</Button>
                ) : <span className="text-small text-fg-subtle">Unassigned</span>}
              </Row>
              <Row label="Priority" icon={SignalHigh}>
                <Select size="sm" aria-label="Priority" value={ticket.priority} disabled={!canEdit} onChange={(v) => save({ priority: v })}
                  options={PRIORITIES.map((p) => ({ value: p.key, label: p.label, leading: <PriorityMark priority={p.key} /> }))} />
              </Row>
              <Row label="Type" icon={Shapes}>
                <Select size="sm" aria-label="Type" value={ticket.type} disabled={!canEdit} onChange={(v) => save({ type: v })}
                  options={TYPES.map((t) => ({ value: t.key, label: t.label, leading: <TypeMark type={t.key} /> }))} />
              </Row>
              <Row label="Start" icon={CalendarClock}>
                <DateField value={ticket.startDate} max={ticket.dueDate ?? undefined} disabled={!canEdit} aria-label="Start date" onChange={(startDate) => save({ startDate })} />
              </Row>
              <Row label="Due" icon={CalendarClock}>
                <DateField value={ticket.dueDate} min={ticket.startDate ?? undefined} disabled={!canEdit} aria-label="Due date" onChange={(dueDate) => save({ dueDate })} />
              </Row>
              <AwayOnDue projectId={pid} ticket={ticket} done={status?.category === 'done'} />
              {ticket.sla && <Row label="SLA" icon={Timer}><SlaPills sla={ticket.sla} /></Row>}
              <Row label="Points" icon={Hash}>
                <InlineText as="input" type="number" min="0" max="100" step="0.5" className="input h-8 pr-16 text-caption" value={ticket.storyPoints} label="Story points" disabled={!canEdit} placeholder="—"
                  format={(v) => (v ?? '')} parse={(v) => (v.trim() === '' ? null : Number(v))} tickClassName="absolute right-2 top-1/2 -translate-y-1/2"
                  onSave={(v) => save({ storyPoints: v })} />
              </Row>
              {(project.customFields ?? []).map((def) => (
                <Row key={def.key} label={def.name}>
                  <CustomFieldInput def={def} value={ticket.fields?.[def.key] ?? null} disabled={!canEdit} onSave={(v) => save({ fields: { [def.key]: v } })} />
                </Row>
              ))}
              <Row label="Labels" icon={Tags}>
                <div onFocus={() => setLabelsOpen(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setLabelsOpen(false); }}>
                <InlineText as="input" className="input h-8 pr-16 text-caption" value={labelText} label="Labels" disabled={!canEdit} placeholder="Add labels" tickClassName="absolute right-2 top-1/2 -translate-y-1/2"
                  parse={(v) => v.split(',').map((l) => l.trim()).filter(Boolean).join(', ')}
                  onSave={(v) => save({ labels: v ? v.split(', ') : [] })} />
                {canEdit && labelsOpen && <LabelSuggestions projectId={pid} current={ticket.labels} onAdd={(l) => save({ labels: [...ticket.labels, l] })} />}
                </div>
              </Row>
              <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-caption text-fg-subtle ">
                <p>Reported by {ticket.reporter?.name ?? (ticket.source === 'portal' ? `${ticket.contact?.name ?? 'someone'} via the public portal` : ticket.source === 'sdk' ? 'your app, through crash capture' : 'a former member')}</p>
                {ticket.contact?.email && <p>Contact: {ticket.contact.email}</p>}
                <p>Created {formatDateTime(ticket.createdAt)}</p>
                <p>Updated {timeAgo(ticket.updatedAt)}</p>
                {ticket.resolvedAt && status?.category === 'done' && <p>Done {formatDateTime(ticket.resolvedAt)}</p>}
              </div>
            </aside>
          </div>
        )}
      </aside>
      <ConfirmDialog open={!!busyPick} title={`Assign ${busyPick?.name}?`} confirmLabel="Assign anyway"
        onCancel={() => setBusyPick(null)} onConfirm={() => { save({ assigneeId: busyPick.id }); setBusyPick(null); }}>
        <p>{busyPick?.message}</p>
        {busyPick?.alt && (
          <p className="mt-3">
            Lightest load right now: <b>{busyPick.alt.member.user.name}</b> ({busyPick.alt.row.open} open).{' '}
            <button type="button" className="font-semibold text-accent underline underline-offset-2 "
              onClick={() => { save({ assigneeId: busyPick.alt.member.user.id }); setBusyPick(null); }}>
              Assign {busyPick.alt.member.user.name} instead
            </button>
          </p>
        )}
      </ConfirmDialog>
      <HandoffDialog handoff={handoff} fromName={ticket?.assignee?.name} onCancel={() => setHandoff(null)}
        onConfirm={(assigneeId, note) => { save({ assigneeId, ...(note && { handoffNote: note }) }); setHandoff(null); }} />
      <Modal open={Boolean(conflict)} wide title="Someone else changed this ticket" onClose={() => setConflict(null)}
        footer={conflict && (
          <>
            <Button onClick={() => setConflict(null)}>Keep theirs</Button>
            <Button variant="primary" onClick={() => { const { expectedUpdatedAt, ...mine } = conflict.mine; save(mine); setConflict(null); }}>Save mine over it</Button>
          </>
        )}>
        {conflict && (
          <div className="space-y-3 text-small">
            <p>{conflict.message}. Nothing was overwritten.</p>
            {conflict.fields.filter((f) => f in conflict.mine).map((f) => (
              <div key={f} className="grid gap-2 sm:grid-cols-2">
                <div><p className="mb-1 text-caption font-medium text-fg-subtle">Their {f}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-tile bg-hover p-2 text-caption ">{String(conflict.theirs[f] ?? '(empty)')}</pre></div>
                <div><p className="mb-1 text-caption font-medium text-fg-subtle">Your {f}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-tile bg-hover p-2 text-caption ">{String(conflict.mine[f] ?? '(empty)')}</pre></div>
              </div>
            ))}
          </div>
        )}
      </Modal>
      <ConfirmDialog open={confirmDelete} title={`Delete ${ticket?.key ?? 'this ticket'}?`} confirmLabel="Move to bin"
        onCancel={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); remove(); }}>
        <b>{ticket?.title}</b> goes to the bin. Managers can restore it from the list view&apos;s bin.
      </ConfirmDialog>
    </div>
  );
}
