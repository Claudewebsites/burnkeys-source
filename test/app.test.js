import { test } from 'node:test';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startApp } from '../src/app/server.js';
import { createVault } from '../src/vault.js';
import { discoverProjects } from '../src/projects.js';
import { setVarInText } from '../src/envwrite.js';
import { fake, tempDir, fakeFetch, assertNoSecrets } from './helpers.js';

const memoryKeychain = () => {
  const m = new Map();
  return { store: m, set: async (a, s) => { m.set(a, s); return true; }, get: async (a) => m.get(a) ?? null, remove: async (a) => m.delete(a) };
};

async function setup() {
  const home = await tempDir();
  const code = join(home, 'Desktop');
  const dead = fake.anthropic(), alive = fake.openrouter(), fresh = fake.anthropic();
  await mkdir(join(code, 'store', 'web'), { recursive: true });
  await mkdir(join(code, 'chatbot'), { recursive: true });
  await mkdir(join(code, 'new-app'), { recursive: true });
  await writeFile(join(code, 'store', 'package.json'), '{}');
  await writeFile(join(code, 'store', 'web', '.env'), `ANTHROPIC_API_KEY="${dead}"\nOPENROUTER_API_KEY=${alive}\n`);
  await writeFile(join(code, 'chatbot', '.env'), `OPENROUTER_API_KEY=${alive}\n`);
  await writeFile(join(code, 'new-app', 'package.json'), '{}');
  let reads = 0, clip = '';
  const clipboard = { read: () => (++reads === 3 ? (clip = fresh) : clip), clear: () => { clip = ''; } };
  const keychain = memoryKeychain();
  const dataDir = join(home, '.data');
  const app = await startApp({
    roots: [code], dataDir, fetchImpl: fakeFetch(new Set([alive, fresh])).impl, clipboard,
    clipboardWait: { pollMs: 5, timeoutMs: 2000 }, vault: createVault({ dataDir, keychain }), keychain, backupRoot: join(home, '.backups'),
  });
  const base = app.url.split('#')[0].replace(/\/$/, '');
  const call = async (path, body, headers = {}) => fetch(base + '/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { 'x-burnkeys-token': app.token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body),
  });
  return { home, code, app, call, base, dead, alive, fresh, keychain };
}

test('discoverProjects stops at the first folder with a project marker', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const found = await discoverProjects([s.code]);
  t.assert.deepEqual(found.map((p) => p.name), ['chatbot', 'new-app', 'store']);
});

test('setVarInText keeps CRLF, replaces multi-line values whole, and never breaks quoting', (t) => {
  t.assert.equal(setVarInText('A="x"\r\nB=y\r\n', 'A', 'new'), 'A="new"\r\nB=y\r\n');
  t.assert.equal(setVarInText('X=1\nP="-----BEGIN\nOLD\n-----END"\nY=2\n', 'P', 'v'), 'X=1\nP="v"\nY=2\n');
  t.assert.equal(setVarInText('F="{}"\n', 'F', '{"a":"b c"}'), "F='{\"a\":\"b c\"}'\n");
});

test('setVarInText replaces in place (keeping quotes) or appends', (t) => {
  t.assert.equal(setVarInText('A=1\nKEY="old"\n', 'KEY', 'new'), 'A=1\nKEY="new"\n');
  t.assert.equal(setVarInText('A=1', 'KEY', 'v'), 'A=1\nKEY=v\n');
  t.assert.equal(setVarInText('', 'KEY', 'v'), 'KEY=v\n');
});

test('app: token required; scan finds projects and groups keys by provider', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  t.assert.equal((await fetch(s.base + '/api/overview')).status, 401);
  t.assert.equal((await (await s.call('overview')).json()).scanned, false);
  const body = await (await s.call('scan', {})).text();
  const o = JSON.parse(body);
  t.assert.deepEqual(o.projects.map((p) => p.name), ['chatbot', 'new-app', 'store']);
  const anth = o.providers.find((p) => p.id === 'anthropic');
  t.assert.equal(anth.keys[0].status, 'invalid');
  t.assert.equal(o.providers[0].id, 'anthropic', 'broken providers first');
  t.assert.deepEqual(o.providers.find((p) => p.id === 'openrouter').keys[0].projects.sort(), ['chatbot', 'store']);
  t.assert.ok(o.catalog.some((c) => c.id === 'gemini'));
  assertNoSecrets(t, body, [s.dead, s.alive]);
});

