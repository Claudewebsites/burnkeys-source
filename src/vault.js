import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// Keys saved in the macOS Keychain (service "burnkeys"). The secret is passed to
// `security` on stdin - never as a command-line argument, so it can't show up
// in the process list. A small index (no secrets) lists what is stored.

const SERVICE = 'burnkeys';

function runSecurity(args, input) {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    p.on('error', () => resolve({ code: 1, out: '' }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

export const macKeychain = {
  async set(account, secret) {
    if (/["\\\n\r]/.test(account)) return false;
    // `security -i` can't take quotes, backslashes or newlines: store those values base64.
    if (/["\\\n\r]/.test(secret)) secret = 'b64:' + Buffer.from(secret).toString('base64');
    // Interactive mode reads the command from stdin.
    const r = await runSecurity(['-i'], `add-generic-password -U -s ${SERVICE} -a "${account}" -w "${secret}"\n`);
    return r.code === 0;
  },
  async get(account) {
    // Keys saved by the Mac app are locked to the app; the CLI never asks macOS for them.
    const r = await runSecurity(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    if (r.code !== 0) return null;
    const v = r.out.replace(/\n$/, '');
    return v.startsWith('b64:') ? Buffer.from(v.slice(4), 'base64').toString() : v;
  },
  async remove(account) {
    return (await runSecurity(['delete-generic-password', '-s', SERVICE, '-a', account])).code === 0;
  },
};

// Inside the Mac app the engine doesn't touch the Keychain itself: it asks the app over a private
// pipe (requests on stderr, answers on stdin). The app saves keys as its own Keychain items, so only
// Burnkeys can read them; any other program (even `security`) gets a macOS permission prompt.
const APP_TAG = 'BKKC ';
let appSeq = 0, appReader = null;
const appPending = new Map();
function appCall(op, account, value) {
  if (!appReader) {
    appReader = createInterface({ input: process.stdin, terminal: false });
    appReader.on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const done = appPending.get(m.id); if (!done) return;
      appPending.delete(m.id); done(m);
      if (!appPending.size) process.stdin.unref?.();
    });
  }
  process.stdin.ref?.();
  return new Promise((resolve) => {
    const id = ++appSeq;
    appPending.set(id, resolve);
    process.stderr.write(APP_TAG + JSON.stringify({ id, op, account, ...(value !== undefined && { value }) }) + '\n');
    setTimeout(() => { if (appPending.delete(id)) { resolve({ ok: false }); if (!appPending.size) process.stdin.unref?.(); } }, 8_000).unref();
  });
}
const legacyGet = async (account) => { const r = await runSecurity(['find-generic-password', '-s', SERVICE, '-a', account, '-w']); if (r.code !== 0) return null; const v = r.out.replace(/\n$/, ''); return v.startsWith('b64:') ? Buffer.from(v.slice(4), 'base64').toString() : v; };
export const appKeychain = {
  async set(account, secret) { return !!(await appCall('set', account, secret)).ok; },
  async get(account) { const r = await appCall('get', account); return r.ok ? r.value ?? null : legacyGet(account); },
  async remove(account) { return !!(await appCall('delete', account)).ok; },
};
export const inApp = process.env.BURNKEYS_KEYCHAIN === 'app';
export const defaultKeychain = inApp ? appKeychain : macKeychain;

// Move keys saved by older versions (through `security`, readable by any program) into the app's
// own Keychain items. Each key is read back before the old copy is deleted.
export async function moveToAppKeychain(accounts) {
  let moved = 0;
  for (const account of accounts) {
    const v = await legacyGet(account); // only the old, unlocked copy: never anything that would prompt
    if (v == null) continue;
    if (!(await appKeychain.set(account, v)) || (await appKeychain.get(account)) !== v) continue;
    await macKeychain.remove(account);
    moved++;
  }
  return moved;
}

export function createVault({ dataDir = join(homedir(), '.burnkeys'), keychain = defaultKeychain } = {}) {
  const indexPath = join(dataDir, 'vault.json');
  const load = async () => { try { return JSON.parse(await readFile(indexPath, 'utf8')); } catch { return []; } };
  const save = async (items) => { await mkdir(dataDir, { recursive: true, mode: 0o700 }); await writeFile(indexPath, JSON.stringify(items, null, 1), { mode: 0o600 }); };
  return {
    list: load,
    async add({ providerId, fp, secret }) {
      const account = `${providerId}:${fp}`;
      if (!(await keychain.set(account, secret))) return false;
      const items = (await load()).filter((i) => i.account !== account);
      items.push({ account, providerId, fp, savedAt: Date.now() });
      await save(items);
      return true;
    },
    async get(fp) {
      const item = (await load()).find((i) => i.fp === fp);
      return item ? keychain.get(item.account) : null;
    },
    async remove(fp) {
      const items = await load();
      const item = items.find((i) => i.fp === fp);
      if (item) await keychain.remove(item.account);
      await save(items.filter((i) => i.fp !== fp));
    },
  };
}
