import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Update an environment variable on hosting platforms other than Vercel, then redeploy.
// Each host gets only the new value of the variable the user chose, sent to its own API over HTTPS.
// Responses are read for ids and status codes only; values are never read back or shown.

async function req(fetchImpl, url, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    method, signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, json };
}
const fail = (host, r) => (r.status === 401 || r.status === 403 ? `${host} token rejected or lacks access` : `${host} returned HTTP ${r.status}`);

// ---------- Railway (project linked with `railway link`) ----------
async function railwayLink(dir) {
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.railway', 'config.json'), 'utf8'));
    const hit = Object.entries(cfg.projects ?? {}).filter(([p]) => p === dir || p.startsWith(dir + '/')).map(([, v]) => v);
    return hit.length ? hit.map((v) => ({ projectId: v.project, environmentId: v.environment, serviceId: v.service ?? null, name: v.name })) : null;
  } catch { return null; }
}
async function railwaySet({ link, token, names, value, fetchImpl }) {
  const gql = (query, variables) => req(fetchImpl, 'https://backboard.railway.com/graphql/v2', { method: 'POST', token, body: { query, variables } });
  for (const l of link) {
    for (const name of names) {
      const r = await gql('mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
        { input: { projectId: l.projectId, environmentId: l.environmentId, ...(l.serviceId && { serviceId: l.serviceId }), name, value } });
      if (!r.ok || r.json?.errors?.length) return { error: r.ok ? 'Railway refused the change' : fail('Railway', r) };
    }
  }
  return { ok: true, note: 'updated; Railway redeploys the service' };
}

// ---------- Netlify (site linked with `netlify link`: .netlify/state.json) ----------
async function netlifyLink(dir) {
  try { const s = JSON.parse(await readFile(join(dir, '.netlify', 'state.json'), 'utf8')); return s.siteId ? [{ siteId: s.siteId }] : null; } catch { return null; }
}
async function netlifySet({ link, token, names, value, fetchImpl }) {
  const api = 'https://api.netlify.com/api/v1';
  for (const { siteId } of link) {
    const site = await req(fetchImpl, `${api}/sites/${encodeURIComponent(siteId)}`, { token });
    if (!site.ok) return { error: fail('Netlify', site) };
    const acct = site.json?.account_id ?? site.json?.account_slug;
    for (const key of names) {
      const base = `${api}/accounts/${encodeURIComponent(acct)}/env`;
      const put = await req(fetchImpl, `${base}/${encodeURIComponent(key)}?site_id=${encodeURIComponent(siteId)}`,
        { method: 'PUT', token, body: { key, scopes: ['builds', 'functions', 'runtime', 'post-processing'], values: [{ value, context: 'all' }] } });
      if (put.status === 404) {
        const add = await req(fetchImpl, `${base}?site_id=${encodeURIComponent(siteId)}`, { method: 'POST', token, body: [{ key, values: [{ value, context: 'all' }] }] });
        if (!add.ok) return { error: fail('Netlify', add) };
      } else if (!put.ok) return { error: fail('Netlify', put) };
    }
    const build = await req(fetchImpl, `${api}/sites/${encodeURIComponent(siteId)}/builds`, { method: 'POST', token, body: {} });
    if (!build.ok) return { ok: true, note: `updated, redeploy failed (HTTP ${build.status})` };
  }
  return { ok: true, note: 'updated and redeploying' };
}

// ---------- Fly.io (fly.toml: app = "name") ----------
async function flyLink(dir) {
  try { const m = (await readFile(join(dir, 'fly.toml'), 'utf8')).match(/^\s*app\s*=\s*["']([^"']+)["']/m); return m ? [{ app: m[1] }] : null; } catch { return null; }
}
async function flySet({ link, token, names, value, fetchImpl }) {
  for (const { app } of link) {
    const r = await req(fetchImpl, 'https://api.fly.io/graphql', { method: 'POST', token, body: {
      query: 'mutation($input: SetSecretsInput!) { setSecrets(input: $input) { app { name } } }',
      variables: { input: { appId: app, secrets: names.map((key) => ({ key, value })) } },
    } });
    if (!r.ok || r.json?.errors?.length) return { error: r.ok ? 'Fly.io refused the change' : fail('Fly.io', r) };
  }
  return { ok: true, note: 'updated; Fly.io applies it on the next deploy or restart' };
}

// ---------- Render (render.yaml service names, looked up by name) ----------
async function renderLink(dir) {
  try {
    const y = await readFile(join(dir, 'render.yaml'), 'utf8');
    // Only service names: the top-level "services:" list (not databases or fromService references).
    const block = (y.split(/^services:\s*$/m)[1] ?? '').split(/^\S/m)[0];
    const names = [...block.matchAll(/^ {2}- [\s\S]*?(?=^ {2}- |$(?![\s\S]))/gm)].map((m) => (m[0].match(/^\s*-?\s*name:\s*["']?([\w.-]+)["']?\s*$/m) ?? [])[1]).filter(Boolean);
    return names.length ? names.map((name) => ({ name })) : null;
  } catch { return null; }
}
async function renderSet({ link, token, names, value, fetchImpl }) {
  const api = 'https://api.render.com/v1';
  let touched = 0;
  for (const { name } of link) {
    const list = await req(fetchImpl, `${api}/services?name=${encodeURIComponent(name)}&limit=5`, { token });
    if (!list.ok) return { error: fail('Render', list) };
    for (const item of list.json ?? []) {
      const id = item.service?.id ?? item.id;
      if (!id) continue;
      for (const key of names) {
        const r = await req(fetchImpl, `${api}/services/${encodeURIComponent(id)}/env-vars/${encodeURIComponent(key)}`, { method: 'PUT', token, body: { value } });
        if (!r.ok) return { error: fail('Render', r) };
      }
      await req(fetchImpl, `${api}/services/${encodeURIComponent(id)}/deploys`, { method: 'POST', token, body: {} });
      touched++;
    }
  }
  return touched ? { ok: true, note: 'updated and redeploying' } : { error: 'no matching service found on Render' };
}

export const HOSTS = {
  railway: { name: 'Railway', provider: 'railway', tokenNames: ['RAILWAY_API_TOKEN', 'RAILWAY_TOKEN'], link: railwayLink, set: railwaySet },
  netlify: { name: 'Netlify', provider: 'netlify', tokenNames: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_TOKEN'], link: netlifyLink, set: netlifySet },
  fly: { name: 'Fly.io', provider: 'fly', tokenNames: ['FLY_API_TOKEN', 'FLY_ACCESS_TOKEN'], link: flyLink, set: flySet },
  render: { name: 'Render', provider: 'render', tokenNames: ['RENDER_API_KEY'], link: renderLink, set: renderSet },
};
