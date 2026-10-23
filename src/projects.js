import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// Where people usually keep code. Only folders that exist are scanned.
export const DEFAULT_ROOT_NAMES = ['Desktop', 'Documents', 'Developer', 'Projects', 'projects', 'code', 'Code', 'dev', 'src', 'repos', 'Sites', 'GitHub', 'workspace', 'Work'];

const MARKERS = ['package.json', '.git', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'deno.json', 'pubspec.yaml', 'Package.swift', '.env'];
const SKIP = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', 'Library',
  '.Trash', 'Pods', 'DerivedData', '.cache', 'vendor', 'coverage', 'Applications', 'Movies', 'Music', 'Pictures', 'Photos Library.photoslibrary']);

export async function defaultRoots(home = homedir()) {
  const roots = [];
  for (const name of DEFAULT_ROOT_NAMES) {
    try { if ((await stat(join(home, name))).isDirectory()) roots.push(join(home, name)); } catch { /* missing */ }
  }
  return roots;
}

// A project is the first folder (walking down) that has a project marker.
// We don't descend into a project once found.
export async function discoverProjects(roots, { maxDepth = 4 } = {}) {
  const found = new Map();
  async function walk(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    const isProject = MARKERS.some((m) => names.has(m)) || entries.some((e) => e.isFile() && /^\.env(\..+)?$/.test(e.name));
    if (isProject && depth > 0) { found.set(dir, { path: dir, name: basename(dir) }); return; }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  for (const r of roots) await walk(r, 0);
  // Disambiguate equal names with the parent folder.
  const list = [...found.values()];
  const counts = list.reduce((m, p) => m.set(p.name, (m.get(p.name) ?? 0) + 1), new Map());
  for (const p of list) if (counts.get(p.name) > 1) p.name = `${basename(join(p.path, '..'))}/${p.name}`;
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// Folders macOS (or permissions) won't let us read, e.g. after "Don't Allow".
export async function deniedRoots(roots) {
  const denied = [];
  for (const r of roots) {
    try { await readdir(r); } catch (err) { if (err.code === 'EPERM' || err.code === 'EACCES') denied.push(r); }
  }
  return denied;
}
