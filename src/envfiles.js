import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', '.venv', 'venv',
  '__pycache__', 'Library', '.Trash', 'Pods', 'DerivedData', '.cache', 'vendor', 'coverage',
]);

const ENV_FILE = /^\.env(\..+)?$|\.env$/;
const EXAMPLE_FILE = /\.(example|sample|template|dist)$/i;

export function isExampleFile(path) {
  return EXAMPLE_FILE.test(basename(path));
}

// Find env files under `root` (or `root` itself if it is a file).
export async function findEnvFiles(root, { maxDepth = 6 } = {}) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip quietly
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && ENV_FILE.test(e.name)) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found.sort();
}

// Parse KEY=VALUE lines. Supports `export`, quotes, inline comments and
// multi-line quoted values (e.g. PEM private keys).
export function parseEnv(text) {
  const vars = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    let raw = m[2];
    let value;
    const q = raw[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = raw.slice(1);
      let end = body.indexOf(q);
      const startLine = i;
      while (end === -1 && i + 1 < lines.length) {
        i++;
        body += '\n' + lines[i];
        end = body.indexOf(q);
      }
      if (end === -1) {
        i = startLine; // unterminated quote: treat the line as unquoted
        value = raw.slice(1).trim();
      } else {
        value = body.slice(0, end);
        if (q === '"') value = value.replace(/\\n/g, '\n');
      }
    } else {
      value = raw.replace(/\s+#.*$/, '').trim();
    }
    vars.push({ name, value, line: i + 1 });
  }
  return vars;
}

export async function readEnvFile(path) {
  return parseEnv(await readFile(path, 'utf8'));
}