test('app: replace a dead key - copied, checked, saved to Keychain, written to chosen projects', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const o = await (await s.call('scan', {})).json();
  const old = o.providers.find((p) => p.id === 'anthropic').keys[0];
  let job = await (await s.call('add-key', { providerId: 'anthropic', replaceFp: old.fp })).json();
  for (let i = 0; i < 100 && !['choose', 'failed'].includes(job.step); i++) {
    await new Promise((ok) => setTimeout(ok, 20));
    job = (await (await s.call('overview')).json()).job;
  }
  t.assert.equal(job.step, 'choose', job.message);
  t.assert.equal(job.variable, 'ANTHROPIC_API_KEY');
  t.assert.deepEqual(job.suggested, [join(s.code, 'store')], 'the project with the dead key is pre-selected');
  t.assert.equal(s.keychain.store.size, 1, 'saved to the Keychain');

  const r = await (await s.call('apply', { fp: job.fp, projects: [join(s.code, 'store'), join(s.code, 'new-app')], variable: 'ANTHROPIC_API_KEY', vercel: false })).json();
  t.assert.deepEqual(r.results.map((x) => [x.project, x.files.map((f) => f.file), x.files.every((f) => f.ok)]),
    [['store', [join('web', '.env')], true], ['new-app', ['.env'], true]]);
  t.assert.equal(await readFile(join(s.code, 'store', 'web', '.env'), 'utf8'), `ANTHROPIC_API_KEY="${s.fresh}"\nOPENROUTER_API_KEY=${s.alive}\n`);
  t.assert.equal(await readFile(join(s.code, 'new-app', '.env'), 'utf8'), `ANTHROPIC_API_KEY=${s.fresh}\n`);

  const after = await (await s.call('overview')).text();
  const anth = JSON.parse(after).providers.find((p) => p.id === 'anthropic');
  t.assert.deepEqual(anth.keys.map((k) => [k.status, k.projects.sort(), k.saved]), [['valid', ['new-app', 'store'], true]]);
  assertNoSecrets(t, JSON.stringify(r) + after, [s.dead, s.fresh, s.alive]);
});

test('app: a saved key can be added to more projects later, from the Keychain', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.call('scan', {});
  let job = await (await s.call('add-key', { providerId: 'anthropic' })).json();
  for (let i = 0; i < 100 && job.step !== 'choose'; i++) { await new Promise((ok) => setTimeout(ok, 20)); job = (await (await s.call('overview')).json()).job; }
  await s.call('cancel', {});
  const r = await (await s.call('apply', { fp: job.fp, projects: [join(s.code, 'chatbot')], variable: 'ANTHROPIC_API_KEY' })).json();
  t.assert.equal(r.results[0].files[0].ok, true);
  t.assert.match(await readFile(join(s.code, 'chatbot', '.env'), 'utf8'), new RegExp(`ANTHROPIC_API_KEY=${s.fresh}`));
  t.assert.equal((await s.call('apply', { fp: 'fp:00000000', projects: [], variable: 'X' })).status, 400);
  t.assert.equal((await s.call('apply', { fp: job.fp, projects: [], variable: 'bad name' })).status, 400);
});

test('app: a key already used in one project can be added to another project', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const o = await (await s.call('scan', {})).json();
  const or = o.providers.find((p) => p.id === 'openrouter').keys[0];
  const r = await (await s.call('apply', { fp: or.fp, projects: [join(s.code, 'new-app')], variable: 'OPENROUTER_API_KEY' })).json();
  t.assert.equal(r.results[0].files[0].ok, true);
  t.assert.equal(await readFile(join(s.code, 'new-app', '.env'), 'utf8'), `OPENROUTER_API_KEY=${s.alive}\n`);
  assertNoSecrets(t, JSON.stringify(r), [s.alive]);
});

