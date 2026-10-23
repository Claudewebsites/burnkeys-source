import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Vercel REST API: update a project's environment variable and redeploy.
// Response bodies are parsed only for ids/keys/urls - values are never read or shown.

const API = 'https://api.vercel.com';

// Walk up from `file` to `stopAt` looking for .vercel/project.json (written by `vercel link`).
export async function findVercelProject(file, stopAt) {
  const stop = resolve(stopAt);
  for (let dir = dirname(resolve(file)); dir === stop || dir.startsWith(stop + sep); dir = dirname(dir)) {
    try {
      const p = JSON.parse(await readFile(join(dir, '.vercel', 'project.json'), 'utf8'));
      if (p.projectId) return { projectId: p.projectId, orgId: p.orgId, name: p.projectName ?? p.projectId, dir };
    } catch { /* not here */ }
    if (dir === stop) break;
  }
  return null;
}

function q(project) {
  return project.orgId?.startsWith('team_') ? `?teamId=${encodeURIComponent(project.orgId)}` : '';
}

async function call(fetchImpl, token, method, path, body) {
  const res = await fetchImpl(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json };
}

// Set every env var named in `names` on the project to `value`.
// Returns [{ key, target, ok, status }]; an empty list means none of the names exist on Vercel.
export async function updateVercelEnv({ token, project, names, value, fetchImpl = fetch, create = false }) {
  const list = await call(fetchImpl, token, 'GET', `/v10/projects/${encodeURIComponent(project.projectId)}/env${q(project)}`);
  if (!list.ok) return { error: list.status === 401 || list.status === 403 ? 'Vercel token rejected or lacks access' : `Vercel returned HTTP ${list.status}` };
  const envs = list.json?.envs ?? (Array.isArray(list.json) ? list.json : []);
  const matches = envs.filter((e) => names.includes(e.key) && e.id);
  const results = [];
  if (!matches.length && create && names[0]) {
    // Not on Vercel yet: add it for production and preview, encrypted.
    const r = await call(fetchImpl, token, 'POST', `/v10/projects/${encodeURIComponent(project.projectId)}/env${q(project)}`,
      { key: names[0], value, type: 'encrypted', target: ['production', 'preview'] });
    return { results: [{ key: names[0], target: 'production, preview (new)', ok: r.ok, status: r.status }] };
  }
  for (const e of matches) {
    const r = await call(fetchImpl, token, 'PATCH', `/v9/projects/${encodeURIComponent(project.projectId)}/env/${encodeURIComponent(e.id)}${q(project)}`, { value });
    results.push({ key: e.key, target: [].concat(e.target ?? []).join(', ') || 'all', ok: r.ok, status: r.status });
  }
  return { results };
}

// Redeploy the latest READY production deployment, so the live site picks up the new value.
export async function redeployProduction({ token, project, fetchImpl = fetch }) {
  const sep_ = q(project) ? '&' + q(project).slice(1) : '';
  const list = await call(fetchImpl, token, 'GET',
    `/v7/deployments?projectId=${encodeURIComponent(project.projectId)}&target=production&state=READY&limit=1${sep_}`);
  const latest = list.json?.deployments?.[0];
  if (!list.ok || !latest?.uid) return { ok: false, reason: `no production deployment found (HTTP ${list.status})` };
  const r = await call(fetchImpl, token, 'POST', `/v13/deployments${q(project)}`, {
    name: latest.name, project: project.projectId, deploymentId: latest.uid, target: 'production',
  });
  return r.ok ? { ok: true, url: r.json?.url ? `https://${r.json.url}` : null } : { ok: false, reason: `Vercel returned HTTP ${r.status}` };
}
