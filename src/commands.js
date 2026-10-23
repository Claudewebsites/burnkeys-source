import { buildInventory } from './inventory.js';
import { identify, providerById, formatHint } from './providers.js';
import { fingerprint } from './fingerprint.js';
import { print, registerSecret } from './output.js';

const ICON = { valid: '✅', invalid: '❌', unknown: '⚠️ ' };

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

// Column widths that fit the longest provider label / variable list.
function widths(entries) {
  const w = { p: 'PROVIDER'.length, v: 'VARIABLE'.length };
  for (const e of entries) {
    w.p = Math.max(w.p, providerLabel(e).length);
    w.v = Math.max(w.v, [...e.names].join(', ').length);
  }
  return { p: w.p + 2, v: w.v + 2 };
}

function providerLabel(entry) {
  if (!entry.provider) return 'Unknown secret';
  const byName = entry.confidence === 'name' && entry.provider.id !== 'self';
  return entry.provider.name + (byName ? ' (by name)' : '');
}

function wherePlaces(entry) {
  const files = [...new Set(entry.places.map((p) => p.file))];
  const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '');
  return files.length > 1 ? `${shown}  (${files.length} places)` : shown;
}

function printFileSafety(inv) {
  const warnings = [];
  for (const f of inv.files) {
    if (f.secrets === 0) continue;
    if (f.git === 'tracked') warnings.push(`🔴 ${f.file} is committed to git - it may already be on GitHub. Rotate these keys.`);
    else if (f.git === 'exposed') warnings.push(`⚠️  ${f.file} is NOT covered by .gitignore - one "git add ." away from a leak.`);
    if (f.example) warnings.push(`⚠️  ${f.file} is an example file but contains values that look like real secrets.`);
  }
  print('');
  print('File safety:');
  if (warnings.length === 0) print('  ✅ every file with secrets is ignored by git (or not in a git repo)');
  for (const w of warnings) print('  ' + w);
}

function printFormatHints(inv) {
  const hints = inv.secrets
    .filter((e) => e.confidence === 'name' && e.provider?.format)
    .map((e) => `  ${e.provider.name} ${[...e.names].join(', ')} ${e.fp}: ${formatHint(e.provider, e.value)}`);
  if (!hints.length) return;
  print('');
  print('Unexpected key format (named like a known provider, but the value does not look like its keys):');
  for (const h of hints) print(h);
}

export async function scan(target) {
  const inv = await buildInventory(target);
  print(`Burnkeys scan - ${inv.root}`);
  print('Read-only. Secret values are never shown; keys are identified by a one-way fingerprint.');
  print('');
  print(`Found ${inv.files.length} env file(s), ${inv.variableCount} variable(s), ${inv.secrets.length} unique secret(s).`);
  if (inv.secrets.length === 0) return 0;

  const w = widths(inv.secrets);
  print('');
  print(pad('PROVIDER', w.p) + pad('VARIABLE', w.v) + pad('FINGERPRINT', 13) + 'WHERE');
  for (const e of inv.secrets) {
    print(pad(providerLabel(e), w.p) + pad([...e.names].join(', '), w.v) + pad(e.fp, 13) + wherePlaces(e));
  }

  const links = new Map();
  for (const e of inv.secrets) if (e.provider?.rotateUrl) links.set(e.provider.name, e.provider.rotateUrl);
  if (links.size) {
    const lw = Math.max(...[...links.keys()].map((n) => n.length)) + 2;
    print('');
    print('Rotate here:');
    for (const [name, url] of links) print('  ' + pad(name, lw) + url);
  }
  const own = inv.secrets.filter((e) => e.provider?.id === 'self' || !e.provider);
  if (own.length) {
    print('');
    print(`Your own / unrecognised secrets (${own.length}): no provider page. Replace them with a new random value.`);
  }

  printFormatHints(inv);
  printFileSafety(inv);
  print('');
  print('Next: `burnkeys verify <path>` checks which of these keys still work.');
  return 0;
}

