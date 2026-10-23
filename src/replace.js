import { readFile, writeFile, rename, stat, chmod, mkdir, copyFile, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { buildInventory } from './inventory.js';
import { identify } from './providers.js';
import { fingerprint } from './fingerprint.js';
import { print, registerSecret } from './output.js';
import { findVercelProject, updateVercelEnv, redeployProduction } from './vercel.js';

// Replace one key (found by its fingerprint) with a new key, in every env file
// under `target` where it appears.
//
// Safety: the new key is read from a hidden prompt, checked with the provider
// before anything is written, every file is backed up first, writes are atomic,
// and each file is re-read afterwards to confirm the new key is in place.
export async function replace(target, fpArg, { readSecret, confirm, fetchImpl = fetch, backupRoot, openUrl, reuseScanRoot, getVercelToken } = {}) {
  if (!fpArg) {
    print('Usage: burnkeys replace <fingerprint> [path]   (fingerprints are shown by `burnkeys scan`)');
    return 2;
  }
  const wanted = fpArg.startsWith('fp:') ? fpArg : 'fp:' + fpArg;
  const inv = await buildInventory(target);
  const entry = inv.secrets.find((e) => e.fp === wanted);
  if (!entry) {
    print(`❌ No secret with fingerprint ${wanted} under ${inv.root}.`);
    return 2;
  }
  const names = [...entry.names];
  const files = [...new Map(entry.places.map((p) => [p.abs, p])).values()];

  print(`Replacing ${entry.provider?.name ?? 'secret'} ${names.join(', ')} ${entry.fp}`);
  print(`Found in ${files.length} file(s):`);
  for (const p of files) print('  ' + p.file);
  print('');

  if (entry.provider?.rotateUrl) {
    print(`Create the new key here: ${entry.provider.rotateUrl}`);
    if (entry.provider.id === 'anthropic') print('Tip: create it inside a workspace - keys outside a workspace may not work.');
    if (openUrl) {
      openUrl(entry.provider.rotateUrl);
      print('(opened in your browser)');
    }
    print('');
  }

  // Up to 3 attempts, so a rejected key never sends the user back to the shell
  // prompt (where a pasted key would be echoed and saved in shell history).
  let newKey, newFp;
  for (let attempt = 1; ; attempt++) {
    const problem = await tryKey();
    if (!problem) break;
    print(`❌ ${problem} Nothing was changed.`);
    if (attempt >= 3) return problem.includes('REJECTED') ? 1 : 2;
    print('Try again, or press Ctrl+C to stop. Paste the key ONLY here, never at the shell prompt.');
  }

  async function tryKey() {
    newKey = await readSecret('New key - copy it and press Enter, or paste it here (hidden): ');
    registerSecret(newKey);
    if (!newKey) return 'No key entered.';
    newFp = fingerprint(newKey);
    if (newFp === entry.fp) return 'That is the same key that is already there.';
    if (/[\r\n]/.test(newKey)) return 'The new key contains a line break.';
    const newId = identify(names[0], newKey);
    if (entry.provider && newId?.provider?.id !== entry.provider.id) {
      return `The new key does not look like a ${entry.provider.name} key.`;
    }
    if (entry.provider?.verify) {
      const r = await entry.provider.verify(newKey, fetchImpl);
      if (r.status !== 'valid') {
        return `New key ${newFp} does not work (${r.status === 'invalid' ? 'the provider REJECTED it' : r.reason}).`;
      }
      print(`✅ New key ${newFp} works.`);
    } else {
      print(`⚠️  No live check for ${entry.provider?.name ?? 'this secret'} yet - make sure the new key is right.`);
    }
    return null;
  }

  // One key per project: warn if this key is already used somewhere else.
  if (reuseScanRoot) {
    const wide = await buildInventory(reuseScanRoot);
    const elsewhere = (wide.secrets.find((e) => e.fp === newFp)?.places ?? [])
      .filter((p) => !files.some((f) => f.abs === p.abs));
    if (elsewhere.length) {
      print(`⚠️  This key is already used in: ${[...new Set(elsewhere.map((p) => p.file))].join(', ')}`);
      print('   Sharing one key between projects means one leak breaks both. A new key for this project is safer.');
    }
  }

  const answer = await confirm(`Write the new key to ${files.length} file(s)? A backup is made first. [y/N] `);
  if (!/^y(es)?$/i.test(answer)) {
    print('Cancelled. Nothing was changed.');
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(backupRoot ?? join(homedir(), '.burnkeys', 'backups'), stamp);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });

  let updated = 0;
  for (const [i, p] of files.entries()) {
    try {
      const text = await readFile(p.abs, 'utf8');
      if (!text.includes(entry.value)) {
        print(`⚠️  ${p.file}: key no longer found (file changed?) - skipped.`);
        continue;
      }
      const backup = join(backupDir, `${i}-${basename(p.abs)}`);
      await copyFile(p.abs, backup);
      await chmod(backup, 0o600);

      const mode = (await stat(p.abs)).mode & 0o777;
      const tmp = join(dirname(p.abs), `.burnkeys-tmp-${randomBytes(6).toString('hex')}`);
      await writeFile(tmp, text.split(entry.value).join(newKey), { mode });
      try {
        await rename(tmp, p.abs);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }

      const check = await readFile(p.abs, 'utf8');
      if (check.includes(newKey) && !check.includes(entry.value)) {
        updated++;
        print(`✅ ${p.file}: updated (${entry.fp} → ${newFp})`);
      } else {
        print(`🔴 ${p.file}: could not confirm the update - restore from the backup.`);
      }
    } catch (err) {
      print(`🔴 ${p.file}: failed (${err.code ?? 'error'}) - file left unchanged.`);
    }
  }

  print('');
  print(`Done: ${updated} of ${files.length} file(s) updated. Backups (readable only by you): ${backupDir}`);

  const hostOk = await syncVercel({ inv, files, names, newKey, confirm, getVercelToken, fetchImpl });
  print('');
  print('Remember: restart any app running locally so it picks up the new key.');
  return updated === files.length && hostOk ? 0 : 1;
}

