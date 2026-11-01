import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// The Claude Code builds Cursor pulled from its marketplace on 29 Oct 2026.
// Other versions of the same extension are the real one and are left alone.
const BAD = new Set(['2.1.312', '2.1.313']);
export const EXTENSION_NOTICE = 'https://cursor.com/blog/claude-code-extension-security-notice';

const EDITORS = [
  ['Cursor', '.cursor', 'extensions'],
  ['Cursor', 'Library', 'Application Support', 'Cursor', 'User', 'extensions'],
  ['Visual Studio Code', '.vscode', 'extensions'],
];

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export async function scanExtensions(home) {
  const installed = [];
  for (const parts of EDITORS) {
    const app = parts[0];
    const dir = join(home, ...parts.slice(1));
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const version = name.match(/^anthropic\.claude-code-(\d+\.\d+\.\d+)/)?.[1];
      if (!version || !BAD.has(version)) continue;
      installed.push({ app, version });
    }
  }
  const traces = [];
  const ssh = join(home, '.ssh', 'authorized_keys');
  try {
    if ((await readFile(ssh, 'utf8')).includes('svc-telemetry')) traces.push('ssh-key');
  } catch { /* no keys file */ }
  if (await exists(join(home, 'Library', 'LaunchAgents', 'com.apple.sysmond.plist'))) traces.push('launch-agent');
  if (await exists(join(home, '.config', '.smt')) || await exists(join(home, '.config', '.smtk'))) traces.push('script');
  return { installed, traces, notice: EXTENSION_NOTICE };
}
