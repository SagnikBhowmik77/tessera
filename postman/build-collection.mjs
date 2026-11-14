// Builds Tessera.postman_collection.json (run: node postman/build-collection.mjs).
// Kept as code so the collection stays readable and easy to change; the JSON is what you import.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lines = (s) => s.trim().split('\n').map((l) => l.replace(/^ {4}/, ''));
const test = (code) => [{ listen: 'test', script: { type: 'text/javascript', exec: lines(code) } }];
const pre = (code) => [{ listen: 'prerequest', script: { type: 'text/javascript', exec: lines(code) } }];

// One request. `path` is under {{baseUrl}}; auth is the collection's bearer token unless `noAuth`.
function req(name, method, path, { body, tests, prereq, noAuth } = {}) {
  const [raw, query] = path.split('?');
  const item = {
    name,
    request: {
      method,
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: {
        raw: `{{baseUrl}}${path}`,
        host: ['{{baseUrl}}'],
        path: raw.split('/').filter(Boolean),
        ...(query ? { query: query.split('&').map((kv) => { const [key, value = ''] = kv.split('='); return { key, value }; }) } : {}),
      },
    },
    event: [...(prereq ? pre(prereq) : []), ...(tests ? test(tests) : [])],
  };
  if (body) item.request.body = { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } };
  if (noAuth) item.request.auth = { type: 'noauth' };
  return item;
}
const folder = (name, description, item) => ({ name, description, item });

