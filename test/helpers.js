import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSink } from '../src/output.js';

// Fake keys are generated at runtime so no key-shaped string ever lives in the
// repository (it would trip GitHub secret scanning).
const rand = (n) => randomBytes(n).toString('hex').slice(0, n);
export const fake = {
  anthropic: () => 'sk-ant-' + 'api03-' + rand(40),
  anthropicAdmin: () => 'sk-ant-' + 'admin01-' + rand(40),
  openrouter: () => 'sk-or-' + 'v1-' + rand(64),
  openai: () => 'sk-' + 'proj-' + rand(48),
  resend: () => 're_' + rand(32),
  elevenlabs: () => 'sk_' + rand(48),
  generic: () => rand(32),
};

export async function tempDir() {
  return mkdtemp(join(tmpdir(), 'burnkeys-test-'));
}

// Run fn while capturing everything Burnkeys prints.
export async function capture(fn) {
  let text = '';
  const prev = setSink({ out: (s) => { text += s; }, err: (s) => { text += s; } });
  try {
    const code = await fn();
    return { code, text };
  } finally {
    setSink(prev);
  }
}

// A fake fetch: decides per provider host whether a key is "alive".
export function fakeFetch(aliveKeys) {
  const calls = [];
  const impl = async (url, opts) => {
    const key = opts.headers['x-api-key'] ?? opts.headers.Authorization?.replace(/^Bearer /, '');
    calls.push({ host: new URL(url).host, key });
    const status = aliveKeys.has(key) ? 200 : 401;
    return { status, body: { cancel: async () => {} } };
  };
  return { impl, calls };
}

export function assertNoSecrets(t, text, secrets) {
  for (const s of secrets) {
    t.assert.ok(!text.includes(s), 'output must never contain a secret value');
    // Not even a 12-char slice of it.
    for (let i = 0; i + 12 <= s.length; i += 6) {
      t.assert.ok(!text.includes(s.slice(i, i + 12)), 'output must not contain a fragment of a secret');
    }
  }
}