export async function verify(target, { fetchImpl = fetch } = {}) {
  const inv = await buildInventory(target);
  print(`Burnkeys verify - ${inv.root}`);
  print('Each key is sent only to its own provider, over HTTPS. Only a status is shown.');
  print('');
  let failures = 0;
  let skipped = 0;
  const w = widths(inv.secrets.filter((e) => e.provider?.verify));
  for (const e of inv.secrets) {
    if (e.places.every((p) => p.example)) continue;
    if (!e.provider?.verify) {
      skipped++;
      continue;
    }
    const label = pad(providerLabel(e), w.p) + pad([...e.names].join(', '), w.v) + pad(e.fp, 13);
    const r = await e.provider.verify(e.value, fetchImpl);
    if (r.status !== 'valid') failures++;
    const text = r.status === 'valid' ? 'works' : r.status === 'invalid' ? 'REJECTED (revoked, deleted or wrong)' : r.reason;
    print(label + ICON[r.status] + ' ' + text);
  }
  if (skipped) {
    print('');
    print(`⏭  ${skipped} other secret(s) not checked: live check not supported yet for their provider.`);
  }
  printFormatHints(inv);
  return failures ? 1 : 0;
}

// Compare an old and a new key for the same provider.
// Keys are read with a hidden prompt (or from piped stdin) - never from argv,
// so they never end up in shell history.
export async function compare({ readSecret, fetchImpl = fetch }) {
  const oldKey = await readSecret('Paste the OLD key (hidden): ');
  const newKey = await readSecret('Paste the NEW key (hidden): ');
  registerSecret(oldKey);
  registerSecret(newKey);

  if (!oldKey || !newKey) {
    print('❌ Both keys are required.');
    return 2;
  }
  const oldFp = fingerprint(oldKey);
  const newFp = fingerprint(newKey);
  if (oldFp === newFp) {
    print(`❌ Both keys are the same key (${newFp}). Nothing was rotated.`);
    return 2;
  }
  const oldId = identify('', oldKey);
  const newId = identify('', newKey);
  if (!newId?.provider || !oldId?.provider) {
    print('❌ Could not recognise the provider from the key format.');
    return 2;
  }
  if (oldId.provider.id !== newId.provider.id) {
    print(`❌ These keys belong to different providers (${oldId.provider.name} vs ${newId.provider.name}).`);
    return 2;
  }
  const provider = providerById(newId.provider.id);
  if (!provider.verify) {
    print(`⏭  ${provider.name}: automatic check not supported yet. Rotate at ${provider.rotateUrl}`);
    return 2;
  }

  const n = await provider.verify(newKey, fetchImpl);
  const o = await provider.verify(oldKey, fetchImpl);
  print(`Provider: ${provider.name}`);
  print(`  NEW ${newFp}  ${ICON[n.status]} ${n.status === 'valid' ? 'works' : n.status === 'invalid' ? 'REJECTED' : n.reason}`);
  print(`  OLD ${oldFp}  ${ICON[o.status]} ${o.status === 'valid' ? 'STILL WORKS' : o.status === 'invalid' ? 'dead' : o.reason}`);
  print('');

  if (n.status === 'invalid') {
    print('🔴 The NEW key does not work. Do NOT revoke the old key yet - fix the new one first.');
    if (o.status === 'invalid') print('🔴 The old key is dead too: the app is probably down right now.');
    return 1;
  }
  if (n.status === 'valid' && o.status === 'invalid') {
    print('✅ Rotation complete: the new key works and the old key is dead.');
    return 0;
  }
  if (n.status === 'valid' && o.status === 'valid') {
    print(`🔴 The OLD key is still active. Revoke it at ${provider.rotateUrl}`);
    print('   Make sure you revoke the key with fingerprint ' + oldFp + ', not ' + newFp + '.');
    return 1;
  }
  print('⚠️  Could not get a clear answer from the provider. Try again in a minute.');
  return 1;
}
