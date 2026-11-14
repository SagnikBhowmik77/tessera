// Tessera CLI (E13): work with tickets from a terminal using a personal API token.
// No dependencies; Node 20 or newer. Settings live in ~/.tessera.json (readable only by you),
// or come from TESSERA_URL and TESSERA_TOKEN. bin/tessera.mjs runs main().
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HELP = `Tessera CLI

  tessera login <api-url> <token>      save the API address and a personal token (tsp_...)
  tessera whoami                       who the token belongs to
  tessera projects                     your projects
  tessera list <KEY> [filters]         tickets (--mine, --open, --status todo,in_progress,
                                       --priority high, --type bug, --label x, --q "search", --limit 50)
  tessera show <KEY-12>                one ticket
  tessera create <KEY> <title>         new ticket (--type bug, --priority high, --description "...")
  tessera move <KEY-12> <column>       move to a column (its key or its name)
  tessera assign <KEY-12> <me|none>    assign to yourself, or unassign
  tessera comment <KEY-12> <text>      add a comment

  Add --json to any command for the raw API answer.
  Make a token in Tessera: Profile, "API tokens".`;

export class CliError extends Error {}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['mine', 'open', 'json', 'help'].includes(k)) { flags[k] = argv[i + 1]; i += 1; }
    else flags[k] = true;
  }
  return { pos, flags };
}

function settings(env, configPath) {
  let file = {};
  if (existsSync(configPath)) {
    try { file = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new CliError(`${configPath} is not valid JSON. Run "tessera login" again.`); }
  }
  const url = (env.TESSERA_URL || file.url || '').replace(/\/+$/, '');
  const token = env.TESSERA_TOKEN || file.token;
  if (!url || !token) throw new CliError('Not logged in. Run: tessera login <api-url> <token>');
  return { url, token };
}

