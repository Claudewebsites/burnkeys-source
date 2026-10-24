#!/usr/bin/env node
import { scan, verify, compare } from '../src/commands.js';
import { replace, push } from '../src/replace.js';
import { promptHidden, promptVisible } from '../src/prompt.js';
import { printErr, scrub } from '../src/output.js';
import { takeKeyFromClipboard } from '../src/clipboard.js';
import { execFile } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [cmd, ...args] = argv.filter((a) => !a.startsWith('--'));
const mac = process.platform === 'darwin';

// Read a key: typed/pasted into a hidden prompt, or - if the user just presses
// Enter - taken from the clipboard (then cleared). With --wait-clipboard there is
// no prompt at all: Burnkeys waits until a new key is copied.
async function readKey(question) {
  if (flags.has('--wait-clipboard') && mac) {
    return takeKeyFromClipboard({ wait: true, log: (m) => process.stderr.write(m + '\n') });
  }
  const typed = await promptHidden(question);
  if (typed || !mac) return typed;
  const clip = await takeKeyFromClipboard();
  process.stderr.write(clip ? '  (taken from the clipboard, clipboard cleared)\n' : '  (no key found in the clipboard)\n');
  return clip;
}

// Confirmations. --yes accepts writing local files; Vercel steps also need --vercel.
async function confirm(question) {
  if (!flags.has('--yes')) return promptVisible(question);
  const hostStep = /Vercel|Redeploy|VERCEL_TOKEN/.test(question);
  const answer = hostStep && !flags.has('--vercel') ? 'n' : 'y';
  process.stderr.write(question + answer + '\n');
  return answer;
}

// Vercel token: from the environment, a VERCEL_TOKEN found in the project (with consent), or typed hidden.
async function getVercelToken(candidates) {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  for (const c of candidates) {
    const a = await confirm(`Use the VERCEL_TOKEN found in ${c.file} (${c.fp})? [y/N] `);
    if (/^y(es)?$/i.test(a)) return c.value;
  }
  if (flags.has('--yes')) return '';
  return promptHidden('Vercel token (vercel.com/account/settings/tokens), or Enter to skip (hidden): ');
}

// Open a provider page in the default browser (macOS; always with --open).
const openUrl = mac && (process.stdin.isTTY || flags.has('--open'))
  ? (url) => execFile('open', [url], () => {})
  : undefined;

const HELP = `burnkeys - rotate leaked API keys without ever printing them

Usage:
  burnkeys scan [path]      Find secrets in .env files, show provider, fingerprint and rotation link
  burnkeys verify [path]    Check which keys still work (status only)
  burnkeys compare          Paste old + new key (hidden) - confirms new works and old is dead
  burnkeys replace <fp> [path]
                           Replace the key with that fingerprint in every env file under path
                           (new key checked first, files backed up, then written)
  burnkeys push <fp> [path] Send that key from your env files to the linked Vercel project

  burnkeys hook install [repo]
                           Block git commits that contain API keys (pre-commit hook)
  burnkeys mcp              Run as an MCP server for Cursor, Codex, Claude Desktop (statuses only, never keys)
  burnkeys app [folder]     Open the Burnkeys window (finds projects in your usual code folders, or in [folder])

Options for replace/push (used by the Claude Code plugin):
  --open             open the provider's key page in the browser
  --wait-clipboard   no prompt: wait until a new key is copied, take it, clear the clipboard
  --yes              do not ask before writing local files
  --vercel           with --yes: also update the linked Vercel project and redeploy

path defaults to the current directory. Burnkeys never prints, logs or uploads secret values.
`;

// Last line of defence: never let an error message leak a secret.
process.on('uncaughtException', (err) => {
  printErr('Error: ' + scrub(err?.message ?? err));
  process.exit(1);
});

