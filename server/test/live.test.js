// Live collaboration II (E10): planning poker, retro boards, incident mode with a postmortem,
// and edit conflict protection (throwaway MongoDB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { __setTransport } from '../src/mailer.js';
import { Deployment, ErrorOccurrence, Project, Ticket } from '../src/models/index.js';

let t;
before(async () => { t = await startTestServer(); __setTransport({ async sendMail() { return {}; } }); });
after(async () => { __setTransport(null); await t.stop(); });

let n = 0;
async function team() {
  const admin = await t.signUp('Admin');
  const ana = await t.signUp('Ana');
  const ben = await t.signUp('Ben');
  const viewer = await t.signUp('Viewer');
  n += 1;
  const { body } = await t.api('POST', '/api/projects', { token: admin.token, body: { name: 'Live', key: `LV${n}` } });
  await Project.updateOne({ _id: body.project.id }, { $push: { members: { $each: [{ user: ana.user.id, role: 'developer' }, { user: ben.user.id, role: 'developer' }, { user: viewer.user.id, role: 'viewer' }] } } });
  return { admin, ana, ben, viewer, project: body.project, url: `/api/projects/${body.project.id}` };
}

test('planning poker: votes stay hidden until shown, then an estimate is chosen', async () => {
  const c = await team();
  await t.api('POST', `${c.url}/tickets`, { token: c.admin.token, body: { title: 'Checkout redesign' } });
  const started = await t.api('POST', `${c.url}/poker`, { token: c.ana.token, body: { ticket: '1' } });
  assert.equal(started.status, 201);
  const rid = started.body.round.id;
  assert.equal((await t.api('PUT', `${c.url}/poker/${rid}/vote`, { token: c.viewer.token, body: { value: '5' } })).status, 403);
  assert.equal((await t.api('PUT', `${c.url}/poker/${rid}/vote`, { token: c.ana.token, body: { value: '4' } })).status, 400, 'only the card values');
  await t.api('PUT', `${c.url}/poker/${rid}/vote`, { token: c.ana.token, body: { value: '5' } });
  const benView = (await t.api('PUT', `${c.url}/poker/${rid}/vote`, { token: c.ben.token, body: { value: '8' } })).body.round;
  assert.deepEqual(benView.votes.map((v) => [v.name, v.value]), [['Ana', null], ['Ben', '8']], 'others see who voted, not what');
  assert.equal((await t.api('POST', `${c.url}/poker/${rid}/accept`, { token: c.ana.token, body: { points: 5 } })).status, 409, 'not before the reveal');
  const shown = (await t.api('POST', `${c.url}/poker/${rid}/reveal`, { token: c.ana.token })).body.round;
  assert.deepEqual(shown.votes.map((v) => v.value), ['5', '8']);
  assert.deepEqual(shown.stats, { min: 5, max: 8, median: 5, consensus: false, unsure: 0 });
  assert.equal((await t.api('PUT', `${c.url}/poker/${rid}/vote`, { token: c.ana.token, body: { value: '8' } })).status, 409);
  const done = (await t.api('POST', `${c.url}/poker/${rid}/accept`, { token: c.ben.token, body: { points: 8 } })).body.round;
  assert.deepEqual([done.status, done.accepted, done.ticket.storyPoints], ['done', 8, 8]);
  const history = (await t.api('GET', `${c.url}/tickets/1/history`, { token: c.admin.token })).body.events;
  assert.ok(history.some((e) => e.type === 'updated' && e.field === 'storyPoints' && e.to === 8));
  assert.deepEqual((await t.api('GET', `${c.url}/poker`, { token: c.ana.token })).body.rounds, []);
});

test('retro board: notes, limited votes, a ticket from an action, closing', async () => {
  const c = await team();
  const retro = (await t.api('POST', `${c.url}/retros`, { token: c.ana.token, body: { title: 'Sprint 4', votesPerPerson: 2 } })).body.retro;
  const add = (who, column, text) => t.api('POST', `${c.url}/retros/${retro.id}/items`, { token: who.token, body: { column, text } });
  await add(c.ana, 'went_well', 'Deploys were calm');
  await add(c.ben, 'to_improve', 'Reviews wait too long');
  const r3 = (await add(c.viewer, 'actions', 'Review within a day')).body.retro;
  const id = (text) => r3.items.find((i) => i.text === text).id;
  const v = (who, text) => t.api('POST', `${c.url}/retros/${retro.id}/items/${id(text)}/vote`, { token: who.token });
  await v(c.ana, 'Reviews wait too long');
  await v(c.ben, 'Reviews wait too long');
  const after2 = (await v(c.ana, 'Review within a day')).body.retro;
  assert.equal(after2.votesLeft, 0);
  assert.equal((await v(c.ana, 'Deploys were calm')).body.error.code, 'no_votes_left');
  assert.equal((await v(c.ana, 'Review within a day')).body.retro.votesLeft, 1, 'a vote can be taken back');
  const shown = (await t.api('GET', `${c.url}/retros/${retro.id}`, { token: c.ben.token })).body.retro;
  assert.deepEqual(shown.items.map((i) => [i.text, i.votes]), [['Reviews wait too long', 2], ['Deploys were calm', 0], ['Review within a day', 0]]);
  const made = (await t.api('POST', `${c.url}/retros/${retro.id}/items/${id('Review within a day')}/ticket`, { token: c.ben.token })).body.retro;
  assert.equal(made.items.find((i) => i.text === 'Review within a day').ticket, `${c.project.key}-1`);
  assert.equal((await t.api('DELETE', `${c.url}/retros/${retro.id}/items/${id('Deploys were calm')}`, { token: c.ben.token })).status, 403, 'only your own notes');
  assert.equal((await t.api('POST', `${c.url}/retros/${retro.id}/close`, { token: c.ana.token })).status, 403);
  await t.api('POST', `${c.url}/retros/${retro.id}/close`, { token: c.admin.token });
  assert.equal((await add(c.ana, 'went_well', 'late')).status, 409);
});

