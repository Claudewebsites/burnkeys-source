import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectSecretsInText } from '../src/detect.js';
import { checkProject } from '../src/sessioncheck.js';
import { fingerprint } from '../src/fingerprint.js';
import { fake, tempDir, fakeFetch, assertNoSecrets } from './helpers.js';

const root = new URL('..', import.meta.url).pathname;
const runHook = (script, input) =>
  execFileSync(process.execPath, [join(root, 'hooks', script)], { input: JSON.stringify(input), encoding: 'utf8' });

test('detect: finds keys in chat text, ignores normal text', (t) => {
  const a = fake.anthropic(), o = fake.openrouter(), pw = fake.generic();
  t.assert.deepEqual(detectSecretsInText('can you fix the login page? it shows error 500').length, 0);
  t.assert.deepEqual(detectSecretsInText('my key is ' + a).map((f) => f.provider), ['Anthropic']);
  t.assert.equal(detectSecretsInText(`here:\nOPENROUTER_API_KEY="${o}"\n`)[0].fp, fingerprint(o));
  t.assert.equal(detectSecretsInText(`ADMIN_PASSWORD=${pw}`)[0].provider, 'Your own secret');
  t.assert.equal(detectSecretsInText('-----BEGIN ' + 'PRIVATE KEY-----\nabc')[0].provider, 'Private key');
  t.assert.equal(detectSecretsInText('PORT=3000 and NODE_ENV=production').length, 0);
});

test('guard hook: blocks a message with a key, without echoing it', (t) => {
  const key = fake.anthropic();
  const out = runHook('guard.js', { hook_event_name: 'UserPromptSubmit', prompt: 'use this: ' + key });
  const res = JSON.parse(out);
  t.assert.equal(res.decision, 'block');
  t.assert.equal(res.hookSpecificOutput.suppressOriginalPrompt, true);
  t.assert.match(res.reason, /Anthropic \(fp:\w{8}\)/);
  assertNoSecrets(t, out, [key]);
});

test('guard hook: lets normal messages through, and survives bad input', (t) => {
  t.assert.equal(runHook('guard.js', { prompt: 'refactor the header component' }), '');
  const out = execFileSync(process.execPath, [join(root, 'hooks', 'guard.js')], { input: 'not json', encoding: 'utf8' });
  t.assert.equal(out, '');
});

test('session check: reports dead keys, stays quiet when all work, caches by fingerprint', async (t) => {
  const dir = await tempDir();
  const dead = fake.anthropic(), alive = fake.openrouter();
  await writeFile(join(dir, '.env'), `ANTHROPIC_API_KEY=${dead}\nOPENROUTER_API_KEY=${alive}\n`);
  const cacheDir = join(dir, 'cache');

  const ff = fakeFetch(new Set([alive]));
  const r = await checkProject(dir, { fetchImpl: ff.impl, cacheDir });
  t.assert.equal(r.dead.length, 1);
  t.assert.match(r.summary, /Anthropic key ANTHROPIC_API_KEY \(fp:\w{8}\) in \.env was rejected by its provider/);
  assertNoSecrets(t, r.summary, [dead, alive]);
  t.assert.equal(ff.calls.length, 2);

  const cache = await readFile(join(cacheDir, 'status-cache.json'), 'utf8');
  assertNoSecrets(t, cache, [dead, alive]);
  const again = fakeFetch(new Set([alive]));
  await checkProject(dir, { fetchImpl: again.impl, cacheDir });
  t.assert.equal(again.calls.length, 0, 'second check within 6 hours uses the cache');

  const allGood = await checkProject(dir, { fetchImpl: fakeFetch(new Set([dead, alive])).impl, cacheDir: join(dir, 'c2') });
  t.assert.equal(allGood, null);
  t.assert.equal(await checkProject(await tempDir(), { cacheDir }), null, 'no env files: nothing to say');
});

test('session hook: silent outside projects with env files', async (t) => {
  const out = runHook('session-check.js', { hook_event_name: 'SessionStart', source: 'startup', cwd: await tempDir() });
  t.assert.equal(out, '');
});
