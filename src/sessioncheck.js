import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findEnvFiles } from './envfiles.js';
import { buildInventory } from './inventory.js';

const CACHE_HOURS = 6;

async function loadCache(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return {}; }
}

// Check the keys of one project quietly. Returns null when there is nothing to
// report, or { dead: [...], summary } when some key was rejected.
// Results are cached per fingerprint (fingerprints only - never values).
export async function checkProject(dir, { fetchImpl = fetch, cacheDir = join(homedir(), '.burnkeys'), now = Date.now() } = {}) {
  const files = await findEnvFiles(dir, { maxDepth: 3 });
  if (files.length === 0) return null;

  const inv = await buildInventory(dir);
  const cachePath = join(cacheDir, 'status-cache.json');
  const cache = await loadCache(cachePath);
  const dead = [];

  await Promise.all(inv.secrets.map(async (e) => {
    if (!e.provider?.verify || e.places.every((p) => p.example)) return;
    let status = cache[e.fp];
    if (!status || now - status.at > CACHE_HOURS * 3600_000) {
      const r = await e.provider.verify(e.value, fetchImpl);
      status = { status: r.status, at: now };
      cache[e.fp] = status;
    }
    if (status.status === 'invalid') {
      dead.push({ provider: e.provider.name, names: [...e.names], fp: e.fp, files: [...new Set(e.places.map((p) => p.file))] });
    }
  }));

  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(cachePath, JSON.stringify(cache), { mode: 0o600 });
  } catch { /* cache is optional */ }

  if (dead.length === 0) return null;
  const lines = dead.map((d) => `${d.provider} key ${d.names.join('/')} (${d.fp}) in ${d.files.join(', ')} was rejected by its provider`);
  return { dead, summary: lines.join('; ') };
}