const collection = {
  info: {
    name: 'Tessera API',
    description: [
      'REST API of Tessera, a MERN issue tracker.',
      '',
      'Run the whole collection top to bottom (Collection Runner, or `npx newman run`).',
      'It registers a throwaway account, creates a project and tickets, exercises every core use case',
      'with assertions, then deletes the project and the account, so it leaves nothing behind.',
      '',
      'Set `baseUrl` to your API (default http://localhost:8740/api). Everything else is filled in as it runs.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:8740/api' },
    { key: 'token', value: '' },
    { key: 'email', value: '' },
    { key: 'password', value: '' },
    { key: 'userId', value: '' },
    { key: 'projectId', value: '' },
    { key: 'projectKey', value: '' },
    { key: 'bugKey', value: '' },
    { key: 'featureKey', value: '' },
    { key: 'commentId', value: '' },
  ],
  item: [
    folder('0. Health', 'Is the API up and connected to MongoDB?', [
      req('API health', 'GET', '/health', {
        noAuth: true,
        tests: `
    pm.test('200 and database connected', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().database.connected).to.be.true;
    });`,
      }),
    ]),

    folder('1. Authentication', 'Use case 1: register / login, JWT protects routes.', [
      req('Register', 'POST', '/auth/register', {
        noAuth: true,
        body: { name: 'Postman Tester', email: '{{email}}', password: '{{password}}' },
        prereq: `
    // A fresh throwaway account every run (example.com never receives mail).
    pm.collectionVariables.set('email', 'postman-' + Date.now() + '@example.com');
    pm.collectionVariables.set('password', 'Postman-' + Math.random().toString(36).slice(2, 10) + '1');`,
        tests: `
    pm.test('201 Created with a token', () => {
        pm.response.to.have.status(201);
        const b = pm.response.json();
        pm.expect(b.token).to.be.a('string');
        pm.expect(b.user.email).to.eql(pm.collectionVariables.get('email'));
        pm.expect(b.user).to.not.have.property('password');
    });`,
      }),
      req('Register again with the same email is refused', 'POST', '/auth/register', {
        noAuth: true,
        body: { name: 'Postman Tester', email: '{{email}}', password: '{{password}}' },
        tests: `
    pm.test('409 Conflict', () => pm.response.to.have.status(409));`,
      }),
      req('Register with a weak password is refused', 'POST', '/auth/register', {
        noAuth: true,
        body: { name: 'Weak', email: 'weak-{{email}}', password: 'short' },
        tests: `
    pm.test('400 with a field error for password', () => {
        pm.response.to.have.status(400);
        pm.expect(JSON.stringify(pm.response.json())).to.include('password');
    });`,
      }),
      req('Login', 'POST', '/auth/login', {
        noAuth: true,
        body: { email: '{{email}}', password: '{{password}}' },
        tests: `
    pm.test('200 with a token', () => {
        pm.response.to.have.status(200);
        const b = pm.response.json();
        pm.expect(b.token).to.be.a('string');
        pm.collectionVariables.set('token', b.token);
        pm.collectionVariables.set('userId', b.user.id);
    });`,
      }),
      req('Login with a wrong password is refused', 'POST', '/auth/login', {
        noAuth: true,
        body: { email: '{{email}}', password: 'not-the-password-1' },
        tests: `
    pm.test('401 Unauthorized', () => pm.response.to.have.status(401));`,
      }),
      req('Who am I', 'GET', '/auth/me', {
        tests: `
    pm.test('200 and it is me', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().user.email).to.eql(pm.collectionVariables.get('email'));
    });`,
      }),
      req('Protected route without a token is refused', 'GET', '/projects', {
        noAuth: true,
        tests: `
    pm.test('401 Unauthorized', () => pm.response.to.have.status(401));`,
      }),
    ]),

    folder('2. Projects', 'Use case 2: create, list, update projects.', [
      req('Create project', 'POST', '/projects', {
        body: { name: 'Postman Demo', key: '{{projectKey}}', description: 'Created by the Postman collection' },
        prereq: `
    // A key nobody else has: P + 4 random letters/digits.
    pm.collectionVariables.set('projectKey', 'P' + Math.random().toString(36).slice(2, 6).toUpperCase());`,
        tests: `
    pm.test('201 Created, I am its admin', () => {
        pm.response.to.have.status(201);
        const p = pm.response.json().project;
        pm.collectionVariables.set('projectId', p.id);
        pm.expect(p.key).to.eql(pm.collectionVariables.get('projectKey'));
        pm.expect(p.members[0].role).to.eql('admin');
    });`,
      }),
      req('Create project with a bad key is refused', 'POST', '/projects', {
        body: { name: 'Bad', key: '1x' },
        tests: `
    pm.test('400 Validation error', () => pm.response.to.have.status(400));`,
      }),
      req('List my projects', 'GET', '/projects', {
        tests: `
    pm.test('200 and contains the new project', () => {
        pm.response.to.have.status(200);
        const ids = pm.response.json().projects.map((p) => p.id);
        pm.expect(ids).to.include(pm.collectionVariables.get('projectId'));
    });`,
      }),
      req('Update project', 'PATCH', '/projects/{{projectId}}', {
        body: { description: 'Updated from Postman' },
        tests: `
    pm.test('200 and description changed', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().project.description).to.eql('Updated from Postman');
    });`,
      }),
      req('List members', 'GET', '/projects/{{projectId}}/members', {
        tests: `
    pm.test('200 with one admin member', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().members).to.have.lengthOf(1);
    });`,
      }),
    ]),

    folder('3. Tickets', 'Use cases 3, 4 and 8: create bug reports and feature requests, assign, edit.', [
      req('Create bug ticket', 'POST', '/projects/{{projectId}}/tickets', {
        body: { title: 'Checkout button does nothing on Safari', type: 'bug', priority: 'high', description: 'Steps: open cart, press **Pay**.', labels: ['checkout'] },
        tests: `
    pm.test('201 Created as a bug in To Do', () => {
        pm.response.to.have.status(201);
        const t = pm.response.json().ticket;
        pm.collectionVariables.set('bugKey', t.key);
        pm.expect(t.type).to.eql('bug');
        pm.expect(t.priority).to.eql('high');
        pm.expect(t.status).to.eql('todo');
        pm.expect(t.key).to.match(/^[A-Z0-9]+-1$/);
    });`,
      }),
      req('Create feature request', 'POST', '/projects/{{projectId}}/tickets', {
        body: { title: 'Pay with UPI', type: 'feature', priority: 'medium' },
        tests: `
    pm.test('201 Created as a feature', () => {
        pm.response.to.have.status(201);
        const t = pm.response.json().ticket;
        pm.collectionVariables.set('featureKey', t.key);
        pm.expect(t.type).to.eql('feature');
    });`,
      }),
      req('Create ticket without a title is refused', 'POST', '/projects/{{projectId}}/tickets', {
        body: { type: 'task' },
        tests: `
    pm.test('400 Title is required', () => {
        pm.response.to.have.status(400);
        pm.expect(JSON.stringify(pm.response.json())).to.include('Title is required');
    });`,
      }),
      req('Get one ticket', 'GET', '/projects/{{projectId}}/tickets/{{bugKey}}', {
        tests: `
    pm.test('200 with metadata', () => {
        pm.response.to.have.status(200);
        const t = pm.response.json().ticket;
        pm.expect(t.key).to.eql(pm.collectionVariables.get('bugKey'));
        pm.expect(t).to.have.property('createdAt');
        pm.expect(t.reporter.id).to.eql(pm.collectionVariables.get('userId'));
    });`,
      }),
      req('Assign ticket to me', 'PATCH', '/projects/{{projectId}}/tickets/{{bugKey}}', {
        body: { assigneeId: '{{userId}}' },
        tests: `
    pm.test('200 and assignee set', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().ticket.assignee.id).to.eql(pm.collectionVariables.get('userId'));
    });`,
      }),
      req('Assign to someone outside the project is refused', 'PATCH', '/projects/{{projectId}}/tickets/{{bugKey}}', {
        body: { assigneeId: '000000000000000000000000' },
        tests: `
    pm.test('4xx: only project members can be assigned', () => pm.expect(pm.response.code).to.be.within(400, 422));`,
      }),
      req('Edit ticket', 'PATCH', '/projects/{{projectId}}/tickets/{{bugKey}}', {
        body: { priority: 'critical', dueDate: '2030-01-31', storyPoints: 3 },
        tests: `
    pm.test('200 and fields changed', () => {
        pm.response.to.have.status(200);
        const t = pm.response.json().ticket;
        pm.expect(t.priority).to.eql('critical');
        pm.expect(t.dueDate).to.eql('2030-01-31');
        pm.expect(t.storyPoints).to.eql(3);
    });`,
      }),
      req('Ticket history', 'GET', '/projects/{{projectId}}/tickets/{{bugKey}}/history', {
        tests: `
    pm.test('200 and records the changes', () => {
        pm.response.to.have.status(200);
        pm.expect(JSON.stringify(pm.response.json())).to.include('critical');
    });`,
      }),
    ]),

    folder('4. Kanban board', 'Use case 5: move tickets between columns (what a drag-and-drop sends).', [
      req('Move bug to In Progress', 'POST', '/projects/{{projectId}}/tickets/{{bugKey}}/move', {
        body: { status: 'in_progress' },
        tests: `
    pm.test('200 and status is in_progress', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().ticket.status).to.eql('in_progress');
    });`,
      }),
      req('Move bug to Done', 'POST', '/projects/{{projectId}}/tickets/{{bugKey}}/move', {
        body: { status: 'done' },
        tests: `
    pm.test('200, Done, and resolvedAt set', () => {
        pm.response.to.have.status(200);
        const t = pm.response.json().ticket;
        pm.expect(t.status).to.eql('done');
        pm.expect(t.resolvedAt).to.be.a('string');
    });`,
      }),
      req('Move to a column that does not exist is refused', 'POST', '/projects/{{projectId}}/tickets/{{bugKey}}/move', {
        body: { status: 'nowhere' },
        tests: `
    pm.test('400', () => pm.response.to.have.status(400));`,
      }),
    ]),

    folder('5. Comments', 'Use case 6: threaded comments.', [
      req('Add comment', 'POST', '/projects/{{projectId}}/tickets/{{bugKey}}/comments', {
        body: { body: 'Reproduced on Safari 18. Looks like the click handler never fires.' },
        tests: `
    pm.test('201 Created', () => {
        pm.response.to.have.status(201);
        const c = pm.response.json().comment;
        pm.collectionVariables.set('commentId', c.id);
        pm.expect(c.parent).to.eql(null);
    });`,
      }),
      req('Reply to the comment (thread)', 'POST', '/projects/{{projectId}}/tickets/{{bugKey}}/comments', {
        body: { body: 'Fixed in the next build.', parentId: '{{commentId}}' },
        tests: `
    pm.test('201 and the reply points at its parent', () => {
        pm.response.to.have.status(201);
        pm.expect(pm.response.json().comment.parent).to.eql(pm.collectionVariables.get('commentId'));
    });`,
      }),
      req('Edit comment', 'PATCH', '/projects/{{projectId}}/tickets/{{bugKey}}/comments/{{commentId}}', {
        body: { body: 'Reproduced on Safari 18 and iOS 18.' },
        tests: `
    pm.test('200 and text changed', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().comment.body).to.include('iOS 18');
    });`,
      }),
      req('List comments', 'GET', '/projects/{{projectId}}/tickets/{{bugKey}}/comments', {
        tests: `
    pm.test('200 with the comment and its reply', () => {
        pm.response.to.have.status(200);
        pm.expect(JSON.stringify(pm.response.json())).to.include('Fixed in the next build.');
    });`,
      }),
    ]),

    folder('6. Filter, search, sort', 'Use case 7: by status, priority, assignee, keyword.', [
      req('Filter by status', 'GET', '/projects/{{projectId}}/tickets?status=done', {
        tests: `
    pm.test('only Done tickets', () => {
        pm.response.to.have.status(200);
        const t = pm.response.json().tickets;
        pm.expect(t.length).to.eql(1);
        t.forEach((x) => pm.expect(x.status).to.eql('done'));
    });`,
      }),
      req('Filter by priority', 'GET', '/projects/{{projectId}}/tickets?priority=medium', {
        tests: `
    pm.test('only medium tickets', () => {
        pm.response.to.have.status(200);
        const t = pm.response.json().tickets;
        pm.expect(t.map((x) => x.key)).to.eql([pm.collectionVariables.get('featureKey')]);
    });`,
      }),
      req('Filter by assignee', 'GET', '/projects/{{projectId}}/tickets?assignee={{userId}}', {
        tests: `
    pm.test('only tickets assigned to me', () => {
        pm.response.to.have.status(200);
        const t = pm.response.json().tickets;
        pm.expect(t.map((x) => x.key)).to.eql([pm.collectionVariables.get('bugKey')]);
    });`,
      }),
      req('Keyword search', 'GET', '/projects/{{projectId}}/tickets?q=safari&sort=relevance', {
        tests: `
    pm.test('finds the Safari bug', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().tickets[0].key).to.eql(pm.collectionVariables.get('bugKey'));
    });`,
      }),
      req('Sort by priority', 'GET', '/projects/{{projectId}}/tickets?sort=priority', {
        tests: `
    pm.test('critical comes first', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().tickets[0].priority).to.eql('critical');
    });`,
      }),
    ]),

    folder('7. Bug intelligence and analytics', 'Signature features: stack-trace parsing, duplicate finder, flow analytics.', [
      req('Parse a stack trace', 'POST', '/projects/{{projectId}}/tickets/parse-error', {
        body: { text: "TypeError: Cannot read properties of undefined (reading 'total')\n    at computeTotal (/app/src/cart.js:42:17)\n    at checkout (/app/src/checkout.js:10:5)" },
        tests: `
    pm.test('200 with error type and frames', () => {
        pm.response.to.have.status(200);
        const s = JSON.stringify(pm.response.json());
        pm.expect(s).to.include('TypeError');
        pm.expect(s).to.include('cart.js');
    });`,
      }),
      req('Find similar tickets', 'POST', '/projects/{{projectId}}/tickets/similar', {
        body: { title: 'Safari checkout button broken' },
        tests: `
    pm.test('200 and suggests the Safari bug', () => {
        pm.response.to.have.status(200);
        pm.expect(JSON.stringify(pm.response.json())).to.include(pm.collectionVariables.get('bugKey'));
    });`,
      }),
      req('Flow analytics (30 days)', 'GET', '/projects/{{projectId}}/analytics?days=30', {
        tests: `
    pm.test('200', () => pm.response.to.have.status(200));`,
      }),
    ]),

    folder('8. Delete and restore', 'Use case 8: delete goes to the bin and can be restored.', [
      req('Delete feature ticket (to the bin)', 'DELETE', '/projects/{{projectId}}/tickets/{{featureKey}}', {
        tests: `
    pm.test('2xx', () => pm.expect(pm.response.code).to.be.within(200, 204));`,
      }),
      req('Deleted ticket is gone from the list', 'GET', '/projects/{{projectId}}/tickets', {
        tests: `
    pm.test('not listed', () => {
        const keys = pm.response.json().tickets.map((t) => t.key);
        pm.expect(keys).to.not.include(pm.collectionVariables.get('featureKey'));
    });`,
      }),
      req('Restore it', 'POST', '/projects/{{projectId}}/tickets/{{featureKey}}/restore', {
        tests: `
    pm.test('200 and back', () => {
        pm.response.to.have.status(200);
        pm.expect(pm.response.json().ticket.deletedAt).to.eql(null);
    });`,
      }),
    ]),

    folder('9. Clean up', 'Deletes everything this run created.', [
      req('Delete project with the wrong key is refused', 'DELETE', '/projects/{{projectId}}', {
        body: { confirmKey: 'WRONG' },
        tests: `
    pm.test('4xx', () => pm.expect(pm.response.code).to.be.within(400, 422));`,
      }),
      req('Delete project', 'DELETE', '/projects/{{projectId}}', {
        body: { confirmKey: '{{projectKey}}' },
        tests: `
    pm.test('204 No Content', () => pm.response.to.have.status(204));`,
      }),
      req('Delete account', 'DELETE', '/auth/me', {
        body: { password: '{{password}}' },
        tests: `
    pm.test('200', () => pm.response.to.have.status(200));`,
      }),
      req('Old token no longer works', 'GET', '/auth/me', {
        tests: `
    pm.test('401 Unauthorized', () => pm.response.to.have.status(401));`,
      }),
    ]),
  ],
};

const out = fileURLToPath(new URL('./Tessera.postman_collection.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`Wrote ${out}`);
