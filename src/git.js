import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? '').trim() });
    });
  });
}

// 'tracked'  - the file is committed to git (it may already be on GitHub)
// 'exposed'  - inside a git repo but NOT covered by .gitignore
// 'ignored'  - covered by .gitignore
// 'no-git'   - not inside a git repository
export async function gitSafety(file) {
  const cwd = dirname(file);
  const inRepo = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inRepo.ok || inRepo.stdout !== 'true') return 'no-git';
  const tracked = await git(['ls-files', '--error-unmatch', '--', file], cwd);
  if (tracked.ok) return 'tracked';
  const ignored = await git(['check-ignore', '-q', '--', file], cwd);
  return ignored.ok ? 'ignored' : 'exposed';
}
