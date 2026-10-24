import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { buildInventory } from '../inventory.js';
import { registerSecret } from '../output.js';
import { fingerprint } from '../fingerprint.js';
import { takeKeyFromClipboard } from '../clipboard.js';
import { defaultRoots, discoverProjects, deniedRoots } from '../projects.js';
import { setProjectVar, removeValueFromProject } from '../envwrite.js';
import { appendFile } from 'node:fs/promises';
import { detectSecretsInText } from '../detect.js';
import { hookInstalled, installHook, uninstallHook } from '../hook.js';
import { createVault, defaultKeychain, inApp, moveToAppKeychain } from '../vault.js';
import { CATALOG, catalogEntry, looksLikeKeyFor, normalizePart, checkParts } from '../catalog.js';
import { HOSTS } from '../hosts.js';
import { findVercelProject, updateVercelEnv, redeployProduction } from '../vercel.js';
import { scanGitLeaks, deployedOn, PLATFORMS } from '../leaks.js';
import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FREE_PROJECTS = 3;
const FREE_PROVIDERS = 10;
const AGENT_LABEL = 'com.burnkeys.agent';

// Burnkeys app: a small web UI served on 127.0.0.1 only.
// - Every API call needs the random session token (no other site or app can call it).
// - The Host header must be our own address (blocks DNS-rebinding tricks).
// - Key values never leave this process: the UI only receives fingerprints and statuses.

const CACHE_HOURS = 6;
const ORDER = { bad: 0, warn: 1, ok: 2, unknown: 3 };

