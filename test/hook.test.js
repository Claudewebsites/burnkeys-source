import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHook, uninstallHook, checkStaged } from '../src/hook.js';

const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'bk-hook-'));
  for (const a of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) execFileSync('git', a, { cwd: d });
  return d;
};
const fakeKey = () => 'sk-proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3iJk6l';

test('commit check: blocks a key and an .env file, lets a clean commit through', async () => {
  const d = repo();
  try {
    assert.equal((await installHook(d)).ok, true);
    writeFileSync(join(d, 'config.js'), `const k = "${fakeKey()}";\n`);
    execFileSync('git', ['add', 'config.js'], { cwd: d });
    const found = await checkStaged(d);
    assert.equal(found.length, 1);
    assert.ok(!JSON.stringify(found).includes(fakeKey()), 'never reports the value');
    assert.notEqual(spawnSync('git', ['commit', '-qm', 'k'], { cwd: d }).status, 0);
    execFileSync('git', ['reset', '-q'], { cwd: d }); rmSync(join(d, 'config.js'));
    writeFileSync(join(d, '.env'), 'X=1\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: d });
    assert.equal((await checkStaged(d))[0].why, 'an .env file is being committed');
    execFileSync('git', ['reset', '-q'], { cwd: d }); rmSync(join(d, '.env'));
    writeFileSync(join(d, 'ok.txt'), 'hi\n');
    execFileSync('git', ['add', 'ok.txt'], { cwd: d });
    assert.equal(spawnSync('git', ['commit', '-qm', 'ok'], { cwd: d }).status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('commit check: keeps an existing hook and leaves husky projects alone', async () => {
  const d = repo();
  try {
    const p = join(d, '.git', 'hooks', 'pre-commit');
    writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await installHook(d);
    assert.ok(existsSync(p + '.local'));
    await uninstallHook(d);
    assert.equal(readFileSync(p, 'utf8'), '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: d });
    assert.match((await installHook(d)).error, /husky/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