let code;
switch (cmd) {
  case 'scan':
    code = await scan(args[0] ?? '.');
    break;
  case 'verify':
    code = await verify(args[0] ?? '.');
    break;
  case 'compare':
    code = await compare({ readSecret: readKey });
    break;
  case 'replace': {
    const target = resolve(args[1] ?? '.');
    code = await replace(target, args[0], { readSecret: readKey, confirm, openUrl, reuseScanRoot: dirname(target), getVercelToken });
    break;
  }
  case 'push':
    code = await push(resolve(args[1] ?? '.'), args[0], { confirm, getVercelToken });
    break;
  case 'app': {
    const { startApp } = await import('../src/app/server.js');
    // Optional folder argument limits the project search (handy for demos); default: the usual code folders.
    const roots = args[0] ? [resolve(args[0])] : undefined;
    const dataDir = flags.has('--demo') ? join(resolve(args[0] ?? '.'), '.burnkeys-demo') : undefined;
    const app = await startApp({ roots, ...(dataDir && { dataDir }), openUrl: mac ? (u) => execFile('open', [u], () => {}) : undefined });
    process.stdout.write(`Burnkeys is running at ${app.url.split('#')[0]}\nPress Ctrl+C to quit.\n`);
    if (mac && !flags.has('--no-open')) execFile('open', [app.url], () => {});
    else process.stdout.write(`Open: ${app.url}\n`);
    // Quit by itself once the window has been closed for 30 minutes.
    // ...or right away if the Mac app that started it is gone.
    const parent = process.ppid;
    setInterval(() => { if (app.idleMs() > 30 * 60_000) process.exit(0); }, 60_000);
    if (flags.has('--no-open')) setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 2000);
    await new Promise(() => {});
    break;
  }
  case 'hook': {
    // burnkeys hook install|uninstall [repo]   or   burnkeys hook run (called by git)
    const { installHook, uninstallHook, checkStaged } = await import('../src/hook.js');
    const sub = args[0], repo = resolve(args[1] ?? '.');
    if (sub === 'install') { const r = await installHook(repo); process.stdout.write(r.ok ? `Burnkeys now blocks commits with API keys in ${repo}.\n` : `${r.error}\n`); code = r.ok ? 0 : 1; break; }
    if (sub === 'uninstall') { await uninstallHook(repo); process.stdout.write('Removed the Burnkeys commit check.\n'); code = 0; break; }
    if (sub === 'run') {
      let problems = [];
      try { problems = await checkStaged(process.cwd()); } catch { code = 0; break; } // never block a commit on our own error
      if (!problems.length) { code = 0; break; }
      printErr('\nBurnkeys stopped this commit:');
      for (const p of problems) printErr(`  ${p.file}: ${p.provider}${p.fp ? ' ' + p.fp : ''} (${p.why})`);
      printErr('\nMove the key to a .env file that git ignores, or skip this check once with: git commit --no-verify\n');
      code = 3; break; // 3 = key found (the hook script blocks only on 3)
    }
    printErr('Usage: burnkeys hook install [repo] | uninstall [repo] | run');
    code = 2; break;
  }
  case 'mcp': {
    // MCP server on stdio for Cursor, Codex, Claude Desktop... (statuses only, never key values).
    const { runMcp } = await import('../src/mcp.js');
    await runMcp();
    code = 0;
    break;
  }
  case 'agent': {
    // One background round, started by the LaunchAgent through the Mac app (Pro).
    const { startApp } = await import('../src/app/server.js');
    const app = await startApp({});
    try { await app.runBackground(); } finally { await app.close(); }
    code = 0;
    break;
  }
  case undefined:
  case '-h':
  case 'help':
    process.stdout.write(HELP);
    code = 0;
    break;
  default:
    if (flags.has('--help') || flags.has('-h')) { process.stdout.write(HELP); code = 0; break; }
    printErr(`Unknown command: ${cmd}\n`);
    process.stdout.write(HELP);
    code = 2;
}
process.exit(code);
