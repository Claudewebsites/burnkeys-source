import { readFile, writeFile, rename, stat, chmod, mkdir, copyFile, unlink, appendFile } from 'node:fs/promises';
import { dirname, basename, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { findEnvFiles, parseEnv, isExampleFile } from './envfiles.js';

// Write text atomically, keeping the file's permissions (new files: owner-only).
export async function writeAtomic(path, text) {
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; } catch { /* new file */ }
  const tmp = join(dirname(path), `.burnkeys-tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, text, { mode });
  try { await rename(tmp, path); } catch (err) { await unlink(tmp).catch(() => {}); throw err; }
}

export async function backup(path, backupDir) {
  try {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const dest = join(backupDir, `${randomBytes(3).toString('hex')}-${basename(path)}`);
    await copyFile(path, dest);
    await chmod(dest, 0o600);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // nothing to back up for a new file
  }
}

// Each variable's line span in an env file (a quoted value may run over several lines).
function spans(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/);
    if (!m) continue;
    let end = i;
    const rest = m[4], q = rest[0];
    if ((q === '"' || q === "'" || q === '`') && !new RegExp(`^${q}(?:\\\\.|[^${q}\\\\])*${q}`).test(rest)) {
      // Opening quote not closed on this line: the value continues until a line that closes it.
      for (let j = i + 1; j < lines.length; j++) { if (lines[j].includes(q)) { end = j; break; } }
    }
    out.push({ name: m[2], start: i, end, prefix: m[1] + m[2] + m[3], quote: q === '"' || q === "'" ? q : '' });
    i = end;
  }
  return out;
}

// How to write a value so parseEnv reads back exactly the same string.
function quoteFor(value, preferred) {
  const plainOk = !/[\s#"'`\\]/.test(value);
  if (preferred && !value.includes(preferred) && !(preferred === '"' && value.includes('\\'))) return preferred;
  if (plainOk) return '';
  if (!value.includes("'")) return "'"; // single quotes: no escapes are processed
  return '';
}

// Set NAME=value in an env file's text: replace the existing variable (keeping its
// quote style when safe, and the file's line endings) or append a new line.
export function setVarInText(text, name, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const found = spans(lines).filter((sp) => sp.name === name);
  if (found.length) {
    for (const sp of found.reverse()) {
      const q = quoteFor(value, sp.quote);
      lines.splice(sp.start, sp.end - sp.start + 1, `${sp.prefix}${q}${value}${q}`);
    }
    return lines.join(eol);
  }
  const base = text.length && !/\r?\n$/.test(text) ? text + eol : text;
  const q = quoteFor(value, '');
  return `${base}${name}=${q}${value}${q}${eol}`;
}

// Which env file in a project should receive NAME: files that already define it,
// else the only real env file, else <project>/.env.
export async function targetFiles(projectPath, name) {
  const files = (await findEnvFiles(projectPath)).filter((f) => !isExampleFile(f));
  const defining = [];
  for (const f of files) {
    try { if (parseEnv(await readFile(f, 'utf8')).some((v) => v.name === name)) defining.push(f); } catch { /* unreadable */ }
  }
  if (defining.length) return defining;
  if (files.length === 1) return files;
  const local = files.find((f) => basename(f) === '.env' && dirname(f) === projectPath);
  return [local ?? join(projectPath, '.env')];
}

// Make sure a project's .gitignore covers .env files we create.
async function ensureIgnored(projectPath) {
  try { await stat(join(projectPath, '.git')); } catch { return; }
  const gi = join(projectPath, '.gitignore');
  let text = '';
  try { text = await readFile(gi, 'utf8'); } catch { /* none yet */ }
  if (/^\.env(\*|\b)/m.test(text)) return;
  await appendFile(gi, `${text && !text.endsWith('\n') ? '\n' : ''}# Secrets (added by Burnkeys)\n.env\n.env.*\n!.env.example\n`);
}

// Write NAME=value into a project. Returns [{ file, ok }] (paths relative to the project).
export async function setProjectVar(projectPath, name, value, { backupRoot = join(homedir(), '.burnkeys', 'backups') } = {}) {
  const backupDir = join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const results = [];
  for (const file of await targetFiles(projectPath, name)) {
    const rel = relative(projectPath, file) || basename(file);
    try {
      let text = '';
      try { text = await readFile(file, 'utf8'); } catch { /* creating */ }
      if (text) await backup(file, backupDir); else await ensureIgnored(projectPath);
      await writeAtomic(file, setVarInText(text, name, value));
      const check = parseEnv(await readFile(file, 'utf8')).find((v) => v.name === name);
      results.push({ file: rel, ok: check?.value === value });
    } catch (err) {
      results.push({ file: rel, ok: false, error: err.code ?? 'failed' });
    }
  }
  return results;
}

// Remove every line whose value is exactly `value` from a project's env files
// (used after a key is revoked, or to stop sharing a key). Returns [{ file, ok }].
export async function removeValueFromProject(projectPath, value, { backupRoot = join(homedir(), '.burnkeys', 'backups') } = {}) {
  const backupDir = join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const results = [];
  for (const file of (await findEnvFiles(projectPath)).filter((f) => !isExampleFile(f))) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    if (!parseEnv(text).some((v) => v.value === value)) continue;
    const rel = relative(projectPath, file) || basename(file);
    try {
      await backup(file, backupDir);
      // Remove whole variables (multi-line values included) whose value is the key.
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(/\r?\n/);
      for (const sp of spans(lines).reverse()) {
        const parsed = parseEnv(lines.slice(sp.start, sp.end + 1).join('\n'))[0];
        if (parsed && parsed.value === value) lines.splice(sp.start, sp.end - sp.start + 1);
      }
      await writeAtomic(file, lines.join(eol));
      results.push({ file: rel, ok: !parseEnv(await readFile(file, 'utf8')).some((v) => v.value === value) });
    } catch (err) {
      results.push({ file: rel, ok: false, error: err.code ?? 'failed' });
    }
  }
  return results;
}
