import { test } from 'node:test';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan, verify, compare } from '../src/commands.js';
import { fingerprint } from '../src/fingerprint.js';
import { fake, tempDir, capture, fakeFetch, assertNoSecrets } from './helpers.js';

async function makeProjects() {
  const dir = await tempDir();
  const k = {
    anthropic: fake.anthropic(),
    openrouter: fake.openrouter(),
    fish: fake.generic(),
    password: fake.generic(),
  };
  // Project A: proper git repo, .env ignored; same Anthropic key in two files.
  await mkdir(join(dir, 'app-a'));
  execFileSync('git', ['init', '-q'], { cwd: join(dir, 'app-a') });
  await writeFile(join(dir, 'app-a', '.gitignore'), '.env\n');
  await writeFile(join(dir, 'app-a', '.env'), `ANTHROPIC_API_KEY=${k.anthropic}\nOPENROUTER_API_KEY="${k.openrouter}"\nPORT=3000\n`);
  await writeFile(join(dir, 'app-a', '.env.production'), `ANTHROPIC_API_KEY=${k.anthropic}\nFISH_AUDIO_API_KEY=${k.fish}\n`);
  // Project B: .env not covered by .gitignore, and a "safe" example file holding a real key.
  await mkdir(join(dir, 'app-b'));
  execFileSync('git', ['init', '-q'], { cwd: join(dir, 'app-b') });
  await writeFile(join(dir, 'app-b', '.env'), `ADMIN_PASSWORD=${k.password}\n`);
  await writeFile(join(dir, 'app-b', '.env.example'), `CLAUDE_KEY=${k.anthropic}\n`);
  // node_modules must be skipped.
  await mkdir(join(dir, 'app-a', 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'app-a', 'node_modules', 'x', '.env'), `SHOULD_NOT=${fake.openai()}\n`);
  return { dir, k };
}

test('scan finds providers, groups duplicates, flags unsafe files, never prints secrets', async (t) => {
  const { dir, k } = await makeProjects();
  const { code, text } = await capture(() => scan(dir));
  t.assert.equal(code, 0);
  t.assert.match(text, /Anthropic\s/);
  t.assert.match(text, /OpenRouter/);
  t.assert.match(text, /Fish Audio \(by name\)/);
  t.assert.match(text, /Your own secret/);
  t.assert.ok(!text.includes('OpenAI'), 'node_modules is skipped');
  t.assert.ok(text.includes(fingerprint(k.anthropic)));
  t.assert.match(text, /\(3 places\)/); // same Anthropic key in 3 files
  t.assert.match(text, /app-b\/\.env is NOT covered by \.gitignore/);
  t.assert.match(text, /\.env\.example is an example file but contains/);
  t.assert.match(text, /platform\.claude\.com\/settings\/keys/);
  assertNoSecrets(t, text, Object.values(k));
});

test('scan flags env files committed to git', async (t) => {
  const dir = await tempDir();
  const key = fake.openrouter();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await writeFile(join(dir, '.env'), `OPENROUTER_API_KEY=${key}\n`);
  execFileSync('git', ['add', '.env'], { cwd: dir });
  const { text } = await capture(() => scan(dir));
  t.assert.match(text, /🔴 \.env is committed to git/);
  assertNoSecrets(t, text, [key]);
});

test('verify reports status only and sends each key only to its own provider', async (t) => {
  const { dir, k } = await makeProjects();
  const ff = fakeFetch(new Set([k.anthropic])); // Anthropic alive, OpenRouter dead
  const { code, text } = await capture(() => verify(dir, { fetchImpl: ff.impl }));
  t.assert.equal(code, 1);
  t.assert.match(text, /Anthropic.*✅ works/);
  t.assert.match(text, /OpenRouter.*❌ REJECTED/);
  t.assert.match(text, /1 other secret\(s\) not checked/);
  t.assert.match(text, /Fish Audio.*REJECTED/);
  // Deduplicated: the Anthropic key in 3 files is checked once.
  t.assert.equal(ff.calls.length, 3);
  for (const c of ff.calls) {
    if (c.key === k.anthropic) t.assert.equal(c.host, 'api.anthropic.com');
    if (c.key === k.openrouter) t.assert.equal(c.host, 'openrouter.ai');
    if (c.key === k.fish) t.assert.equal(c.host, 'api.fish.audio');
  }
  t.assert.ok(!ff.calls.some((c) => c.key === k.password), 'your own secrets are never sent anywhere');
  assertNoSecrets(t, text, Object.values(k));
});

function reader(...values) {
  return async () => values.shift();
}

test('compare: rotation complete', async (t) => {
  const oldKey = fake.anthropic(), newKey = fake.anthropic();
  const ff = fakeFetch(new Set([newKey]));
  const { code, text } = await capture(() => compare({ readSecret: reader(oldKey, newKey), fetchImpl: ff.impl }));
  t.assert.equal(code, 0);
  t.assert.match(text, /Rotation complete/);
  assertNoSecrets(t, text, [oldKey, newKey]);
});

test('compare: old key still active', async (t) => {
  const oldKey = fake.openrouter(), newKey = fake.openrouter();
  const ff = fakeFetch(new Set([oldKey, newKey]));
  const { code, text } = await capture(() => compare({ readSecret: reader(oldKey, newKey), fetchImpl: ff.impl }));
  t.assert.equal(code, 1);
  t.assert.match(text, /OLD key is still active/);
  t.assert.ok(text.includes(fingerprint(oldKey)));
  assertNoSecrets(t, text, [oldKey, newKey]);
});

test('compare: new key deleted by mistake (the Firebase incident)', async (t) => {
  const oldKey = fake.anthropic(), newKey = fake.anthropic();
  const ff = fakeFetch(new Set([oldKey]));
  const { code, text } = await capture(() => compare({ readSecret: reader(oldKey, newKey), fetchImpl: ff.impl }));
  t.assert.equal(code, 1);
  t.assert.match(text, /NEW key does not work. Do NOT revoke the old key/);
  assertNoSecrets(t, text, [oldKey, newKey]);
});

test('compare: rejects identical keys and mixed providers', async (t) => {
  const a = fake.anthropic();
  let r = await capture(() => compare({ readSecret: reader(a, a), fetchImpl: fakeFetch(new Set()).impl }));
  t.assert.match(r.text, /same key/);
  r = await capture(() => compare({ readSecret: reader(a, fake.openrouter()), fetchImpl: fakeFetch(new Set()).impl }));
  t.assert.match(r.text, /different providers/);
  assertNoSecrets(t, r.text, [a]);
});

test('CLI end to end: scan prints no secrets', async (t) => {
  const { dir, k } = await makeProjects();
  const bin = new URL('../bin/burnkeys.js', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [bin, 'scan', dir], { encoding: 'utf8' });
  t.assert.match(out, /unique secret/);
  assertNoSecrets(t, out, Object.values(k));
});