test('app: new project gets a folder, a .gitignore and the chosen keys', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const o = await (await s.call('scan', {})).json();
  const or = o.providers.find((p) => p.id === 'openrouter').keys[0];
  const r = await (await s.call('new-project', { name: 'fresh-app', parent: s.code, keys: [{ fp: or.fp, variable: 'OPENROUTER_API_KEY' }] })).json();
  t.assert.deepEqual(r.written, ['OPENROUTER_API_KEY']);
  t.assert.equal(await readFile(join(s.code, 'fresh-app', '.env'), 'utf8'), `OPENROUTER_API_KEY=${s.alive}\n`);
  t.assert.match(await readFile(join(s.code, 'fresh-app', '.gitignore'), 'utf8'), /^\.env$/m);
  t.assert.ok((await (await s.call('overview')).json()).projects.some((p) => p.name === 'fresh-app'));
  t.assert.equal((await s.call('new-project', { name: 'fresh-app', parent: s.code, keys: [] })).status, 400, 'existing folder');
  t.assert.equal((await s.call('new-project', { name: '../escape', parent: s.code, keys: [] })).status, 400, 'bad name');
  assertNoSecrets(t, JSON.stringify(r), [s.alive]);
});

test('app: signing in stores the account token only via a matching sign-in state', async (t) => {
  const home = await tempDir();
  const keychain = memoryKeychain();
  const site = async (url, opts) => ({ status: opts?.headers?.Authorization === 'Bearer tok123' ? 200 : 401, json: async () => ({ email: 'a@b.c', plan: 'pro' }) });
  const app = await startApp({ roots: [home], dataDir: join(home, '.d'), vault: createVault({ dataDir: join(home, '.d'), keychain }), keychain, fetchImpl: site, siteUrl: 'https://example.test' });
  t.after(() => app.close());
  const base = app.url.split('#')[0].replace(/\/$/, '');
  const call = (path, body) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'x-burnkeys-token': app.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  t.assert.deepEqual(await (await call('account')).json(), { signedIn: false });
  const { url } = await (await call('account/start', {})).json();
  const st = new URL(url).searchParams.get('state');
  t.assert.equal((await call('account/link', { state: 'wrong', token: 'tok123' })).status, 400);
  t.assert.equal((await call('account/link', { state: st, token: 'tok123' })).status, 400, 'state is single-use');
  const { url: url2 } = await (await call('account/start', {})).json();
  t.assert.equal((await call('account/link', { state: new URL(url2).searchParams.get('state'), token: 'tok123' })).status, 200);
  t.assert.deepEqual(await (await call('account')).json(), { signedIn: true, email: 'a@b.c', plan: 'pro' });
  await call('account/signout', {});
  t.assert.deepEqual(await (await call('account')).json(), { signedIn: false });
});

const waitJob = async (s, done) => {
  let job;
  for (let i = 0; i < 150; i++) { job = (await (await s.call('overview')).json()).job; if (done(job)) return job; await new Promise((ok) => setTimeout(ok, 20)); }
  return job;
};

test('app: multi-part credentials (APNs) - typed ids plus a dropped .p8 file, written together', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.call('scan', {});
  const p8 = `-----BEGIN PRIVATE KEY-----\n${fake.generic()}\n${fake.generic()}\n-----END PRIVATE KEY-----\n`;
  let job = await (await s.call('add-key', { providerId: 'apns' })).json();
  t.assert.deepEqual(job.fields.map((f) => f.variable), ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY']);
  t.assert.equal((await s.call('add-key/manual', { key: 'ABC123DEFG' })).status, 200);
  await waitJob(s, (j) => j.fieldIndex === 1);
  t.assert.equal((await s.call('add-key/manual', { key: 'TEAM123456' })).status, 200);
  await waitJob(s, (j) => j.fieldIndex === 2);
  t.assert.equal((await s.call('add-key/manual', { key: 'not a key file' })).status, 400);
  t.assert.equal((await s.call('add-key/manual', { key: p8 })).status, 200);
  job = await waitJob(s, (j) => ['choose', 'failed'].includes(j.step));
  t.assert.equal(job.step, 'choose', job.message);
  const path = join(s.code, 'new-app');
  const r = await (await s.call('apply', { fp: job.fp, projects: [path], variable: 'IGNORED', vercel: false })).json();
  t.assert.ok(r.results[0].files.every((f) => f.ok));
  const env = await readFile(join(path, '.env'), 'utf8');
  t.assert.match(env, /^APNS_KEY_ID=ABC123DEFG$/m);
  t.assert.match(env, /^APNS_TEAM_ID=TEAM123456$/m);
  t.assert.match(env, /^APNS_PRIVATE_KEY='?-----BEGIN PRIVATE KEY-----\\n.+\\n-----END PRIVATE KEY-----'?$/m);
  t.assert.ok([...s.keychain.store.keys()].some((a) => a.startsWith('apns:')), 'the .p8 is kept in the Keychain');
});

