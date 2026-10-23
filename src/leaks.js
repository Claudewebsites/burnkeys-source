import { spawn } from 'node:child_process';
import { stat, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

// Leak checks that run on this Mac only. Key values are searched for inside
// git's own output, in memory; they are never passed to git as arguments
// (that would show them in the process list) and never sent anywhere.

const MAX_BYTES = 400 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$|(^|\/)[^/]*\.env$/;
const EXAMPLE = /example|sample|template|dist/i;

function git(cwd, args, onData) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } }); }
    catch { return resolve({ ok: false, truncated: false }); }
    let bytes = 0, truncated = false;
    const timer = setTimeout(() => { truncated = true; p.kill(); }, TIMEOUT_MS);
    p.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > MAX_BYTES) { truncated = true; p.kill(); return; }
      onData(d);
    });
    p.on('error', () => { clearTimeout(timer); resolve({ ok: false, truncated }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 || truncated, truncated }); });
  });
}

async function isRepo(path) {
  try { await stat(join(path, '.git')); return true; } catch { return false; }
}

// Is the project's GitHub remote public? Only the owner/name is sent to GitHub.
async function remoteVisibility(path, fetchImpl) {
  let url = '';
  await git(path, ['remote', 'get-url', 'origin'], (d) => { url += d; });
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?$/);
  if (!m) return { remote: url.trim() ? 'other' : null, public: null };
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { 'User-Agent': 'burnkeys' }, signal: AbortSignal.timeout(8000) });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return { remote: `github.com/${m[1]}/${m[2]}`, public: r.status === 200 ? true : r.status === 404 ? false : null };
  } catch { return { remote: `github.com/${m[1]}/${m[2]}`, public: null }; }
}

// Find which of `secrets` ([{ fp, value }]) are in the project's git repo:
//   tracked: an env file holding the key is committed right now
//   history: the key appears in any commit, on any branch
// Returns { repo, remote, public, truncated, found: [{ fp, tracked, history }] }.
export async function scanGitLeaks(projectPath, secrets, { fetchImpl = fetch } = {}) {
  if (!(await isRepo(projectPath))) return { repo: false, found: [] };
  const wanted = secrets.filter((s) => s.value && s.value.length >= 16);
  const hits = new Map();
  const mark = (fp, k) => { const h = hits.get(fp) ?? { fp, tracked: false, history: false }; h[k] = true; hits.set(fp, h); };

  // Env files committed now.
  let listed = '';
  await git(projectPath, ['ls-files', '-z'], (d) => { listed += d; });
  const trackedEnv = listed.split('\0').filter((f) => ENV_FILE.test(f) && !EXAMPLE.test(basename(f)));
  if (trackedEnv.length) {
    let text = '';
    for (const f of trackedEnv) await git(projectPath, ['show', `HEAD:${f}`], (d) => { text += d; });
    for (const s of wanted) if (text.includes(s.value)) mark(s.fp, 'tracked');
  }

  // Every version of every file, on every branch. Streamed; a small overlap
  // between chunks catches a key split across two reads.
  const maxLen = Math.max(0, ...wanted.map((s) => s.value.length));
  let tail = '';
  const pending = new Set(wanted.map((s) => s.fp));
  const res = await git(projectPath, ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--format=%H'], (d) => {
    if (!pending.size) return;
    const chunk = tail + d.toString('utf8');
    for (const s of wanted) if (pending.has(s.fp) && chunk.includes(s.value)) { mark(s.fp, 'history'); pending.delete(s.fp); }
    tail = chunk.slice(-maxLen);
  });
  const found = [...hits.values()];
  const vis = found.length ? await remoteVisibility(projectPath, fetchImpl) : { remote: null, public: null };
  return { repo: true, ...vis, truncated: res.truncated, trackedEnv, found };
}

// Signs that a project is deployed on a hosting platform (used to match platform breaches).
// Looks in the project folder and its direct subfolders (server/, api/, apps/web...),
// since the deployed part often lives one level down.
// Hosting platforms and cloud services a project uses, from its files and env variable names.
// Ids match the breach list (burnkeys.com/advisories.json).
export const PLATFORMS = [
  { id: 'vercel', name: 'Vercel', files: ['vercel.json', '.vercel'], env: /^VERCEL_/ },
  { id: 'railway', name: 'Railway', files: ['railway.json', 'railway.toml', 'railpack.json', '.railway'], env: /^RAILWAY_/ },
  { id: 'netlify', name: 'Netlify', files: ['netlify.toml', '.netlify'], env: /^NETLIFY_/ },
  { id: 'fly', name: 'Fly.io', files: ['fly.toml'], env: /^FLY_/ },
  { id: 'render', name: 'Render', files: ['render.yaml'], env: /^RENDER_/ },
  { id: 'supabase', name: 'Supabase', files: ['supabase/config.toml'], env: /^(NEXT_PUBLIC_)?SUPABASE_/ },
  { id: 'firebase', name: 'Firebase', files: ['firebase.json', '.firebaserc'], env: /^(FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS$)/ },
  { id: 'cloudflare', name: 'Cloudflare', files: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'], env: /^(CLOUDFLARE_|CF_|R2_)/ },
  { id: 'aws', name: 'AWS', files: ['serverless.yml', 'samconfig.toml', 'cdk.json', 'amplify'], env: /^AWS_/ },
  { id: 'heroku', name: 'Heroku', files: ['app.json'], env: /^HEROKU_/ },
  { id: 'digitalocean', name: 'DigitalOcean', files: ['.do/app.yaml'], env: /^(DIGITALOCEAN_|DO_SPACES_)/ },
  { id: 'github', name: 'GitHub Actions', files: ['.github/workflows'], env: /^(GITHUB_TOKEN|GH_TOKEN)$/ },
  { id: 'upstash', name: 'Upstash', files: [], env: /^UPSTASH_/ },
  { id: 'clerk', name: 'Clerk', files: [], env: /^(NEXT_PUBLIC_)?CLERK_/ },
];

// Looks in the project folder and its direct subfolders (server/, api/, apps/web...),
// since the deployed part often lives one level down.
export async function deployedOn(projectPath, envNames = []) {
  const dirs = [projectPath];
  try {
    for (const d of await readdir(projectPath, { withFileTypes: true })) {
      if (d.isDirectory() && !/^(node_modules|\.git|dist|build|\.next)$/.test(d.name)) dirs.push(join(projectPath, d.name));
    }
  } catch { /* unreadable */ }
  const has = async (f) => {
    for (const dir of dirs) { try { await stat(join(dir, f)); return true; } catch { /* next */ } }
    return false;
  };
  const out = [];
  for (const p of PLATFORMS) {
    if (envNames.some((n) => p.env.test(n))) { out.push(p.id); continue; }
    for (const f of p.files) if (await has(f)) { out.push(p.id); break; }
  }
  return out;
}
