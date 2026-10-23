import { test } from 'node:test';
import { writeFile, readFile, readdir, mkdir, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { replace, push } from '../src/replace.js';
import { fingerprint } from '../src/fingerprint.js';
import { fake, tempDir, capture, fakeFetch, assertNoSecrets } from './helpers.js';

const answers = (...a) => async () => a.shift();

async function setup() {
  const dir = await tempDir();
  const oldKey = fake.anthropic();
  const other = fake.openrouter();
  await mkdir(join(dir, 'web'));
  const envText = `# my app\nANTHROPIC_API_KEY="${oldKey}"\nOPENROUTER_API_KEY=${other}\nPORT=3000\n`;
  await writeFile(join(dir, 'web', '.env'), envText);
  await chmod(join(dir, 'web', '.env'), 0o600);
  await writeFile(join(dir, 'web', '.env.production'), `ANTHROPIC_API_KEY=${oldKey}\n`);
  return { dir, oldKey, other, envText, backupRoot: join(dir, 'backups') };
}

test('replace: checks the new key, backs up, updates every file, keeps everything else', async (t) => {
  const s = await setup();
  const newKey = fake.anthropic();
  const ff = fakeFetch(new Set([newKey]));
  const { code, text } = await capture(() =>
    replace(s.dir, fingerprint(s.oldKey), { readSecret: answers(newKey), confirm: answers('y'), fetchImpl: ff.impl, backupRoot: s.backupRoot }));
  t.assert.equal(code, 0);
  t.assert.match(text, /New key fp:\w+ works/);
  t.assert.match(text, /Done: 2 of 2 file\(s\) updated/);

  const env = await readFile(join(s.dir, 'web', '.env'), 'utf8');
  t.assert.equal(env, s.envText.replace(s.oldKey, newKey), 'only the key changed: quotes, comments, other lines intact');
  t.assert.equal((await stat(join(s.dir, 'web', '.env'))).mode & 0o777, 0o600, 'file permissions kept');
  t.assert.ok((await readFile(join(s.dir, 'web', '.env.production'), 'utf8')).includes(newKey));
  t.assert.ok(!(await readdir(join(s.dir, 'web'))).some((f) => f.startsWith('.burnkeys-tmp-')), 'no temp files left');

  const [stamp] = await readdir(s.backupRoot);
  const backups = await readdir(join(s.backupRoot, stamp));
  t.assert.equal(backups.length, 2);
  t.assert.ok((await readFile(join(s.backupRoot, stamp, backups[0]), 'utf8')).includes(s.oldKey));
  assertNoSecrets(t, text, [s.oldKey, newKey, s.other]);
});

test('replace: a new key that does not work changes nothing (3 tries, never back to the shell)', async (t) => {
  const s = await setup();
  const newKey = fake.anthropic();
  const { code, text } = await capture(() =>
    replace(s.dir, fingerprint(s.oldKey), { readSecret: answers(newKey, newKey, newKey), confirm: answers('y'), fetchImpl: fakeFetch(new Set()).impl, backupRoot: s.backupRoot }));
  t.assert.equal(code, 1);
  t.assert.match(text, /does not work.*Nothing was changed/);
  t.assert.equal(text.match(/Try again/g).length, 2);
  t.assert.equal(await readFile(join(s.dir, 'web', '.env'), 'utf8'), s.envText);
  assertNoSecrets(t, text, [s.oldKey, newKey]);
});

test('replace: wrong provider, same key, or "no" at the prompt change nothing', async (t) => {
  const s = await setup();
  const fp = fingerprint(s.oldKey);
  const opts = (key, yes = 'y') => ({ readSecret: answers(key), confirm: answers(yes), fetchImpl: fakeFetch(new Set([key])).impl, backupRoot: s.backupRoot });

  const opts1 = (key, yes = 'y') => ({ ...opts(key, yes), readSecret: answers(key, key, key) });
  let r = await capture(() => replace(s.dir, fp, opts1(fake.openrouter())));
  t.assert.match(r.text, /does not look like a Anthropic key/);
  r = await capture(() => replace(s.dir, fp, opts1(s.oldKey)));
  t.assert.match(r.text, /same key/);
  r = await capture(() => replace(s.dir, fp, opts(fake.anthropic(), 'n')));
  t.assert.match(r.text, /Cancelled/);
  r = await capture(() => replace(s.dir, 'fp:00000000', opts(fake.anthropic())));
  t.assert.match(r.text, /No secret with fingerprint/);

  t.assert.equal(await readFile(join(s.dir, 'web', '.env'), 'utf8'), s.envText);
});

test('replace: retry after a rejected key, and warn when the key is used by another project', async (t) => {
  const s = await setup();
  const bad = fake.anthropic(), good = fake.anthropic();
  const other = join(s.dir, 'other-project');
  await mkdir(other);
  await writeFile(join(other, '.env'), `ANTHROPIC_API_KEY=${good}\n`);
  const { code, text } = await capture(() =>
    replace(join(s.dir, 'web'), fingerprint(s.oldKey), {
      readSecret: answers(bad, good), confirm: answers('y'), fetchImpl: fakeFetch(new Set([good])).impl,
      backupRoot: s.backupRoot, reuseScanRoot: s.dir,
    }));
  t.assert.equal(code, 0);
  t.assert.match(text, /REJECTED.*\n.*Try again/);
  t.assert.match(text, /already used in: other-project\/\.env/);
  assertNoSecrets(t, text, [bad, good, s.oldKey]);
});

test('replace: updates the key on a linked Vercel project and redeploys production', async (t) => {
  const s = await setup();
  const newKey = fake.anthropic();
  const vercelToken = fake.generic() + fake.generic();
  await mkdir(join(s.dir, 'web', '.vercel'));
  await writeFile(join(s.dir, 'web', '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_1', orgId: 'team_9', projectName: 'my-store' }));
  await writeFile(join(s.dir, '.vercel.env'), `VERCEL_TOKEN=${vercelToken}\n`);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, team: u.searchParams.get('teamId'), auth: opts.headers.Authorization, body: opts.body });
    const reply = (status, json) => ({ status, json: async () => json, body: { cancel: async () => {} } });
    if (u.host === 'api.anthropic.com') return reply(opts.headers['x-api-key'] === newKey ? 200 : 401, {});
    if (opts.method === 'GET' && u.pathname.endsWith('/env')) return reply(200, { envs: [{ id: 'e1', key: 'ANTHROPIC_API_KEY', target: ['production', 'preview'] }, { id: 'e2', key: 'OTHER' }] });
    if (opts.method === 'PATCH') return reply(200, { key: 'ANTHROPIC_API_KEY', value: newKey });
    if (u.pathname === '/v7/deployments') return reply(200, { deployments: [{ uid: 'dpl_1', name: 'my-store' }] });
    if (u.pathname === '/v13/deployments') return reply(200, { url: 'my-store-abc.vercel.app' });
    return reply(404, {});
  };
  let offered;
  const { code, text } = await capture(() => replace(s.dir, fingerprint(s.oldKey), {
    readSecret: answers(newKey), confirm: answers('y', 'y', 'y'), fetchImpl, backupRoot: s.backupRoot,
    getVercelToken: async (candidates) => { offered = candidates; return candidates[0].value; },
  }));
  t.assert.equal(code, 0);
  t.assert.equal(offered[0].file, '.vercel.env', 'the VERCEL_TOKEN found in the project is offered');
  t.assert.match(text, /✅ Vercel ANTHROPIC_API_KEY \(production, preview\): updated/);
  t.assert.match(text, /Redeploy started: https:\/\/my-store-abc\.vercel\.app/);

  const patch = calls.find((c) => c.method === 'PATCH');
  t.assert.equal(patch.path, '/v9/projects/prj_1/env/e1');
  t.assert.equal(patch.team, 'team_9');
  t.assert.equal(patch.auth, `Bearer ${vercelToken}`);
  t.assert.equal(JSON.parse(patch.body).value, newKey);
  t.assert.ok(!calls.some((c) => c.path.endsWith('/env/e2')), 'other variables untouched');
  t.assert.deepEqual(JSON.parse(calls.find((c) => c.path === '/v13/deployments').body),
    { name: 'my-store', project: 'prj_1', deploymentId: 'dpl_1', target: 'production' });
  assertNoSecrets(t, text, [newKey, s.oldKey, vercelToken]);
});