test('app: shared keys can be marked as shared on purpose; cache is tied to the provider', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  let o = await (await s.call('scan', {})).json();
  const or = o.providers.find((p) => p.id === 'openrouter');
  t.assert.equal(or.health, 'warn');
  o = await (await s.call('shared-ok', { fp: or.keys[0].fp })).json();
  t.assert.equal(o.providers.find((p) => p.id === 'openrouter').health, 'ok');
  // A status cached for another provider is not shown.
  const cachePath = join(s.home, '.data', 'status-cache.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  cache[or.keys[0].fp].p = 'stripe';
  await writeFile(cachePath, JSON.stringify(cache));
  o = await (await s.call('overview')).json();
  t.assert.equal(o.providers.find((p) => p.id === 'openrouter').keys[0].status, null);
});

test('leaks: finds a key committed to git, even after the file was removed', async (t) => {
  const { scanGitLeaks } = await import('../src/leaks.js');
  const { execFileSync } = await import('node:child_process');
  const dir = await tempDir();
  const key = fake.anthropic(), other = fake.openrouter();
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  await writeFile(join(dir, '.env'), `ANTHROPIC_API_KEY=${key}\n`);
  g('add', '.env'); g('commit', '-qm', 'oops');
  g('rm', '-q', '--cached', '.env'); g('commit', '-qm', 'remove');
  const r = await scanGitLeaks(dir, [{ fp: 'fp:aaaaaaaa', value: key }, { fp: 'fp:bbbbbbbb', value: other }], { fetchImpl: async () => ({ status: 404 }) });
  t.assert.equal(r.repo, true);
  t.assert.deepEqual(r.found, [{ fp: 'fp:aaaaaaaa', tracked: false, history: true }]);
});

test('app: a platform breach lists the keys of projects deployed there', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await mkdir(join(s.code, 'chatbot', 'server'), { recursive: true });
  await writeFile(join(s.code, 'chatbot', 'server', 'railpack.json'), '{}'); // Railway's build file, one folder down
  await s.call('overview'); // the window opens before the first scan: keys found right after still count as old
  const o = await (await s.call('scan', {})).json();
  const a = o.alerts.find((x) => x.id === 'railway-2026-10-21');
  t.assert.deepEqual(a.projects, ['chatbot']);
  t.assert.deepEqual(a.affected.map((x) => x.providerId), ['openrouter']);
  // The user can also say where a project is deployed.
  const marked = await (await s.call('platform', { path: join(s.code, 'store'), platform: 'railway', on: true })).json();
  t.assert.deepEqual(marked.alerts.find((x) => x.id === a.id).projects.sort(), ['chatbot', 'store']);
  const after = await (await s.call('alert-done', { id: a.id })).json();
  t.assert.equal(after.alerts.find((x) => x.id === a.id).done, true);
});

test('app: free plan reads keys from 3 projects; the user picks which', async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await mkdir(join(s.code, 'fourth'), { recursive: true });
  await writeFile(join(s.code, 'fourth', 'package.json'), '{}');
  let o = await (await s.call('scan', {})).json();
  t.assert.equal(o.plan, 'free');
  t.assert.equal(o.projects.length, 4);
  const locked = o.projects.filter((p) => p.locked);
  t.assert.equal(locked.length, 1);
  t.assert.notEqual(locked[0].name, 'store', 'the project with the most keys stays watched');
  o = await (await s.call('free-projects', { path: locked[0].path })).json();
  t.assert.equal(o.projects.find((p) => p.path === locked[0].path).locked, undefined);
  t.assert.equal(o.projects.filter((p) => p.locked).length, 1);
  t.assert.equal((await s.call('settings', { background: true })).status, 402, 'background checks need Pro');
});
