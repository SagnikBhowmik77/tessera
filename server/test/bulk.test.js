// Bulk edit, CSV export and CSV import (E4A), against a throwaway MongoDB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { Notification, Project, Ticket, TicketEvent } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); });
after(() => t.stop());

let keyN = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const dev = await t.signUp('Dev Kumar');
  const viewer = await t.signUp('Viewer');
  keyN += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Bulk', key: `BK${keyN}` } });
  await Project.updateOne({ _id: body.project.id }, {
    $push: { members: { $each: [{ user: dev.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } },
  });
  const base = `/api/projects/${body.project.id}`;
  const url = `${base}/tickets`;
  const mk = async (title, extra = {}, who = admin) => (await t.api('POST', url, { token: who.token, body: { title, ...extra } })).body.ticket;
  const upload = async (csv, query = '', who = admin) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'tickets.csv');
    const res = await fetch(`${t.base}${url}/import${query}`, { method: 'POST', headers: { authorization: `Bearer ${who.token}` }, body: form });
    return { status: res.status, body: await res.json() };
  };
  return { admin, dev, viewer, base, url, mk, upload };
}

test('csv: quotes, commas, line breaks and a byte-order mark survive a round trip; formulas are defused', () => {
  const rows = [['Title', 'Description'], ['Pay, then ship', 'Line one\nLine "two"'], ['=HYPERLINK("x")', '@sum']];
  const text = toCsv(rows);
  assert.ok(text.startsWith('﻿'));
  const back = parseCsv(text);
  assert.deepEqual(back[1], ['Pay, then ship', 'Line one\nLine "two"']);
  assert.deepEqual(back[2], ["'=HYPERLINK(\"x\")", "'@sum"], 'a spreadsheet shows these as text instead of running them');
  assert.throws(() => parseCsv('a,"b\n'), /never closed/);
});

