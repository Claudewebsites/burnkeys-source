import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, chmod, mkdir, unlink } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSecretsInText } from './detect.js';

// A git pre-commit hook that refuses commits containing API keys. Runs on this Mac only:
// it reads the staged changes, and prints provider + fingerprint, never a value.
const MARK = '# burnkeys: block commits that contain API keys';
const git = (cwd, args) => new Promise((ok) => execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out) => ok(err ? null : String(out))));
const EXAMPLE = /(example|sample|template|dist|defaults?)$/i;

async function hookPath(repo) {
  const p = (await git(repo, ['rev-parse', '--git-path', 'hooks/pre-commit']))?.trim();
  return p ? resolve(repo, p) : null;
}

export async function hookInstalled(repo) {
  const p = await hookPath(repo);
  return !!p && (await readFile(p, 'utf8').catch(() => '')).includes(MARK);
}

export async function installHook(repo) {
  const p = await hookPath(repo);
  if (!p) return { ok: false, error: 'Not a git repository.' };
  const existing = await readFile(p, 'utf8').catch(() => null);
  if (existing?.includes(MARK)) return { ok: true, already: true };
  if (existing != null) await rename(p, p + '.local'); // keep the project's own hook and run it after ours
  const node = process.execPath, cli = fileURLToPath(new URL('../bin/burnkeys.js', import.meta.url));
  const script = `#!/bin/sh
${MARK}. Skip once with: git commit --no-verify
# Exit code 1 means "a key was found"; anything else (an old Burnkeys, no Burnkeys) never blocks.
if [ -x "${node}" ] && [ -f "${cli}" ]; then "${node}" "${cli}" hook run
elif [ -x /Applications/Burnkeys.app/Contents/Resources/node/bin/node ]; then /Applications/Burnkeys.app/Contents/Resources/node/bin/node /Applications/Burnkeys.app/Contents/Resources/engine/bin/burnkeys.js hook run
elif command -v burnkeys >/dev/null 2>&1; then burnkeys hook run
else true
fi
[ $? -eq 1 ] && exit 1
if [ -x "$0.local" ]; then exec "$0.local" "$@"; fi
exit 0
`;
  await mkdir(resolve(p, '..'), { recursive: true });
  await writeFile(p, script);
  await chmod(p, 0o755);
  return { ok: true };
}

export async function uninstallHook(repo) {
  const p = await hookPath(repo);
  if (!p || !(await hookInstalled(repo))) return { ok: true };
  await unlink(p);
  await rename(p + '.local', p).catch(() => {});
  return { ok: true };
}

// Check what is staged right now. Returns [{ file, provider, fp, why }].
export async function checkStaged(repo = process.cwd()) {
  const problems = [];
  const files = ((await git(repo, ['diff', '--cached', '--name-only', '--diff-filter=ACM'])) ?? '').split('\n').filter(Boolean);
  for (const f of files) {
    const name = basename(f);
    if (/^\.env(\..+)?$/.test(name) && !EXAMPLE.test(name)) problems.push({ file: f, provider: 'env file', fp: '', why: 'an .env file is being committed' });
  }
  const diff = (await git(repo, ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACM'])) ?? '';
  let file = null, added = [];
  const flush = () => {
    if (file && added.length && !EXAMPLE.test(basename(file))) {
      for (const s of detectSecretsInText(added.join('\n'))) problems.push({ file, provider: s.provider, fp: s.fp, why: 'a key in the new lines' });
    }
    added = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { flush(); file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  flush();
  return problems;
}
