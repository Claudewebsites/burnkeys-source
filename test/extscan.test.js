import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanExtensions } from '../src/extscan.js';

test('flags only the malicious Claude Code builds and leftover traces', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bk-ext-'));
  const ext = join(home, '.cursor', 'extensions');
  await mkdir(join(ext, 'anthropic.claude-code-2.1.313'), { recursive: true });
  await mkdir(join(ext, 'anthropic.claude-code-2.1.314'), { recursive: true });
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA comment\nssh-ed25519 BBBB svc-telemetry\n');
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(join(home, 'Library', 'LaunchAgents', 'com.apple.sysmond.plist'), '<plist/>');

  const hit = await scanExtensions(home);
  t.assert.deepEqual(hit.installed, [{ app: 'Cursor', version: '2.1.313' }]);
  t.assert.deepEqual(hit.traces, ['ssh-key', 'launch-agent']);

  const clean = await mkdtemp(join(tmpdir(), 'bk-ext-'));
  const none = await scanExtensions(clean);
  t.assert.deepEqual(none.installed, []);
  t.assert.deepEqual(none.traces, []);
});