export async function startApp({
  port = 0, dataDir = join(homedir(), '.burnkeys'), fetchImpl = fetch, clipboard, openUrl,
  clipboardWait = {}, vault = createVault({ dataDir }), roots, backupRoot,
  siteUrl = 'https://burnkeys.com', keychain = defaultKeychain,
} = {}) {
  const account = {
    token: () => keychain.get('account:token'),
    save: (t) => keychain.set('account:token', t),
    clear: () => keychain.remove('account:token'),
  };
  // Inside the Mac app: move keys saved by older versions into the app's own Keychain items first.
  if (inApp && keychain === defaultKeychain) {
    // In the background: until each key is moved, reads fall back to the old copy.
    vault.list().then((items) => moveToAppKeychain([...items.map((i) => i.account), 'account:token'])).catch(() => 0);
  }
  const token = randomBytes(24).toString('hex');
  const state = { job: null, lastSeen: Date.now() };
  const ui = await readFile(new URL('./ui.html', import.meta.url), 'utf8');
  const logos = await readFile(new URL('./logos.json', import.meta.url), 'utf8').catch(() => '{}');
  const configPath = join(dataDir, 'app.json');
  const cachePath = join(dataDir, 'status-cache.json');

  const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };
  const writeJson = async (p, v) => {
    try { await mkdir(dataDir, { recursive: true, mode: 0o700 }); await writeFile(p, JSON.stringify(v), { mode: 0o600 }); } catch { /* optional */ }
  };
  const loadConfig = () => readJson(configPath, { projects: null });
  // Config changes go through one queue and re-read the file, so two quick changes
  // (or a scan finishing) never overwrite each other's fields.
  let configQueue = Promise.resolve();
  const patchConfig = (fields) => (configQueue = configQueue.then(async () => {
    const latest = await loadConfig();
    await writeJson(configPath, { ...latest, ...fields });
  }).catch(() => {}));
  // A cached status only counts for the provider it was checked against, so a
  // key that gets re-classified (e.g. Stripe -> Clerk) is checked again.
  const cached = (cache, fp, providerId) => (cache[fp] && cache[fp].p === providerId ? cache[fp] : null);
  const remember = async (fp, providerId, status) => {
    const cache = await readJson(cachePath, {});
    cache[fp] = { status, at: Date.now(), p: providerId };
    await writeJson(cachePath, cache);
  };
  const activityPath = join(dataDir, 'activity.jsonl');
  const seenPath = join(dataDir, 'seen.json');
  const leaksPath = join(dataDir, 'leaks.json');
  const advisoriesPath = join(dataDir, 'advisories.json');
  const bundledAdvisories = JSON.parse(await readFile(new URL('../advisories.json', import.meta.url), 'utf8').catch(() => '[]'));

  // Security advisories (breaches at services people use), published on burnkeys.com.
  // Only the list is downloaded; nothing about this Mac is sent.
  async function advisories() {
    const c = await readJson(advisoriesPath, null);
    if (c && Date.now() - c.at < 3 * 3600_000) return c.items;
    try {
      const r = await fetchImpl(`${siteUrl}/advisories.json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const items = await r.json(); if (Array.isArray(items)) { await writeJson(advisoriesPath, { at: Date.now(), items }); return items; } }
    } catch { /* offline */ }
    return c?.items ?? bundledAdvisories;
  }

  // Plans (prices and what's included) come from burnkeys.com/plans.json, the same list the website uses.
  let plansCache = null;
  // Newer version on burnkeys.com? Checked at most twice a day; only the version number is fetched.
  const myVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8').catch(() => '{}')).version ?? '0.0.0';
  let versionCache = null;
  async function latestVersion() {
    if (versionCache && Date.now() - versionCache.at < 12 * 3600_000) return versionCache.doc;
    try {
      const r = await fetchImpl(`${siteUrl}/version.json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) versionCache = { at: Date.now(), doc: await r.json() };
    } catch { /* offline */ }
    return versionCache?.doc ?? null;
  }
  const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

  // Team: tell burnkeys.com this Mac's key statuses (metadata only, never a value), at most every 10 minutes.
  let lastTeamSync = 0;
  async function teamSync(o, force = false) {
    if (!force && Date.now() - lastTeamSync < 10 * 60_000) return;
    lastTeamSync = Date.now();
    const t = await account.token().catch(() => null);
    if (!t) return;
    const leaked = new Set((o.leaks ?? []).map((l) => l.fp));
    const keys = o.providers.filter((p) => !p.own).flatMap((p) => p.keys.map((k) => ({ provider: p.name, fp: k.fp, variables: k.names, projects: k.projects, status: k.status ?? 'unknown', leaked: leaked.has(k.fp) })));
    await fetchImpl(`${siteUrl}/api/team`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync', keys }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }

  async function plansDoc() {
    if (plansCache && Date.now() - plansCache.at < 6 * 3600_000) return plansCache.doc;
    try {
      const r = await fetchImpl(`${siteUrl}/plans.json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const doc = await r.json(); if (doc?.pro?.features) { plansCache = { at: Date.now(), doc }; return doc; } }
    } catch { /* offline */ }
    return plansCache?.doc ?? null;
  }

  // Look for keys committed to git (now or in any past commit), project by project.
  async function leakScan() {
    const { cfg, inventories } = await collect();
    const out = { at: Date.now(), projects: {} };
    for (const { proj, inv } of inventories) {
      const secrets = inv.secrets.filter((e) => !e.places.every((p) => p.example)).map((e) => ({ fp: e.fp, value: e.value }));
      if (!secrets.length) continue;
      const r = await scanGitLeaks(proj.path, secrets, { fetchImpl }).catch(() => null);
      if (r?.repo) out.projects[proj.path] = { remote: r.remote ?? null, public: r.public ?? null, truncated: !!r.truncated, trackedEnv: r.trackedEnv ?? [], found: r.found };
    }
    const before = await readJson(leaksPath, { projects: {} });
    for (const [path, r] of Object.entries(out.projects)) {
      const old = new Set((before.projects[path]?.found ?? []).map((f) => f.fp));
      for (const f of r.found) if (!old.has(f.fp)) await log('leak', { fp: f.fp, project: (cfg.projects ?? []).find((p) => p.path === path)?.name, where: f.tracked ? 'committed' : 'git history', public: r.public });
    }
    await writeJson(leaksPath, out);
    return out;
  }

  // Activity log: what happened and when. Fingerprints and names only, never values.
  async function log(type, details) {
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await appendFile(activityPath, JSON.stringify({ at: Date.now(), type, ...details }) + '\n', { mode: 0o600 });
    } catch { /* optional */ }
  }
  async function activity(limit = 200) {
    try {
      const lines = (await readFile(activityPath, 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  async function scan() {
    const cfg = await loadConfig();
    const r = roots ?? cfg.roots ?? await defaultRoots();
    const projects = await discoverProjects(r);
    const denied = await deniedRoots(r);
    await patchConfig({ projects, roots: r, denied, scannedAt: Date.now() });
    await log('scan', { projects: projects.length, folders: r.length });
  }

  // Everything the UI shows. Inventories (with values) stay in this process.
  async function collect() {
    const cfg = await loadConfig();
    const cache = await readJson(cachePath, {});
    const stored = await vault.list();
    // When each key was first seen: tells keys from before a breach apart from fresh ones.
    // The first time this runs every existing key counts as old (0).
    const seenFile = await readJson(seenPath, null);
    const seen = seenFile ?? {};
    let seenChanged = false; // the file is only written once there are keys, so "first run" really means the first keys seen
    const providers = new Map();
    const projects = [];
    const inventories = [];
    const ensureProvider = (id, name, keysUrl, canCheck, own) => {
      if (!providers.has(id)) providers.set(id, { id, name, keysUrl, canCheck, own, inCatalog: !!catalogEntry(id) || id.startsWith('custom-'), keys: new Map(), kind: null });
      return providers.get(id);
    };
    const sharedOk = new Set(cfg.sharedOk ?? []);
    const ensureKey = (prov, fp) => {
      const c = cached(cache, fp, prov.id);
      if (!(fp in seen)) { seen[fp] = seenFile ? Date.now() : 0; seenChanged = true; }
      if (!prov.keys.has(fp)) prov.keys.set(fp, { fp, names: new Set(), projects: new Set(), status: c?.status ?? null, checkedAt: c?.at ?? null, sharedOk: sharedOk.has(fp), firstSeen: seen[fp] });
      return prov.keys.get(fp);
    };
    // Free plan: keys are read from 3 projects (the user picks which). Pro: all of them.
    const pro = (await plan()) === 'pro';
    const all = cfg.projects ?? [];
    let watched = null;
    const locked = [];
    if (!pro && all.length > FREE_PROJECTS) {
      const chosen = (cfg.freeProjects ?? []).filter((p) => all.some((x) => x.path === p));
      if (chosen.length < FREE_PROJECTS) {
        // Fill the free slots with the projects that hold the most keys.
        const counts = [];
        for (const proj of all) {
          if (chosen.includes(proj.path)) continue;
          let n = 0;
          try { n = (await buildInventory(proj.path)).secrets.length; } catch { /* unreadable */ }
          counts.push({ path: proj.path, n });
        }
        counts.sort((a, b) => b.n - a.n);
        chosen.push(...counts.slice(0, FREE_PROJECTS - chosen.length).map((c) => c.path));
      }
      watched = new Set(chosen);
    }
    for (const proj of all) {
      if (watched && !watched.has(proj.path)) { locked.push({ name: proj.name, path: proj.path, locked: true, health: 'locked', keyCount: null }); continue; }
      let inv;
      try { inv = await buildInventory(proj.path); } catch { inv = { secrets: [] }; }
      inventories.push({ proj, inv });
      const keys = inv.secrets.filter((e) => !e.places.every((p) => p.example));
      for (const e of keys) {
        const id = e.provider?.id ?? 'other';
        const name = id === 'self' ? 'App passwords and secrets' : id === 'other' ? 'Unrecognized keys' : e.provider.name;
        const prov = ensureProvider(id, name, e.provider?.rotateUrl ?? null, !!e.provider?.verify, id === 'self' || id === 'other');
        prov.kind = e.provider?.kind ?? null;
        const k = ensureKey(prov, e.fp);
        e.names.forEach((n) => k.names.add(n));
        k.projects.add(proj.name);
      }
      const statuses = keys.map((e) => cached(cache, e.fp, e.provider?.id ?? 'other')?.status);
      projects.push({ name: proj.name, path: proj.path, keyCount: keys.length, hook: await hookInstalled(proj.path).catch(() => false),
        health: statuses.includes('invalid') ? 'bad' : statuses.includes('valid') ? 'ok' : keys.length ? 'unknown' : 'empty' });
    }
    for (const item of stored) {
      const cat = catalogEntry(item.providerId) ?? (cfg.custom ?? []).find((c) => c.id === item.providerId);
      const prov = ensureProvider(item.providerId, cat?.name ?? item.providerId, cat?.keysUrl ?? null, !!cat?.provider?.verify, false);
      ensureKey(prov, item.fp);
    }
    if (seenChanged) await writeJson(seenPath, seen);
    projects.push(...locked);
    // Free plan: up to 10 providers (your own secrets and unrecognized keys don't count).
    let lockedProviders = 0;
    if (!pro) {
      const real = [...providers.values()].filter((p) => !p.own && !p.kind).sort((a, b) => a.name.localeCompare(b.name));
      for (const p of real.slice(FREE_PROVIDERS)) { providers.delete(p.id); lockedProviders++; }
    }
    const storedFps = new Set(stored.map((i) => i.fp));
    // A key's history from the activity log: when Burnkeys got it, what it replaced, when it went to Vercel.
    const hist = {};
    const h = (fp) => (hist[fp] ??= {});
    for (const a of (await activity(5000)).reverse()) {
      if ((a.type === 'new-key' || a.type === 'new-key-for-replace') && a.fp) { h(a.fp).addedAt ??= a.at; if (a.oldFp) { h(a.fp).replaced = { fp: a.oldFp, at: a.at }; h(a.oldFp).replacedBy = { fp: a.fp, at: a.at }; } }
      if (a.type === 'applied' && a.fp && a.vercel?.length) h(a.fp).vercelAt = a.at;
      if (a.type === 'kept-old' && a.fp) h(a.fp).keptAt = a.at;
    }
    const providerList = [...providers.values()].map((p) => {
      const keys = [...p.keys.values()].map((k) => ({ ...k, names: [...k.names], projects: [...k.projects], saved: storedFps.has(k.fp), history: hist[k.fp] ?? null }));
      const health = keys.some((k) => k.status === 'invalid') ? 'bad'
        : keys.some((k) => k.projects.length > 1 && !k.sharedOk) ? 'warn'
        : keys.some((k) => k.status === 'valid') ? 'ok' : 'unknown';
      return { ...p, keys, health };
    }).sort((a, b) => (a.own - b.own) || (ORDER[a.health] - ORDER[b.health]) || a.name.localeCompare(b.name));
    return { cfg, projects, providers: providerList, inventories, pro, lockedProviders,
      limits: pro ? null : { projects: FREE_PROJECTS, providers: FREE_PROVIDERS } };
  }

  async function overview() {
    const { cfg, projects, providers, inventories, pro, lockedProviders, limits } = await collect();
    const keyIndex = new Map(providers.flatMap((p) => p.keys.map((k) => [k.fp, { p, k }])));
    const describe = (fp) => { const x = keyIndex.get(fp); return x && { fp, providerId: x.p.id, providerName: x.p.name, own: x.p.own, inCatalog: x.p.inCatalog, names: x.k.names, projects: x.k.projects }; };
    // Keys found in git.
    const leakData = await readJson(leaksPath, { projects: {} });
    const leakOk = new Set(cfg.leakOk ?? []);
    const leaks = [];
    for (const proj of projects) {
      const r = leakData.projects?.[proj.path];
      for (const f of r?.found ?? []) {
        const d = describe(f.fp);
        if (d && !leakOk.has(f.fp)) leaks.push({ ...d, project: proj.name, tracked: f.tracked, history: f.history, public: r.public, remote: r.remote });
      }
    }
    // Which hosting platforms / cloud services each project uses (files + env names, or the user's own marking).
    const projPlatforms = new Map();
    for (const { proj, inv } of inventories) {
      const marked = (cfg.platforms ?? {})[proj.path];
      projPlatforms.set(proj.path, marked ?? await deployedOn(proj.path, inv.secrets.flatMap((e) => [...e.names])));
    }
    // Breaches at platforms where projects are deployed.
    const done = new Set(cfg.advisoriesDone ?? []);
    const closed = new Set(cfg.advisoriesHidden ?? []);
    const alerts = [];
    for (const a of await advisories()) {
      const since = Date.parse(a.date);
      const affected = [];
      const onPlatform = [];
      for (const { proj, inv } of inventories) {
        const keys = inv.secrets.filter((e) => !e.places.every((p) => p.example));
        const hit = a.platform ? projPlatforms.get(proj.path).includes(a.platform) : keys.some((e) => e.provider?.id === a.provider);
        if (!hit) continue;
        onPlatform.push(proj.name);
        for (const e of keys) {
          if (a.provider && e.provider?.id !== a.provider) continue;
          const d = describe(e.fp);
          if (d && (keyIndex.get(e.fp).k.firstSeen ?? 0) < since && !affected.some((x) => x.fp === e.fp)) affected.push(d);
        }
      }
      alerts.push({ id: a.id, date: a.date, title: a.title, summary: a.summary, url: a.url, platform: a.platform ?? null, platformName: a.platformName ?? a.platform ?? a.provider,
        projects: onPlatform, affected, done: done.has(a.id), closed: closed.has(a.id) });
    }
    // Platforms view: each service, the projects on it, and any open breach report.
    const platforms = PLATFORMS.map((p) => {
      const on = inventories.filter(({ proj }) => projPlatforms.get(proj.path).includes(p.id)).map(({ proj }) => proj.name);
      const breach = alerts.find((a) => a.platform === p.id && !a.done && !a.closed && Date.now() - Date.parse(a.date) < 90 * 864e5);
      return { id: p.id, name: p.name, projects: on, breach: breach ? { id: breach.id, title: breach.title, date: breach.date, keys: breach.affected.length } : null };
    }).filter((p) => p.projects.length);
    const used = new Set(providers.map((p) => p.id));
    const custom = cfg.custom ?? [];
    return {
      scanned: Array.isArray(cfg.projects), scannedAt: cfg.scannedAt ?? null, roots: cfg.roots ?? [], denied: cfg.denied ?? [], checkEveryMin: cfg.checkEveryMin ?? 360,
      projects, providers, leaks, alerts, platforms, allPlatforms: PLATFORMS.map(({ id, name }) => ({ id, name })), leaksAt: leakData.at ?? null,
      version: myVersion, update: await latestVersion().then((v) => (v?.app && newer(v.app, myVersion) ? { version: v.app, url: v.url ?? `${siteUrl}/download/Burnkeys.dmg`, notes: v.notes ?? '' } : null)).catch(() => null),
      plan: pro ? 'pro' : 'free', plans: await plansDoc(), limits, lockedProviders, background: !!cfg.background,
      catalog: [...CATALOG, ...custom].filter((c) => !used.has(c.id)).map((c) => ({ id: c.id, name: c.name, icon: c.icon ?? null })),
      icons: Object.fromEntries(custom.filter((c) => c.icon).map((c) => [c.id, c.icon])),
      job: state.job && publicJob(state.job),
    };
  }

  async function checkAll({ force = false } = {}) {
    const { inventories } = await collect();
    const cache = await readJson(cachePath, {});
    const now = Date.now();
    const seen = new Set();
    const checks = [];
    for (const { inv } of inventories) {
      for (const e of inv.secrets) {
        if (seen.has(e.fp) || !e.provider?.verify || e.places.every((p) => p.example)) continue;
        seen.add(e.fp);
        const c = cached(cache, e.fp, e.provider.id);
        if (!force && c && now - c.at < CACHE_HOURS * 3600_000) continue;
        checks.push(e.provider.verify(e.value, fetchImpl).then((r) => {
          if (r.status === 'invalid' && c?.status !== 'invalid') {
            log('dead', { provider: e.provider.name, fp: e.fp, names: [...e.names] });
          }
          cache[e.fp] = { status: r.status, at: now, p: e.provider.id };
        }));
      }
    }
    // Keys saved in the Keychain but not used by any project yet.
    for (const item of await vault.list()) {
      if (seen.has(item.fp)) continue;
      const prov = catalogEntry(item.providerId)?.provider;
      if (!prov?.verify) continue;
      const c = cached(cache, item.fp, item.providerId);
      if (!force && c && now - c.at < CACHE_HOURS * 3600_000) continue;
      checks.push(vault.get(item.fp).then((secret) => secret && prov.verify(secret, fetchImpl)).then((r) => { if (r) cache[item.fp] = { status: r.status, at: now, p: item.providerId }; }).catch(() => {}));
    }
    await Promise.all(checks);
    await writeJson(cachePath, cache);
  }

  const publicJob = (j) => ({ id: j.id, providerId: j.providerId, providerName: j.providerName, step: j.step, message: j.message,
    fp: j.fp ?? null, last4: j.last4 ?? null, verified: j.verified ?? null, variable: j.variable, suggested: j.suggested, results: j.results ?? null, keysUrl: j.keysUrl,
    fields: j.fields ? j.fields.map((f, i) => ({ label: f.label, variable: f.variable, optional: !!f.optional, file: f.file ?? null, done: !!j.parts?.[i], skipped: j.parts?.[i] === '' })) : null,
    fieldIndex: j.fieldIndex ?? 0 });

  // The account's plan, asked from burnkeys.com at most every 10 minutes.
  // Offline, the last known plan is kept so a paying user is never locked out.
  async function plan({ fresh = false } = {}) {
    if (!fresh && state.plan && Date.now() - state.plan.at < 10 * 60_000) return state.plan.value;
    const t = await account.token().catch(() => null);
    let value = 'free';
    if (t) {
      try {
        const r = await fetchImpl(`${siteUrl}/api/me`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(8000) });
        if (r.ok) value = (await r.json()).plan === 'pro' ? 'pro' : 'free';
        else if (r.status !== 401) value = (await loadConfig()).lastPlan ?? 'free';
      } catch { value = (await loadConfig()).lastPlan ?? 'free'; }
    }
    state.plan = { value, at: Date.now() };
    const cfg = await loadConfig();
    if (cfg.lastPlan !== value) await patchConfig({ lastPlan: value });
    return value;
  }

  // Background re-checks while the app runs, at the chosen interval (Pro can go down to 5 minutes).
  let lastAuto = Date.now();
  const autoTimer = setInterval(async () => {
    const every = ((await loadConfig()).checkEveryMin ?? 360) * 60_000;
    if (Date.now() - lastAuto < every) return;
    lastAuto = Date.now();
    await checkAll({ force: true }).catch(() => {});
    if (Date.now() - ((await readJson(leaksPath, {})).at ?? 0) > 24 * 3600_000) await leakScan().catch(() => {});
  }, 60_000);
  autoTimer.unref?.();

  // ---- Background checks (Pro): a LaunchAgent opens Burnkeys hidden on a schedule. ----
  // It runs the app itself (not a bare script), so it keeps the folder access the user
  // already granted. Keys never leave the Mac: only "which key, which project" is sent
  // to burnkeys.com, which emails the user.
  const agentPlist = join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
  const appExecutable = () => {
    // .../Burnkeys.app/Contents/Resources/engine/src/app/server.js -> .../Contents/MacOS/Burnkeys
    const m = fileURLToPath(import.meta.url).match(/^(.*\.app)\/Contents\/Resources\/engine\//);
    return m ? join(m[1], 'Contents', 'MacOS', 'Burnkeys') : null;
  };
  const launchctl = (args) => new Promise((ok) => execFile('/bin/launchctl', args, () => ok()));
  async function setBackground(on, everyMin) {
    const uid = process.getuid?.() ?? 501;
    await launchctl(['bootout', `gui/${uid}/${AGENT_LABEL}`]);
    if (!on) { await unlink(agentPlist).catch(() => {}); return { ok: true }; }
    const exe = appExecutable();
    if (!exe) return { ok: false, error: 'Background checks need the Burnkeys app (not the terminal version).' };
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(exe)}</string><string>--background</string></array>
  <key>StartInterval</key><integer>${Math.max(300, everyMin * 60)}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict></plist>
`;
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(agentPlist, plist);
    await launchctl(['bootstrap', `gui/${uid}`, agentPlist]);
    return { ok: true };
  }

  const notifiedPath = join(dataDir, 'notified.json');
  const notifyMac = (title, text) => new Promise((ok) => {
    const q = (s) => JSON.stringify(String(s).slice(0, 200));
    execFile('/usr/bin/osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`], () => ok());
  });

  // One background round: check every key, look for leaks once a day, match breaches,
  // then tell the user about anything new (Mac notification + email with Pro).
  async function runBackground() {
    await checkAll({ force: true }).catch(() => {});
    if (Date.now() - ((await readJson(leaksPath, {})).at ?? 0) > 24 * 3600_000) await leakScan().catch(() => {});
    const o = await overview();
    await teamSync(o, true).catch(() => {});
    const events = [];
    for (const p of o.providers) for (const k of p.keys) {
      if (k.status === 'invalid') events.push({ id: `dead:${k.fp}`, type: 'dead', provider: p.name, names: k.names, projects: k.projects, fp: k.fp });
    }
    for (const l of o.leaks) events.push({ id: `leak:${l.fp}`, type: 'leak', provider: l.providerName, names: l.names, projects: [l.project], fp: l.fp, public: !!l.public });
    for (const a of o.alerts) if (!a.done && !a.closed && a.affected.length) {
      events.push({ id: `alert:${a.id}`, type: 'breach', advisoryId: a.id, title: a.title, url: a.url, provider: a.platformName, projects: a.projects, count: a.affected.length });
    }
    const sent = new Set(await readJson(notifiedPath, []));
    // `mac:` marks a Mac notification already shown; a plain id marks the email as done.
    const fresh = events.filter((e) => !sent.has(e.id));
    if (!fresh.length) return { sent: 0 };
    for (const e of fresh.filter((x) => !sent.has(`mac:${x.id}`)).slice(0, 3)) {
      if (e.type === 'dead') await notifyMac('A key stopped working', `${e.provider} key in ${e.projects.join(', ') || 'your Keychain'}. Open Burnkeys to replace it.`);
      if (e.type === 'leak') await notifyMac(e.public ? 'Key leaked publicly' : 'Key found in git', `${e.provider} key in ${e.projects[0]}. Open Burnkeys to replace it.`);
      if (e.type === 'breach') await notifyMac(e.title, `${e.count} of your keys were stored there. Open Burnkeys to see which.`);
    }
    let held = new Set(), mailFailed = false;
    if (o.plan === 'pro') {
      const t = await account.token().catch(() => null);
      if (t) {
        try {
          const r = await fetchImpl(`${siteUrl}/api/notify`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: fresh.map(({ id, ...e }) => e) }), signal: AbortSignal.timeout(10_000) });
          if (r.ok) held = new Set(((await r.json().catch(() => ({}))).held ?? []).map(String));
          else mailFailed = true;
        } catch { mailFailed = true; /* the Mac notification still went out; email next round */ }
      }
    }
    const done = fresh.flatMap((e) => (mailFailed || held.has(e.advisoryId) || held.has(e.title) ? [`mac:${e.id}`] : [`mac:${e.id}`, e.id]));
    await writeJson(notifiedPath, [...sent, ...done].slice(-1000));
    await log('notified', { count: fresh.length });
    return { sent: fresh.length };
  }

  async function entryFor(id) {
    return catalogEntry(id) ?? ((await loadConfig()).custom ?? []).find((c) => c.id === id) ?? null;
  }

  // Step 1: take a new key from the clipboard, check it, save it to the Keychain.
  async function startAddKey(providerId, replaceFp) {
    if (state.job && ['waiting-for-copy', 'checking'].includes(state.job.step)) throw new Error('Another key is already being added.');
    const entry = await entryFor(providerId);
    if (!entry) throw new Error('Unknown provider.');
    const { projects, providers } = await collect();
    const old = replaceFp ? providers.flatMap((p) => p.keys).find((k) => k.fp === replaceFp) : null;
    const variable = old?.names[0] ?? entry.variable;
    const usingProvider = new Set(providers.find((p) => p.id === entry.id)?.keys.flatMap((k) => k.projects) ?? []);
    const suggested = projects.filter((p) => (old ? old.projects.includes(p.name) : usingProvider.has(p.name))).map((p) => p.path);
    const job = { id: randomBytes(6).toString('hex'), providerId: entry.id, providerName: entry.name, keysUrl: entry.keysUrl,
      step: 'waiting-for-copy', message: '', variable, suggested, stop: false, secret: null, oldFp: old?.fp ?? null };
    state.job = job;
    if (entry.keysUrl && openUrl) openUrl(entry.keysUrl);
    if (entry.fields) { collectParts(job, entry); return job; }
    (async () => {
      const fromClipboard = await takeKeyFromClipboard({ wait: true, clipboard, shouldStop: () => job.stop || !!job.manual, accept: (v) => looksLikeKeyFor(entry, v), ...clipboardWait });
      const key = job.manual ?? fromClipboard;
      job.manual = null;
      if (job.stop) { job.step = 'cancelled'; return; }
      if (!key) { job.step = 'failed'; job.message = 'No new key was copied. Try again.'; return; }
      registerSecret(key);
      job.fp = fingerprint(key);
      job.last4 = key.length >= 20 ? key.slice(-4) : null; // shown so the user can confirm it's the key they copied
      if (job.fp === job.oldFp) { job.step = 'failed'; job.message = 'That is the same key that is already there.'; return; }
      job.step = 'checking';
      if (entry.provider?.verify) {
        const r = await entry.provider.verify(key, fetchImpl);
        if (r.status === 'invalid') { job.step = 'failed'; job.message = `${entry.name} rejected this key. Nothing was changed. Create a new one and try again.`; return; }
        job.verified = r.status === 'valid';
        await remember(job.fp, entry.id, r.status);
      }
      job.secret = key;
      const saved = await vault.add({ providerId: entry.id, fp: job.fp, secret: key }).catch(() => false);
      job.message = saved ? 'Saved to your Keychain.' : '';
      job.step = 'choose';
      await log(job.oldFp ? 'new-key-for-replace' : 'new-key', { provider: entry.name, fp: job.fp, oldFp: job.oldFp, verified: !!job.verified });
    })().catch(() => { job.step = 'failed'; job.message = 'Something went wrong. Nothing was changed.'; });
    return job;
  }

  // Multi-part credentials (X, PayPal, R2, APNs, Firebase): one part at a time,
  // from the clipboard, typed, or a dropped file. `job.parts[i]` is '' when skipped.
  function collectParts(job, entry) {
    job.fields = entry.fields;
    job.parts = [];
    job.fieldIndex = 0;
    (async () => {
      while (job.fieldIndex < job.fields.length) {
        const i = job.fieldIndex;
        const f = job.fields[i];
        let got = null;
        if (f.file) {
          while (!job.stop && job.manual == null && job.skip !== i) await new Promise((r) => setTimeout(r, 300));
        } else {
          got = await takeKeyFromClipboard({ wait: true, clipboard, shouldStop: () => job.stop || job.manual != null || job.skip === i,
            accept: (v) => !!normalizePart(f, v) && !job.parts.includes(v), ...clipboardWait });
        }
        if (job.stop) { job.step = 'cancelled'; return; }
        if (job.skip === i) { job.parts[i] = ''; job.skip = null; job.fieldIndex++; continue; }
        const value = normalizePart(f, job.manual ?? got);
        job.manual = null;
        if (!value) {
          if (f.file || got == null) continue; // wrong file or nothing yet: keep waiting for this part
          job.step = 'failed'; job.message = 'No value was copied. Try again.'; return;
        }
        if (!f.id) registerSecret(value);
        job.parts[i] = value;
        job.fieldIndex++;
      }
      job.step = 'checking';
      const byName = Object.fromEntries(job.fields.map((f, i) => [f.variable, job.parts[i]]).filter(([, v]) => v));
      const status = await checkParts(entry.id, byName, fetchImpl);
      if (status === 'invalid') { job.step = 'failed'; job.message = `${entry.name} rejected these credentials. Nothing was changed. Check you copied the right ones.`; return; }
      job.verified = status === 'valid';
      // The main secret's fingerprint stands for the set; every secret part goes to the Keychain.
      let saved = true;
      for (const [i, f] of job.fields.entries()) {
        if (!job.parts[i] || f.id) continue;
        const fp = fingerprint(job.parts[i]);
        if (!job.fp) job.fp = fp;
        if (status !== 'unknown') await remember(fp, entry.id, status);
        saved = (await vault.add({ providerId: entry.id, fp, secret: job.parts[i] }).catch(() => false)) && saved;
      }
      if (!job.fp) { job.step = 'failed'; job.message = 'No secret part was added.'; return; }
      job.writes = job.fields.map((f, i) => ({ variable: f.variable, value: job.parts[i] })).filter((w) => w.value);
      job.variable = job.writes.map((w) => w.variable).join(', ');
      job.parts = null;
      job.message = saved ? 'Saved to your Keychain.' : '';
      job.step = 'choose';
      await log(job.oldFp ? 'new-key-for-replace' : 'new-key', { provider: entry.name, fp: job.fp, oldFp: job.oldFp, verified: !!job.verified });
    })().catch(() => { job.step = 'failed'; job.message = 'Something went wrong. Nothing was changed.'; });
  }

  // Step 2: write the key into the chosen projects (and Vercel if asked).
  async function apply({ fp, projects: paths, variable, vercel, hosts = [] }) {
    if (hosts.includes('vercel')) vercel = true;
    const otherHosts = hosts.filter((h) => HOSTS[h]);
    const job = state.job;
    const multi = job && job.fp === fp && job.writes;
    if (multi) variable = job.writes[0].variable;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable ?? '')) throw new Error('Invalid variable name.');
    const { cfg, inventories } = await collect();
    // The key can come from the running add-key job, the Keychain, or a project that already uses it.
    let secret = multi ? job.writes.find((w) => fingerprint(w.value) === fp)?.value : job && job.fp === fp ? job.secret : null;
    if (!secret) secret = await vault.get(fp);
    if (!secret) secret = inventories.flatMap(({ inv }) => inv.secrets).find((e) => e.fp === fp)?.value ?? null;
    if (!secret || fingerprint(secret) !== fp) throw new Error('This key is not available any more. Add it again.');
    registerSecret(secret);
    const writes = multi ? job.writes : [{ variable, value: secret }];
    const known = new Map((cfg.projects ?? []).map((p) => [p.path, p]));
    let vercelToken = null;
    if (vercel) {
      vercelToken = process.env.VERCEL_TOKEN
        || inventories.flatMap(({ inv }) => inv.secrets).find((e) => e.names.has('VERCEL_TOKEN'))?.value
        || await (async () => { const v = (await vault.list()).find((i) => i.providerId === 'vercel'); return v ? vault.get(v.fp) : null; })();
      if (vercelToken) registerSecret(vercelToken);
    }
    const results = [];
    for (const path of paths ?? []) {
      const proj = known.get(path);
      if (!proj) continue;
      const files = [];
      for (const w of writes) {
        for (const f of await setProjectVar(proj.path, w.variable, w.value, { backupRoot })) {
          const same = files.find((x) => x.file === f.file);
          if (same) same.ok = same.ok && f.ok; else files.push(f);
        }
      }
      const r = { project: proj.name, files, vercel: null };
      if (vercel) {
        const vp = await findVercelProject(join(proj.path, files[0]?.file ?? '.env'), proj.path);
        if (!vp) r.vercel = 'not linked to Vercel';
        else if (!vercelToken) r.vercel = 'no Vercel token found';
        else {
          const all = [];
          let err = null;
          for (const w of writes) {
            const u = await updateVercelEnv({ token: vercelToken, project: vp, names: [w.variable], value: w.value, fetchImpl, create: true });
            if (u.error) { err = u.error; break; }
            all.push(...u.results);
          }
          if (err) r.vercel = err;
          else if (!all.length) r.vercel = `${variable} is not set on Vercel`;
          else {
            const d = await redeployProduction({ token: vercelToken, project: vp, fetchImpl });
            r.vercel = d.ok ? 'updated and redeploying' : `updated, redeploy failed (${d.reason})`;
          }
        }
      }
      // Other hosts: the same variable, sent only to that host's API.
      for (const h of otherHosts) {
        const host = HOSTS[h];
        const link = await host.link(proj.path);
        let msg;
        if (!link) msg = `not linked to ${host.name}`;
        else {
          const token = process.env[host.tokenNames[0]]
            || inventories.flatMap(({ inv }) => inv.secrets).find((e) => host.tokenNames.some((n) => e.names.has(n)))?.value
            || await (async () => { const v = (await vault.list()).find((i) => i.providerId === host.provider); return v ? vault.get(v.fp) : null; })();
          if (!token) msg = `no ${host.name} token: add one in Burnkeys (Providers, ${host.name})`;
          else {
            registerSecret(token);
            // One call per variable: multi-part credentials have a different value for each.
            let out = null;
            for (const w of writes) { out = await host.set({ link, token, names: [w.variable], value: w.value, fetchImpl }).catch((e) => ({ error: e.message })); if (out.error) break; }
            msg = out.error ?? out.note;
          }
        }
        (r.hosts ??= []).push(`${host.name}: ${msg}`);
      }
      results.push(r);
    }
    if (job && job.fp === fp) { job.step = 'done'; job.results = results; job.secret = null; }
    await log('applied', { fp, variable: writes.map((w) => w.variable).join(', '), projects: results.map((r) => r.project),
      ok: results.every((r) => r.files.every((f) => f.ok)), vercel: results.filter((r) => r.vercel).map((r) => `${r.project}: ${r.vercel}`), hosts: results.flatMap((r) => (r.hosts ?? []).map((x) => `${r.project}: ${x}`)) });
    await checkAll({ force: true }).catch(() => {});
    return results;
  }

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const authed = (req) => {
    const got = Buffer.from(String(req.headers['x-burnkeys-token'] ?? ''));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const readBody = (req) => new Promise((ok) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 100_000) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
  });

  const server = createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '');
      const p = server.address().port;
      if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, ui, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/logos.json') return send(res, 200, logos, 'application/json; charset=utf-8');
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      state.lastSeen = Date.now();
      const route = `${req.method} ${url.pathname}`;
      if (route === 'POST /api/ping') return send(res, 200, {});
      if (route === 'GET /api/overview') { const o = await overview(); teamSync(o).catch(() => {}); return send(res, 200, o); }
      if (route === 'GET /api/team') {
        const t = await account.token().catch(() => null);
        if (!t) return send(res, 200, { signedIn: false });
        try {
          const r = await fetchImpl(`${siteUrl}/api/team`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(8000) });
          return send(res, 200, r.ok ? { signedIn: true, ...(await r.json()) } : { signedIn: true, error: 'Couldn\'t load the team.' });
        } catch { return send(res, 200, { signedIn: true, offline: true }); }
      }
      if (route === 'POST /api/scan') { await scan(); await checkAll({}); await leakScan().catch(() => {}); return send(res, 200, await overview()); }
      if (route === 'POST /api/leaks') { await leakScan(); return send(res, 200, await overview()); }
      if (route === 'POST /api/alert-done' || route === 'POST /api/leak-ok' || route === 'POST /api/alert-close') {
        const { id, fp, undo } = await readBody(req);
        const cfg = await loadConfig();
        const field = route.endsWith('alert-done') ? 'advisoriesDone' : route.endsWith('alert-close') ? 'advisoriesHidden' : 'leakOk';
        const v = field === 'leakOk' ? fp : id;
        if (typeof v !== 'string' || v.length > 100) return send(res, 400, { error: 'bad id' });
        const list = new Set(cfg[field] ?? []);
        if (undo) list.delete(v); else list.add(v);
        await patchConfig({ [field]: [...list] });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/check') { await checkAll(await readBody(req)); return send(res, 200, await overview()); }
      if (route === 'POST /api/add-key') {
        const { providerId, replaceFp } = await readBody(req);
        if (replaceFp != null && !/^fp:[0-9a-f]{8}$/.test(replaceFp)) return send(res, 400, { error: 'bad fingerprint' });
        try { return send(res, 200, publicJob(await startAddKey(String(providerId ?? ''), replaceFp))); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (route === 'POST /api/apply') {
        const body = await readBody(req);
        if (!/^fp:[0-9a-f]{8}$/.test(body.fp ?? '')) return send(res, 400, { error: 'bad fingerprint' });
        try { return send(res, 200, { results: await apply(body) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (route === 'POST /api/custom-provider') {
        // Just a website: we derive the name, open the site to create a key, and grab its icon.
        const { website, name, variable } = await readBody(req);
        let host;
        try { host = new URL(/^https?:\/\//.test(website ?? '') ? website : `https://${website}`).hostname.replace(/^www\./, ''); } catch { host = null; }
        if (!host || !host.includes('.')) return send(res, 400, { error: 'Enter the provider\'s website, for example acme.com' });
        const label = host.split('.').slice(-2, -1)[0] || host;
        const clean = String(name ?? '').trim().slice(0, 60) || label[0].toUpperCase() + label.slice(1);
        const v = String(variable ?? '').trim() || `${clean.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_API_KEY`;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return send(res, 400, { error: 'Invalid variable name.' });
        let icon = null;
        try {
          const r = await fetchImpl(`https://${host}/favicon.ico`, { signal: AbortSignal.timeout(5000) });
          const buf = Buffer.from(await r.arrayBuffer());
          if (r.ok && buf.length > 100 && buf.length < 200_000) icon = `data:${r.headers.get('content-type') || 'image/x-icon'};base64,${buf.toString('base64')}`;
        } catch { /* no icon */ }
        const cfg = await loadConfig();
        const id = `custom-${host.replace(/[^a-z0-9]+/g, '-')}`;
        const custom = (cfg.custom ?? []).filter((c) => c.id !== id);
        custom.push({ id, name: clean, keysUrl: `https://${host}`, variable: v, icon });
        await patchConfig({ custom });
        return send(res, 200, { id });
      }
      if (route === 'POST /api/new-project') {
        const { name, parent, keys } = await readBody(req);
        const folder = String(name ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,60}$/.test(folder)) return send(res, 400, { error: 'Use letters, numbers, spaces, dots or dashes for the name.' });
        const cfg = await loadConfig();
        const base = typeof parent === 'string' && parent.startsWith('/') ? parent : (cfg.roots ?? [])[0];
        if (!base) return send(res, 400, { error: 'Choose where to create the project.' });
        const path = join(base, folder);
        try { await mkdir(path); } catch (e) { return send(res, 400, { error: e.code === 'EEXIST' ? 'A folder with that name already exists there.' : 'Couldn\'t create the folder.' }); }
        await writeFile(join(path, '.gitignore'), '# Secrets (added by Burnkeys)\n.env\n.env.*\n!.env.example\n');
        const { inventories } = await collect();
        const written = [];
        for (const k of Array.isArray(keys) ? keys : []) {
          if (!/^fp:[0-9a-f]{8}$/.test(k.fp ?? '') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k.variable ?? '')) continue;
          const secret = (await vault.get(k.fp)) ?? inventories.flatMap(({ inv }) => inv.secrets).find((e) => e.fp === k.fp)?.value;
          if (!secret || fingerprint(secret) !== k.fp) continue;
          registerSecret(secret);
          const r = await setProjectVar(path, k.variable, secret, { backupRoot });
          if (r.every((f) => f.ok)) written.push(k.variable);
        }
        const projects = [...(cfg.projects ?? []).filter((p) => p.path !== path), { path, name: folder }].sort((a, b) => a.name.localeCompare(b.name));
        await patchConfig({ projects });
        await log('new-project', { project: folder, variables: written });
        if (openUrl) openUrl(`file://${path}`);
        return send(res, 200, { path, written });
      }
      // ---- Burnkeys account (email + plan only). The app token lives in the Keychain. ----
      if (route === 'GET /api/account') {
        const t = await account.token();
        if (!t) return send(res, 200, { signedIn: false });
        try {
          const r = await fetchImpl(`${siteUrl}/api/me`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(8000) });
          if (r.status === 401) { await account.clear(); return send(res, 200, { signedIn: false }); }
          const me = await r.json();
          return send(res, 200, { signedIn: true, email: me.email, plan: me.plan, ...(me.refCode && { refCode: me.refCode }) });
        } catch { return send(res, 200, { signedIn: true, offline: true }); }
      }
      if (route === 'POST /api/account/start') {
        state.signinState = randomBytes(16).toString('hex');
        const target = `${siteUrl}/account/?app=1&state=${state.signinState}`;
        if (openUrl) openUrl(target);
        return send(res, 200, { url: target });
      }
      if (route === 'POST /api/account/link') {
        const { state: st, token: tk } = await readBody(req);
        const expected = state.signinState;
        state.signinState = null; // single use, even if this attempt is wrong
        if (!expected || st !== expected || typeof tk !== 'string' || tk.length > 2000) return send(res, 400, { error: 'Sign-in link expired. Try again.' });
        await account.save(tk);
        state.plan = null;
        await log('signed-in', {});
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/account/signout') {
        // Revoke the token on burnkeys.com too, so a copied token stops working.
        const t = await account.token().catch(() => null);
        if (t) await fetchImpl(`${siteUrl}/api/app-signout`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(8000) }).catch(() => {});
        await account.clear(); state.plan = null; return send(res, 200, { ok: true });
      }
      if (route === 'GET /api/plugin' || route === 'POST /api/plugin') {
        // Install the Claude Code plugin that ships inside this app, by adding it to ~/.claude/settings.json.
        const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        let settings = {};
        try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return send(res, 500, { error: 'Couldn\'t read Claude Code settings.' }); }
        const installed = settings.enabledPlugins?.['burnkeys@burnkeys'] === true && settings.extraKnownMarketplaces?.burnkeys?.source?.path === root;
        if (req.method === 'GET') return send(res, 200, { installed });
        if (!installed) {
          try { await mkdir(join(homedir(), '.claude'), { recursive: true }); await writeFile(settingsPath + '.burnkeys-backup', JSON.stringify(settings, null, 2)); } catch { /* best effort */ }
          settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces ?? {}), burnkeys: { source: { source: 'directory', path: root } } };
          settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), 'burnkeys@burnkeys': true };
          await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
          await log('plugin-installed', {});
        }
        return send(res, 200, { installed: true });
      }
      if (route === 'GET /api/connect-tool' || route === 'POST /api/connect-tool') {
        // Add Burnkeys as an MCP server to other AI tools on this Mac.
        const cli = fileURLToPath(new URL('../../bin/burnkeys.js', import.meta.url));
        const entry = { command: process.execPath, args: [cli, 'mcp'] };
        const tools = {
          cursor: { name: 'Cursor', dir: join(homedir(), '.cursor'), file: join(homedir(), '.cursor', 'mcp.json'), kind: 'json' },
          'claude-desktop': { name: 'Claude Desktop', dir: join(homedir(), 'Library', 'Application Support', 'Claude'), file: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), kind: 'json' },
          codex: { name: 'Codex', dir: join(homedir(), '.codex'), file: join(homedir(), '.codex', 'config.toml'), kind: 'toml' },
        };
        const exists = async (p) => { try { await readFile(p); return true; } catch (e) { return e.code === 'EISDIR'; } };
        const status = async (t) => {
          const present = await exists(t.dir);
          let text = '';
          try { text = await readFile(t.file, 'utf8'); } catch { /* none */ }
          const connected = t.kind === 'json' ? (() => { try { return !!JSON.parse(text || '{}').mcpServers?.burnkeys; } catch { return false; } })() : /^\[mcp_servers\.burnkeys\]/m.test(text);
          return { id: Object.keys(tools).find((k) => tools[k] === t), name: t.name, present, connected };
        };
        if (req.method === 'GET') return send(res, 200, { tools: await Promise.all(Object.values(tools).map(status)) });
        const { tool } = await readBody(req);
        const t = tools[tool];
        if (!t) return send(res, 400, { error: 'Unknown tool.' });
        if (!(await exists(t.dir))) return send(res, 400, { error: `${t.name} isn't installed on this Mac.` });
        let text = '';
        try { text = await readFile(t.file, 'utf8'); } catch { /* new file */ }
        if (text) await writeFile(t.file + '.burnkeys-backup', text);
        if (t.kind === 'json') {
          let cfgJson = {};
          try { cfgJson = JSON.parse(text || '{}'); } catch { return send(res, 400, { error: `Couldn't read ${t.name}'s settings file.` }); }
          cfgJson.mcpServers = { ...(cfgJson.mcpServers ?? {}), burnkeys: entry };
          await writeFile(t.file, JSON.stringify(cfgJson, null, 2) + '\n');
        } else if (!/^\[mcp_servers\.burnkeys\]/m.test(text)) {
          const q = (s) => JSON.stringify(s);
          await writeFile(t.file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n[mcp_servers.burnkeys]\ncommand = ${q(entry.command)}\nargs = [${entry.args.map(q).join(', ')}]\n`);
        }
        await log('tool-connected', { tool: t.name });
        return send(res, 200, { tools: await Promise.all(Object.values(tools).map(status)) });
      }
      if (route === 'GET /api/activity') return send(res, 200, { items: await activity() });
      if (route === 'POST /api/folders') {
        const { add, remove } = await readBody(req);
        const cfg = await loadConfig();
        let list = cfg.roots ?? await defaultRoots();
        if (typeof add === 'string' && add.startsWith('/')) list = [...new Set([...list, add])];
        if (typeof remove === 'string') list = list.filter((r) => r !== remove);
        await patchConfig({ roots: list });
        if (!roots) { await scan(); await checkAll({}); }
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/verify-one') {
        const { fp } = await readBody(req);
        const { inventories } = await collect();
        let e = inventories.flatMap(({ inv }) => inv.secrets).find((x) => x.fp === fp);
        if (!e) {
          const item = (await vault.list()).find((i) => i.fp === fp);
          const prov = item && catalogEntry(item.providerId)?.provider;
          const value = prov && await vault.get(fp);
          if (value) e = { value, provider: prov };
        }
        if (!e?.provider?.verify) return send(res, 200, { status: 'unknown' });
        registerSecret(e.value);
        const r = await e.provider.verify(e.value, fetchImpl);
        await remember(fp, e.provider.id, r.status);
        if (r.status === 'invalid') await log('revoked-confirmed', { provider: e.provider.name, fp });
        return send(res, 200, { status: r.status });
      }
      if (route === 'POST /api/revoke-auto') {
        // Providers whose API lets a key delete itself (today: Vercel). The key goes only to its own provider.
        const { fp } = await readBody(req);
        const { inventories } = await collect();
        let e = inventories.flatMap(({ inv }) => inv.secrets).find((x) => x.fp === fp);
        if (!e) {
          const item = (await vault.list()).find((i) => i.fp === fp);
          const prov = item && catalogEntry(item.providerId)?.provider;
          const value = prov && await vault.get(fp);
          if (value) e = { value, provider: prov };
        }
        if (e?.provider?.id !== 'vercel') return send(res, 400, { error: 'Burnkeys can\'t delete this kind of key for you yet.' });
        registerSecret(e.value);
        const r = await fetchImpl('https://api.vercel.com/v3/user/tokens/current', { method: 'DELETE', headers: { Authorization: `Bearer ${e.value}` }, signal: AbortSignal.timeout(10000) }).catch(() => null);
        if (!r || (!r.ok && r.status !== 401 && r.status !== 403)) return send(res, 502, { error: 'Vercel didn\'t answer. Try again, or delete it on Vercel\'s site.' });
        await log('revoked-auto', { provider: e.provider.name, fp });
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/hint') {
        // Last 4 characters only, so the user can find the right key on the provider's site.
        const { fp } = await readBody(req);
        const { inventories } = await collect();
        const value = inventories.flatMap(({ inv }) => inv.secrets).find((x) => x.fp === fp)?.value
          ?? (/^fp:[0-9a-f]{8}$/.test(fp ?? '') ? await vault.get(fp) : null);
        return send(res, 200, { last4: value && value.length >= 20 ? value.slice(-4) : null, test: !!value && /^(sk|rk)_test_/.test(value) });
      }
      if (route === 'POST /api/remove') {
        const { fp, projects: paths } = await readBody(req);
        if (!/^fp:[0-9a-f]{8}$/.test(fp ?? '')) return send(res, 400, { error: 'bad fingerprint' });
        const { cfg, inventories } = await collect();
        const value = inventories.flatMap(({ inv }) => inv.secrets).find((x) => x.fp === fp)?.value;
        if (!value) return send(res, 400, { error: 'Key not found in your projects.' });
        const known = new Map((cfg.projects ?? []).map((p) => [p.path, p]));
        const results = [];
        for (const path of paths ?? []) {
          const proj = known.get(path);
          if (proj) results.push({ project: proj.name, files: await removeValueFromProject(proj.path, value, { backupRoot }) });
        }
        await log('removed', { fp, projects: results.map((r) => r.project) });
        return send(res, 200, { results });
      }
      if (route === 'POST /api/add-key/manual') {
        // The user typed or pasted the key into Burnkeys itself (it never leaves this Mac).
        const { key } = await readBody(req);
        const job = state.job;
        if (!job || job.step !== 'waiting-for-copy') return send(res, 409, { error: 'Nothing is waiting for a key.' });
        const v = String(key ?? '').trim();
        const entry = await entryFor(job.providerId);
        if (job.fields) {
          const f = job.fields[job.fieldIndex];
          if (!f || !normalizePart(f, v)) return send(res, 400, { error: f?.file ? `That isn't a ${f.file} key file.` : `That doesn't look like the ${f?.label ?? 'value'}.` });
          job.manual = v;
          return send(res, 200, { ok: true });
        }
        if (!looksLikeKeyFor(entry, v)) return send(res, 400, { error: `That doesn't look like a ${entry.name} key.` });
        registerSecret(v);
        job.manual = v;
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/add-key/skip') {
        const job = state.job;
        const f = job?.fields?.[job.fieldIndex];
        if (!f?.optional) return send(res, 409, { error: 'This part is required.' });
        job.skip = job.fieldIndex;
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/hook-all') {
        // Turn the git commit check on in every project that is a git repository.
        const { inventories } = await collect();
        let on = 0;
        for (const { proj } of inventories) { const r = await installHook(proj.path).catch(() => null); if (r?.ok) on++; }
        await log('hook-on', { project: `${on} projects` });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/hook') {
        // Turn the git commit check on or off for one project.
        const { path, on } = await readBody(req);
        const { inventories } = await collect();
        if (!inventories.some(({ proj }) => proj.path === path)) return send(res, 400, { error: 'Unknown project.' });
        const r = on ? await installHook(path) : await uninstallHook(path);
        if (!r.ok) return send(res, 400, { error: r.error });
        await log(on ? 'hook-on' : 'hook-off', { project: inventories.find(({ proj }) => proj.path === path).proj.name });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/kept-old') {
        // The user replaced a key in one project only and keeps the old one for its other projects.
        const { fp } = await readBody(req);
        if (!/^fp:[0-9a-f]{8}$/.test(fp ?? '')) return send(res, 400, { error: 'bad fingerprint' });
        const cfg = await loadConfig();
        await patchConfig({ sharedOk: [...new Set([...(cfg.sharedOk ?? []), fp])] });
        await log('kept-old', { fp });
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/shared-ok') {
        // The user wants this key shared between projects: stop warning about it.
        const { fp, ok } = await readBody(req);
        if (!/^fp:[0-9a-f]{8}$/.test(fp ?? '')) return send(res, 400, { error: 'bad fingerprint' });
        const cfg = await loadConfig();
        const list = new Set(cfg.sharedOk ?? []);
        if (ok === false) list.delete(fp); else list.add(fp);
        await patchConfig({ sharedOk: [...list] });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/free-projects') {
        // Free plan: watch this project in one of the 3 free slots (the oldest choice makes room).
        const { path } = await readBody(req);
        const cfg = await loadConfig();
        if (!(cfg.projects ?? []).some((p) => p.path === path)) return send(res, 400, { error: 'Unknown project.' });
        const { projects } = await collect();
        const current = projects.filter((p) => !p.locked).map((p) => p.path);
        await patchConfig({ freeProjects: [path, ...current.filter((p) => p !== path)].slice(0, FREE_PROJECTS) });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/platform') {
        // The user says where a project is deployed (when the files don't show it).
        const { path, platform, on } = await readBody(req);
        const cfg = await loadConfig();
        if (!(cfg.projects ?? []).some((p) => p.path === path) || !/^[a-z]{2,20}$/.test(platform ?? '')) return send(res, 400, { error: 'bad request' });
        const { inventories } = await collect();
        const inv = inventories.find((x) => x.proj.path === path)?.inv;
        const platforms = { ...(cfg.platforms ?? {}) };
        const current = new Set(platforms[path] ?? await deployedOn(path, inv ? inv.secrets.flatMap((e) => [...e.names]) : []));
        if (on) current.add(platform); else current.delete(platform);
        platforms[path] = [...current];
        await patchConfig({ platforms });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/assistant') {
        // Pro assistant: sends the question and a metadata-only snapshot (never a key) to burnkeys.com.
        const { question, history } = await readBody(req);
        // Checked here, on the Mac: a pasted key never leaves this computer.
        const asked = [question, ...(Array.isArray(history) ? history.map((m) => m?.content) : [])].filter((x) => typeof x === 'string').join('\n');
        if (detectSecretsInText(asked).length) return send(res, 400, { error: 'That looks like a key, so it was not sent. Burnkeys never needs a key in the chat: ask about it by provider or fingerprint.' });
        const t = await account.token().catch(() => null);
        if (!t) return send(res, 401, { error: 'Sign in to use the assistant.' });
        const o = await overview();
        const snapshot = {
          projects: o.projects.filter((p) => !p.locked).map((p) => ({ name: p.name, keys: p.keyCount, health: p.health })),
          keys: o.providers.flatMap((p) => p.keys.map((k) => ({ provider: p.name, fingerprint: k.fp, variables: k.names, projects: k.projects,
            status: k.status === 'valid' ? 'works' : k.status === 'invalid' ? 'dead' : p.kind === 'signing' ? 'signing secret' : p.canCheck ? 'not checked' : 'cannot be checked', savedInKeychain: k.saved, sharedOnPurpose: k.sharedOk }))),
          leaks: o.leaks.map((l) => ({ provider: l.providerName, fingerprint: l.fp, project: l.project, committed: l.tracked, inHistory: l.history, publicRepo: l.public })),
          breaches: o.alerts.map((a) => ({ title: a.title, date: a.date, projects: a.projects, keysToReplace: a.affected.length, handled: a.done })),
        };
        try {
          const r = await fetchImpl(`${siteUrl}/api/assistant`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: String(question ?? '').slice(0, 2000), history: Array.isArray(history) ? history.slice(-8) : [], snapshot }), signal: AbortSignal.timeout(60_000) });
          const j = await r.json().catch(() => ({}));
          return send(res, r.ok ? 200 : r.status, r.ok ? { answer: j.answer, left: j.left } : { error: j.error || 'The assistant is not available right now.' });
        } catch { return send(res, 502, { error: 'Couldn\'t reach burnkeys.com. Check your connection.' }); }
      }
      if (route === 'POST /api/forget') {
        // Delete a key saved in the Keychain (not used by any project).
        const { fp } = await readBody(req);
        if (!/^fp:[0-9a-f]{8}$/.test(fp ?? '')) return send(res, 400, { error: 'bad fingerprint' });
        await vault.remove(fp);
        await log('forgotten', { fp });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/settings') {
        const body = await readBody(req);
        const cfg = await loadConfig();
        const pro = (await plan({ fresh: true })) === 'pro';
        let { checkEveryMin = cfg.checkEveryMin ?? 360, background = !!cfg.background } = body;
        const allowed = [5, 15, 60, 360, 1440];
        if (!allowed.includes(checkEveryMin)) return send(res, 400, { error: 'Unsupported interval.' });
        if (checkEveryMin < 360 && !pro) return send(res, 402, { error: 'Checks more often than every 6 hours come with Pro.' });
        if (background && !pro) return send(res, 402, { error: 'Checking while Burnkeys is closed comes with Pro.' });
        if (background !== !!cfg.background || (background && checkEveryMin !== cfg.checkEveryMin)) {
          const r = await setBackground(background, checkEveryMin);
          if (!r.ok) return send(res, 400, { error: r.error });
          await log(background ? 'background-on' : 'background-off', {});
        }
        await patchConfig({ checkEveryMin, background });
        return send(res, 200, await overview());
      }
      if (route === 'POST /api/cancel') {
        if (state.job) { state.job.stop = true; state.job.secret = null; if (state.job.step === 'choose') state.job.step = 'cancelled'; }
        return send(res, 200, {});
      }
      return send(res, 404, { error: 'not found' });
    } catch {
      return send(res, 500, { error: 'internal error' });
    }
  });

  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const address = `http://127.0.0.1:${server.address().port}/#${token}`;
  const close = () => { clearInterval(autoTimer); if (state.job) state.job.stop = true; server.closeAllConnections?.(); return new Promise((ok) => server.close(ok)); };
  return { server, url: address, token, close, runBackground,
    idleMs: () => (state.job && ['waiting-for-copy', 'checking', 'choose'].includes(state.job.step) ? 0 : Date.now() - state.lastSeen) };
}
