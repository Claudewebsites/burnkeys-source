import { relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { findEnvFiles, readEnvFile, isExampleFile } from './envfiles.js';
import { identify } from './providers.js';
import { fingerprint } from './fingerprint.js';
import { registerSecret } from './output.js';
import { gitSafety } from './git.js';

// Builds an inventory of secrets under `target`, grouped by fingerprint
// (the same key used in several files/variables is one entry).
// Secret values stay in memory only for verification and are registered
// with the output scrubber.
export async function buildInventory(target) {
  const root = resolve(target);
  const info = await stat(root);
  const files = info.isFile() ? [root] : await findEnvFiles(root);
  const base = info.isFile() ? resolve(root, '..') : root;

  const byFp = new Map();
  const fileReports = [];
  let variableCount = 0;

  for (const file of files) {
    const example = isExampleFile(file);
    let vars;
    try {
      vars = await readEnvFile(file);
    } catch {
      fileReports.push({ file: relative(base, file) || file, error: 'unreadable', secrets: 0 });
      continue;
    }
    variableCount += vars.length;
    let secretsInFile = 0;
    for (const v of vars) {
      const id = identify(v.name, v.value);
      if (!id) continue;
      registerSecret(v.value);
      secretsInFile++;
      const fp = fingerprint(v.value);
      let entry = byFp.get(fp);
      if (!entry) {
        entry = { fp, provider: id.provider, confidence: id.confidence, value: v.value, names: new Set(), places: [] };
        byFp.set(fp, entry);
      } else if (!entry.provider && id.provider) {
        entry.provider = id.provider;
        entry.confidence = id.confidence;
      }
      entry.names.add(v.name);
      entry.places.push({ file: relative(base, file) || file, abs: file, line: v.line, example });
    }
    fileReports.push({
      file: relative(base, file) || file,
      example,
      secrets: secretsInFile,
      git: await gitSafety(file),
    });
  }

  return { root, files: fileReports, variableCount, secrets: [...byFp.values()] };
}