async function api(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'user-agent': 'tessera-cli', ...(body && { 'content-type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new CliError(`Cannot reach ${cfg.url} (${err.cause?.code ?? err.message})`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new CliError(json?.error?.message ?? `The API answered ${res.status}`);
  return json;
}

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

function ticketRef(ref) {
  const m = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/.exec(ref ?? '');
  if (!m) throw new CliError(`"${ref ?? ''}" is not a ticket key like TES-12`);
  return { key: m[1].toUpperCase(), number: Number(m[2]) };
}

async function projectByKey(cfg, key) {
  if (!key) throw new CliError('Name a project by its key, like TES');
  const { projects } = await api(cfg, 'GET', '/projects');
  const p = projects.find((x) => x.key === String(key).toUpperCase());
  if (!p) throw new CliError(`No project ${String(key).toUpperCase()} among yours (${projects.map((x) => x.key).join(', ') || 'none'})`);
  return p;
}

// Runs one command. `out` collects output lines (console by default); returns nothing.
export async function main(argv, { out = console, env = process.env, configPath = env.TESSERA_CONFIG || join(homedir(), '.tessera.json') } = {}) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  const json = (r) => out.log(JSON.stringify(r, null, 2));
  if (!cmd || cmd === 'help' || flags.help) { out.log(HELP); return; }

  if (cmd === 'login') {
    const [url, token] = rest;
    if (!url || !token) throw new CliError('Usage: tessera login <api-url> <token>');
    if (!token.startsWith('tsp_')) throw new CliError('That is not a personal API token (they start with tsp_)');
    const cfg = { url: url.replace(/\/+$/, ''), token };
    const { user } = await api(cfg, 'GET', '/auth/me');
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try { chmodSync(configPath, 0o600); } catch { /* Windows keeps its own file permissions */ }
    out.log(`Logged in as ${user.name} <${user.email}>. Saved to ${configPath}`);
    return;
  }

  const cfg = settings(env, configPath);
  switch (cmd) {
    case 'whoami': {
      const r = await api(cfg, 'GET', '/auth/me');
      if (flags.json) json(r); else out.log(`${r.user.name} <${r.user.email}> at ${cfg.url}`);
      return;
    }
    case 'projects': {
      const r = await api(cfg, 'GET', '/projects');
      if (flags.json) { json(r); return; }
      for (const p of r.projects) out.log(`${pad(p.key, 7)} ${pad(p.name, 40)} ${p.myRole}`);
      if (!r.projects.length) out.log('No projects yet.');
      return;
    }
    case 'list': {
      const project = await projectByKey(cfg, rest[0]);
      const q = new URLSearchParams({ limit: String(flags.limit ?? 50) });
      if (flags.mine) q.set('assignee', 'me');
      if (flags.open) q.set('open', 'true');
      for (const f of ['status', 'priority', 'type', 'label', 'q']) if (typeof flags[f] === 'string') q.set(f, flags[f]);
      const r = await api(cfg, 'GET', `/projects/${project.id}/tickets?${q}`);
      if (flags.json) { json(r); return; }
      const names = new Map(project.statuses.map((s) => [s.key, s.name]));
      for (const t of r.tickets) out.log(`${pad(t.key, 9)} ${pad(names.get(t.status) ?? t.status, 13)} ${pad(t.priority, 8)} ${pad(t.assignee?.name ?? '-', 14)} ${t.title}`);
      out.log(`${r.tickets.length} of ${r.total}`);
      return;
    }
    case 'create': {
      const project = await projectByKey(cfg, rest[0]);
      const title = rest.slice(1).join(' ').trim();
      if (!title) throw new CliError('Usage: tessera create <KEY> <title> [--type bug] [--priority high] [--description "..."]');
      const body = { title };
      for (const f of ['type', 'priority', 'description']) if (typeof flags[f] === 'string') body[f] = flags[f];
      const r = await api(cfg, 'POST', `/projects/${project.id}/tickets`, body);
      if (flags.json) json(r); else out.log(`Created ${r.ticket.key}: ${r.ticket.title}`);
      return;
    }
    case 'show': case 'move': case 'assign': case 'comment': {
      const { key, number } = ticketRef(rest[0]);
      const project = await projectByKey(cfg, key);
      const base = `/projects/${project.id}/tickets/${number}`;
      if (cmd === 'show') {
        const r = await api(cfg, 'GET', base);
        if (flags.json) { json(r); return; }
        const t = r.ticket;
        out.log(`${t.key}  ${t.title}`);
        out.log(`  ${t.type} · ${t.priority} · ${project.statuses.find((s) => s.key === t.status)?.name ?? t.status} · ${t.assignee?.name ?? 'unassigned'}${t.dueDate ? ` · due ${t.dueDate}` : ''}`);
        if (t.labels?.length) out.log(`  labels: ${t.labels.join(', ')}`);
        if (t.description) out.log(`\n${t.description}`);
        return;
      }
      if (cmd === 'move') {
        const target = rest.slice(1).join(' ').trim();
        const col = project.statuses.find((s) => s.key === target || s.name.toLowerCase() === target.toLowerCase());
        if (!col) throw new CliError(`No column "${target}". Columns: ${project.statuses.map((s) => s.name).join(', ')}`);
        const r = await api(cfg, 'POST', `${base}/move`, { status: col.key });
        if (flags.json) json(r); else out.log(`${r.ticket.key} is now in ${col.name}`);
        return;
      }
      if (cmd === 'assign') {
        const who = rest[1];
        if (!['me', 'none'].includes(who)) throw new CliError('Usage: tessera assign <KEY-12> <me|none>');
        const me = who === 'me' ? (await api(cfg, 'GET', '/auth/me')).user.id : null;
        const r = await api(cfg, 'PATCH', base, { assigneeId: me });
        if (flags.json) json(r); else out.log(me ? `${r.ticket.key} assigned to ${r.ticket.assignee?.name}` : `${r.ticket.key} unassigned`);
        return;
      }
      const body = rest.slice(1).join(' ').trim();
      if (!body) throw new CliError('Usage: tessera comment <KEY-12> <text>');
      const r = await api(cfg, 'POST', `${base}/comments`, { body });
      if (flags.json) json(r); else out.log(`Commented on ${key}-${number}`);
      return;
    }
    default:
      throw new CliError(`Unknown command "${cmd}". Run "tessera help".`);
  }
}
