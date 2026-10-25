import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { buildInventory } from './inventory.js';
import { scanGitLeaks } from './leaks.js';

// Burnkeys as an MCP server (stdio), for Cursor, Codex, Claude Desktop and other AI tools.
// Every tool answers with providers, variable names, projects, fingerprints and statuses.
// Key values never appear in any answer: they stay in this process, on this Mac.

const VERSION = '0.3.2';
const dataDir = join(homedir(), '.burnkeys');
const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return d; } };

// What each key looks like, from the projects Burnkeys knows about (or one folder).
async function keyReport(folder, { fetchImpl = fetch, live = false } = {}) {
  const cfg = await readJson(join(dataDir, 'app.json'), {});
  const projects = folder ? [{ name: folder.split('/').pop(), path: resolve(folder) }] : cfg.projects ?? [];
  const cache = await readJson(join(dataDir, 'status-cache.json'), {});
  const keys = new Map();
  for (const proj of projects) {
    let inv;
    try { inv = await buildInventory(proj.path); } catch { continue; }
    for (const e of inv.secrets) {
      if (e.places.every((p) => p.example)) continue;
      const k = keys.get(e.fp) ?? { fingerprint: e.fp, provider: e.provider?.name ?? 'Unrecognized', variables: new Set(), projects: new Set(), _e: e };
      e.names.forEach((n) => k.variables.add(n));
      k.projects.add(proj.name);
      keys.set(e.fp, k);
    }
  }
  const out = [];
  for (const k of keys.values()) {
    let status = cache[k.fingerprint]?.p === k._e.provider?.id ? cache[k.fingerprint].status : null;
    if (live && k._e.provider?.verify) status = (await k._e.provider.verify(k._e.value, fetchImpl)).status;
    out.push({ fingerprint: k.fingerprint, provider: k.provider, variables: [...k.variables], projects: [...k.projects],
      status: status === 'valid' ? 'works' : status === 'invalid' ? 'dead' : k._e.provider?.verify ? 'not checked' : 'cannot be checked automatically',
      shared: k.projects.size > 1 });
  }
  return { projects: projects.map((p) => p.name), keys: out };
}

const TOOLS = [
  {
    name: 'burnkeys_status',
    description: 'List the API keys in the user\'s projects with their health: which provider, which env variables and projects use each key, whether it works, is dead, or is shared between projects. Never returns key values. Use this before debugging auth errors from an API.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Optional project folder to look at. Default: every project Burnkeys knows about.' } } },
    run: async ({ folder }) => keyReport(folder),
  },
  {
    name: 'burnkeys_check',
    description: 'Ask each provider right now whether the keys still work (live check). Returns statuses only, never key values. Use when an API call fails with 401/403 to tell a dead key from a code bug.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Optional project folder. Default: every project Burnkeys knows about.' } } },
    run: async ({ folder }, ctx) => keyReport(folder, { live: true, fetchImpl: ctx.fetchImpl }),
  },
  {
    name: 'burnkeys_leaks',
    description: 'Check whether any of a project\'s current API keys were committed to git (now or in any past commit), and whether the repository is public. Returns fingerprints and where they were found, never values.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Project folder to check.' } }, required: ['folder'] },
    run: async ({ folder }, ctx) => {
      const inv = await buildInventory(resolve(folder));
      const secrets = inv.secrets.filter((e) => !e.places.every((p) => p.example));
      const r = await scanGitLeaks(resolve(folder), secrets.map((e) => ({ fp: e.fp, value: e.value })), { fetchImpl: ctx.fetchImpl });
      if (!r.repo) return { repository: false, leaks: [] };
      return { repository: true, remote: r.remote ?? null, public: r.public ?? null, committedEnvFiles: r.trackedEnv,
        leaks: r.found.map((f) => { const e = secrets.find((s) => s.fp === f.fp); return { fingerprint: f.fp, provider: e?.provider?.name ?? 'Unrecognized', variables: [...(e?.names ?? [])], committedNow: f.tracked, inHistory: f.history }; }) };
    },
  },
  {
    name: 'burnkeys_breaches',
    description: 'Recent security breaches at developer platforms and API providers (for example Railway) that may require rotating keys.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_, ctx) => {
      try { const r = await ctx.fetchImpl('https://burnkeys.com/advisories.json', { signal: AbortSignal.timeout(8000) }); if (r.ok) return { breaches: await r.json() }; } catch { /* offline */ }
      return { breaches: JSON.parse(await readFile(new URL('./advisories.json', import.meta.url), 'utf8').catch(() => '[]')) };
    },
  },
  {
    name: 'burnkeys_open',
    description: 'Open the Burnkeys app so the user can replace, rotate or revoke a key. Keys are never typed into the chat: the user copies the new key on the provider\'s site and Burnkeys writes it into every project (and Vercel).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => new Promise((ok) => execFile('/usr/bin/open', ['-b', 'com.burnkeys.app'], (err) => ok(err
      ? { opened: false, message: 'Burnkeys app is not installed. Get it at https://burnkeys.com' }
      : { opened: true, message: 'Burnkeys is open. Ask the user to replace the key there; never ask them to paste a key into this chat.' }))),
  },
];

export async function runMcp({ input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const handle = async (req) => {
    const { id, method, params } = req;
    if (id === undefined) return; // notifications
    try {
      if (method === 'initialize') {
        return send({ id, result: { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'burnkeys', version: VERSION },
          instructions: 'Burnkeys knows the health of the user\'s API keys without revealing them. Never ask the user to paste an API key into the chat; use burnkeys_open to let them replace it in the Burnkeys app.' } });
      }
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
      if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        try {
          const result = await tool.run(params.arguments ?? {}, { fetchImpl });
          return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result } });
        } catch (e) {
          return send({ id, result: { isError: true, content: [{ type: 'text', text: `Burnkeys couldn't do that: ${e.code === 'ENOENT' ? 'folder not found' : 'unexpected error'}.` }] } });
        }
      }
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch {
      return send({ id, error: { code: -32603, message: 'Internal error' } });
    }
  };
  let buf = '';
  const pending = [];
  input.setEncoding?.('utf8');
  for await (const chunk of input) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      pending.push(handle(msg));
    }
  }
  await Promise.all(pending);
}