// If an updated file belongs to a Vercel-linked project, offer to update the
// same variable there and redeploy production. Returns false if something failed.
export async function syncVercel({ inv, files, names, newKey, confirm, getVercelToken, fetchImpl }) {
  const projects = new Map();
  for (const f of files) {
    const p = await findVercelProject(f.abs, inv.root);
    if (p) projects.set(p.projectId, p);
  }
  if (projects.size === 0) {
    print('No Vercel-linked project found here - if this app is hosted elsewhere, update the key there too.');
    return true;
  }
  let ok = true;
  for (const project of projects.values()) {
    print('');
    const yes = await confirm(`Also update ${names.join(', ')} on Vercel project "${project.name}"? [y/N] `);
    if (!/^y(es)?$/i.test(yes)) {
      print(`Skipped Vercel. Remember to update ${names.join(', ')} there yourself.`);
      continue;
    }
    const tokenCandidates = inv.secrets.filter((e) => e.names.has('VERCEL_TOKEN')).map((e) => ({ value: e.value, fp: e.fp, file: e.places[0].file }));
    const token = getVercelToken ? await getVercelToken(tokenCandidates) : null;
    if (!token) {
      print('No Vercel token - skipped. Update the key in the Vercel dashboard yourself.');
      continue;
    }
    registerSecret(token);
    const r = await updateVercelEnv({ token, project, names, value: newKey, fetchImpl });
    if (r.error) {
      print(`🔴 Vercel: ${r.error}. Nothing changed on Vercel.`);
      ok = false;
      continue;
    }
    if (r.results.length === 0) {
      print(`⚠️  Vercel: ${names.join(', ')} is not set on this project - nothing to update.`);
      continue;
    }
    for (const x of r.results) {
      print(x.ok ? `✅ Vercel ${x.key} (${x.target}): updated` : `🔴 Vercel ${x.key} (${x.target}): failed (HTTP ${x.status})`);
      if (!x.ok) ok = false;
    }
    if (!r.results.some((x) => x.ok)) continue;
    const again = await confirm('Redeploy production now so the live site uses the new key? [y/N] ');
    if (!/^y(es)?$/i.test(again)) {
      print('Not redeployed. The live site keeps the old value until the next deploy.');
      continue;
    }
    const d = await redeployProduction({ token, project, fetchImpl });
    if (d.ok) print(`🚀 Redeploy started${d.url ? ': ' + d.url : ''}. Check the site once it finishes building.`);
    else { print(`🔴 Redeploy failed: ${d.reason}. Redeploy from the Vercel dashboard.`); ok = false; }
  }
  return ok;
}

// Push a key that is already in the local env files to the linked Vercel project
// (for when the local file was updated by hand, or Vercel was skipped earlier).
export async function push(target, fpArg, { confirm, fetchImpl = fetch, getVercelToken } = {}) {
  const wanted = fpArg?.startsWith('fp:') ? fpArg : 'fp:' + fpArg;
  const inv = await buildInventory(target);
  const entry = inv.secrets.find((e) => e.fp === wanted);
  if (!fpArg || !entry) {
    print(fpArg ? `❌ No secret with fingerprint ${wanted} under ${inv.root}.` : 'Usage: burnkeys push <fingerprint> [path]');
    return 2;
  }
  const files = [...new Map(entry.places.map((p) => [p.abs, p])).values()];
  print(`Pushing ${entry.provider?.name ?? 'secret'} ${[...entry.names].join(', ')} ${entry.fp} to hosting`);
  const ok = await syncVercel({ inv, files, names: [...entry.names], newKey: entry.value, confirm, getVercelToken, fetchImpl });
  return ok ? 0 : 1;
}