test('incident mode: a critical ticket, a timeline, resolving closes it, a postmortem from the record', async () => {
  const c = await team();
  const inc = (await t.api('POST', `${c.url}/incidents`, { token: c.ana.token, body: { title: 'Checkout returns 500', severity: 'sev1' } })).body.incident;
  const ticket = await Ticket.findOne({ project: c.project.id }).lean();
  assert.deepEqual([ticket.title, ticket.priority, ticket.labels], ['Incident: Checkout returns 500', 'critical', ['incident']]);
  assert.equal(inc.commander.name, 'Ana');
  await t.api('PATCH', `${c.url}/incidents/${inc.id}`, { token: c.ben.token, body: { note: 'Rolled back release 2.4.0', commanderId: c.ben.user.id } });
  await Deployment.create({ project: c.project.id, environment: 'production', release: '2.3.9', status: 'success', source: 'hook', at: new Date() });
  await ErrorOccurrence.create({ project: c.project.id, ticket: ticket._id, at: new Date() });
  await t.api('PATCH', `${c.url}/incidents/${inc.id}`, { token: c.ben.token, body: { rootCause: 'A missing null check in the tax service.', followUp: `${c.project.key}-1` } });
  const resolved = (await t.api('POST', `${c.url}/incidents/${inc.id}/resolve`, { token: c.ana.token, body: { summary: 'Rollback fixed it' } })).body.incident;
  assert.deepEqual(resolved.timeline.map((e) => e.kind), ['started', 'note', 'commander', 'resolved']);
  assert.equal((await Ticket.findById(ticket._id).lean()).status, 'done', 'the status page stops showing it');
  const md = (await t.api('GET', `${c.url}/incidents/${inc.id}/postmortem`, { token: c.viewer.token })).body.markdown;
  assert.match(md, /^# Postmortem: Checkout returns 500/);
  assert.match(md, /\*\*Commander:\*\* Ben/);
  assert.match(md, /1 crash report arrived during the incident/);
  assert.match(md, /2\.3\.9 to production \(success/);
  assert.match(md, /Rolled back release 2\.4\.0 \(Ben\)/);
  assert.match(md, /## Root cause\nA missing null check in the tax service\./);
  assert.match(md, /## Lessons\n_Not written yet\._/);
  assert.equal((await t.api('POST', `${c.url}/incidents`, { token: c.viewer.token, body: { title: 'Nope nope' } })).status, 403);
});

test('edit conflicts: someone else\'s change to the same field is never silently overwritten', async () => {
  const c = await team();
  await t.api('POST', `${c.url}/tickets`, { token: c.admin.token, body: { title: 'Original title', description: 'Old text', assigneeId: c.ana.user.id } });
  const opened = (await t.api('GET', `${c.url}/tickets/1`, { token: c.ana.token })).body.ticket.updatedAt;
  await new Promise((r) => setTimeout(r, 20));
  await t.api('PATCH', `${c.url}/tickets/1`, { token: c.admin.token, body: { description: 'Admin rewrote it' } });
  // Ana saves her description from the version she opened: refused, with what changed and by whom.
  const res = await t.api('PATCH', `${c.url}/tickets/1`, { token: c.ana.token, body: { description: 'Ana text', expectedUpdatedAt: opened } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'edit_conflict');
  assert.equal(res.body.error.message, 'Admin changed the description while you were editing');
  assert.equal(res.body.error.details.current.description, 'Admin rewrote it');
  // A different field merges fine; saving without the check overwrites on purpose.
  assert.equal((await t.api('PATCH', `${c.url}/tickets/1`, { token: c.ana.token, body: { title: 'Ana title', expectedUpdatedAt: opened } })).status, 200);
  const forced = await t.api('PATCH', `${c.url}/tickets/1`, { token: c.ana.token, body: { description: 'Ana text' } });
  assert.equal(forced.body.ticket.description, 'Ana text');
});