test('bulk edit: many tickets at once, per-ticket permissions, failures reported, the rest still done', async () => {
  const { admin, dev, viewer, url, mk } = await team();
  const a = await mk('Card form', { labels: ['ui'] });
  const b = await mk('3-D Secure', { labels: ['ui', 'old'] });
  const c = await mk('Receipts', {}, dev); // reported by the developer
  const nums = [a.number, b.number, c.number];

  assert.equal((await t.api('POST', `${url}/bulk`, { token: viewer.token, body: { tickets: nums, changes: { priority: 'high' } } })).status, 403);
  assert.equal((await t.api('POST', `${url}/bulk`, { token: admin.token, body: { tickets: nums, changes: {} } })).status, 400);

  const res = await t.api('POST', `${url}/bulk`, {
    token: admin.token,
    body: { tickets: nums, changes: { priority: 'high', status: 'in_progress', assigneeId: dev.user.id, addLabels: ['payments'], removeLabels: ['old'] } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.done, 3);
  const got = await Ticket.find({ _id: { $in: [a.id, b.id, c.id] } }).sort({ number: 1 }).lean();
  assert.deepEqual(got.map((x) => [x.priority, x.status, String(x.assignee), [...x.labels].sort().join(',')]), [
    ['high', 'in_progress', dev.user.id, 'payments,ui'],
    ['high', 'in_progress', dev.user.id, 'payments,ui'],
    ['high', 'in_progress', dev.user.id, 'payments'],
  ]);
  // Same history as editing one by one.
  assert.ok(await TicketEvent.exists({ ticket: a.id, type: 'status_changed', to: 'in_progress' }));

  // A developer changes tickets they reported or are assigned to; the others are reported back.
  const other = await mk('Not theirs');
  const mixed = await t.api('POST', `${url}/bulk`, { token: dev.token, body: { tickets: [c.number, other.number, 9999], changes: { priority: 'low' } } });
  assert.equal(mixed.body.done, 1);
  assert.deepEqual(mixed.body.failed.map((f) => [f.number, f.code]), [[other.number, 'forbidden'], [9999, 'ticket_not_found']]);

  // Delete and restore in bulk; a binned ticket can't be edited.
  assert.equal((await t.api('POST', `${url}/bulk`, { token: admin.token, body: { tickets: [a.number, b.number], action: 'delete' } })).body.done, 2);
  const upd = await t.api('POST', `${url}/bulk`, { token: admin.token, body: { tickets: [a.number], changes: { priority: 'low' } } });
  assert.equal(upd.body.failed[0].code, 'ticket_deleted');
  assert.equal((await t.api('POST', `${url}/bulk`, { token: admin.token, body: { tickets: [a.number, b.number], action: 'restore' } })).body.done, 2);
});

test('export: the filtered list as CSV with readable columns', async () => {
  const { viewer, url, mk } = await team();
  await mk('Card form', { type: 'feature', priority: 'high', labels: ['ui', 'payments'], storyPoints: 3, dueDate: '2026-12-01', description: 'Line one\nLine two' });
  await mk('=cmd|calc', { type: 'bug' });
  await mk('Docs', { type: 'task' });
  const res = await fetch(`${t.base}${url}/export?type=feature,bug&sort=number`, { headers: { authorization: `Bearer ${viewer.token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="BK\d+-tickets-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.headers.get('x-export-count'), '2');
  const rows = parseCsv(await res.text());
  assert.equal(rows[0][1], 'Title');
  const byTitle = Object.fromEntries(rows.slice(1).map((r) => [r[1], Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))]));
  const card = byTitle['Card form'];
  assert.deepEqual(
    [card.Type, card.Status, card.Labels, card['Story points'], card['Due date'], card.Description],
    ['feature', 'To Do', 'ui, payments', '3', '2026-12-01', 'Line one\nLine two'],
  );
  assert.ok(byTitle["'=cmd|calc"], 'formula-looking titles are defused');
  assert.equal(Object.keys(byTitle).length, 2);
});

test('import: preview first, refuse bad rows, create good ones quietly with every field', async () => {
  const { admin, dev, viewer, base, url, mk, upload } = await team();
  const epic = await mk('Payments v2', { type: 'epic' });
  const sprint = (await t.api('POST', `${base}/sprints`, { token: admin.token, body: { name: 'Sprint 7' } })).body.sprint;
  await t.api('POST', `${base}/milestones`, { token: admin.token, body: { name: 'Beta' } });
  const csv = [
    'Summary,Type,Status,Priority,Assignee email,Labels,Points,Start date,Due date,Epic,Sprint,Milestone,Description,Reporter',
    `Card form,feature,In Progress,high,${dev.email},"UI; payments",3,01/12/2026,2026-12-10,${epic.key},Sprint 7,beta,"Two\nlines",someone`,
    'Receipts,,,,,,,,,,,,,',
    'Broken,story,Nowhere,urgent,stranger@example.com,,lots,31/02/2026,,Missing epic,,,,',
  ].join('\n');

  assert.equal((await upload(csv, '?dryRun=true', viewer)).status, 403);
  const preview = (await upload(csv, '?dryRun=true')).body.preview;
  assert.deepEqual([preview.valid, preview.invalid], [2, 1]);
  assert.deepEqual(preview.columns.ignored, ['Reporter']);
  assert.equal(preview.rows[0].assignee.name, 'Dev Kumar');
  assert.equal(preview.rows[0].startDate, '2026-12-01', 'day-first dates are read as day-first');
  assert.equal(preview.rows[2].errors.length, 7, preview.rows[2].errors.join(' | '));
  assert.equal(await Ticket.countDocuments({ project: epic.project, title: 'Card form' }), 0, 'a dry run saves nothing');

  // Bad rows stop the whole import unless told to skip them.
  assert.equal((await upload(csv)).body.error.code, 'import_invalid');
  assert.equal(await Ticket.countDocuments({ project: epic.project, title: 'Receipts' }), 0);

  const notesBefore = await Notification.countDocuments({ user: dev.user.id });
  const done = await upload(csv, '?skipInvalid=true');
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.deepEqual(done.body.created.map((c) => c.title), ['Card form', 'Receipts']);
  assert.equal(done.body.skipped, 1);
  const card = (await t.api('GET', `${url}/${done.body.created[0].key}`, { token: admin.token })).body.ticket;
  assert.deepEqual(
    [card.type, card.status, card.priority, card.assignee.id, card.labels, card.storyPoints, card.startDate, card.dueDate, card.epic, card.sprint, card.description, card.source],
    ['feature', 'in_progress', 'high', dev.user.id, ['ui', 'payments'], 3, '2026-12-01', '2026-12-10', epic.id, sprint.id, 'Two\nlines', 'import'],
  );
  assert.ok(card.milestone);
  assert.equal(await Notification.countDocuments({ user: dev.user.id }), notesBefore, 'no notification per imported ticket');

  // What we export can be imported again.
  const exported = await (await fetch(`${t.base}${url}/export?sort=number`, { headers: { authorization: `Bearer ${admin.token}` } })).text();
  const again = (await upload(exported, '?dryRun=true')).body.preview;
  assert.equal(again.invalid, 0, JSON.stringify(again.rows.filter((r) => r.errors.length)));
  assert.ok(again.columns.ignored.includes('Key'));

  assert.equal((await upload('Title\n')).body.error.code, 'csv_empty');
  assert.equal((await upload('Thing,Other\nx,y\n')).body.error.code, 'csv_no_title');
});