test('replace: Vercel token rejected -> clear message, local files still updated', async (t) => {
  const s = await setup();
  const newKey = fake.anthropic();
  await mkdir(join(s.dir, 'web', '.vercel'));
  await writeFile(join(s.dir, 'web', '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_1', orgId: 'user_1' }));
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const status = u.host === 'api.anthropic.com' ? 200 : 403;
    return { status, json: async () => ({}), body: { cancel: async () => {} } };
  };
  const { code, text } = await capture(() => replace(s.dir, fingerprint(s.oldKey), {
    readSecret: answers(newKey), confirm: answers('y', 'y'), fetchImpl, backupRoot: s.backupRoot,
    getVercelToken: async () => 'tok_' + fake.generic(),
  }));
  t.assert.equal(code, 1);
  t.assert.match(text, /Done: 2 of 2 file\(s\) updated/);
  t.assert.match(text, /Vercel token rejected or lacks access. Nothing changed on Vercel/);
});

test('push: sends a local key to the linked Vercel project', async (t) => {
  const s = await setup();
  await mkdir(join(s.dir, 'web', '.vercel'));
  await writeFile(join(s.dir, 'web', '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_1', orgId: 'user_1' }));
  const patched = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    if (opts.method === 'PATCH') patched.push(JSON.parse(opts.body).value);
    const json = u.pathname.endsWith('/env') ? { envs: [{ id: 'e1', key: 'ANTHROPIC_API_KEY', target: ['production'] }] } : {};
    return { status: 200, json: async () => json, body: { cancel: async () => {} } };
  };
  const { code, text } = await capture(() => push(s.dir, fingerprint(s.oldKey), { confirm: answers('y', 'n'), fetchImpl, getVercelToken: async () => 'tok_' + fake.generic() }));
  t.assert.equal(code, 0);
  t.assert.deepEqual(patched, [s.oldKey]);
  t.assert.match(text, /✅ Vercel ANTHROPIC_API_KEY \(production\): updated/);
  assertNoSecrets(t, text, [s.oldKey]);
});
