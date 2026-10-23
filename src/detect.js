import { PROVIDERS, identify } from './providers.js';
import { fingerprint } from './fingerprint.js';

const PEM_PRIVATE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const SERVICE_ACCOUNT = /"private_key"\s*:\s*"-----BEGIN/;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*["']?([^\s"']+)/gm;

// Find secrets inside free text (e.g. a chat message). Returns
// [{ provider, fp }] - never the values themselves.
export function detectSecretsInText(text) {
  const found = new Map();
  const add = (name, value) => {
    const fp = value ? fingerprint(value) : 'fp:-';
    if (!found.has(fp)) found.set(fp, { provider: name, fp });
  };

  // 1. Tokens that match a known key format, anywhere in the text.
  for (const token of text.split(/[\s"'`,;()<>[\]{}]+/)) {
    if (token.length < 16) continue;
    const bare = token.replace(/^[A-Za-z_][A-Za-z0-9_]*[=:]/, '');
    const p = PROVIDERS.find((pr) => pr.format?.test(bare));
    if (p) add(p.name, bare);
  }
  // 2. NAME=value lines where the name says "secret" and the value looks like one.
  for (const m of text.matchAll(ASSIGNMENT)) {
    const id = identify(m[1], m[2]);
    if (id && m[2].length >= 12) add(id.provider?.name ?? 'Secret', m[2]);
  }
  // 3. Private keys and cloud service-account files.
  if (SERVICE_ACCOUNT.test(text)) add('Google service account', null);
  else if (PEM_PRIVATE.test(text)) add('Private key', null);

  return [...found.values()];
}
