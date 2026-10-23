// Provider catalogue: how to recognise a key, where to rotate it,
// and (for some providers) how to check whether it still works.
//
// Each provider can match by key format (`format`, reliable) and/or by
// variable name (`name`, a hint used only when the value looks secret).
//
// verify() returns only a status - never the key and never the response body.
//   'valid'    the provider accepted the key
//   'invalid'  the provider rejected the key (revoked, deleted or wrong)
//   'unknown'  could not tell (network error, rate limit, server error)

import { createSign } from 'node:crypto';

const TIMEOUT_MS = 10_000;

// Google service account (Firebase): sign a short JWT with the private key and
// ask Google for a token. A deleted or wrong key gets "invalid_grant".
async function checkServiceAccount(json, fetchImpl) {
  let sa;
  try { sa = JSON.parse(json); } catch { return { status: 'unknown', reason: 'not valid JSON' }; }
  if (!sa.private_key || !sa.client_email) return { status: 'unknown', reason: 'incomplete service account' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 300,
  })}`;
  let sig;
  try { sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key.replace(/\\n/g, '\n'), 'base64url'); }
  catch { return { status: 'invalid', reason: 'private key unreadable' }; }
  return checkWith(fetchImpl, 'https://oauth2.googleapis.com/token', {}, (status, body) =>
    (status === 200 ? 'valid' : /invalid_grant|invalid_client|unauthorized_client/i.test(String(body.error ?? '')) ? 'invalid' : null),
    { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
}

async function statusOf(fetchImpl, url, headers) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { status: 'unknown', reason: 'network error' };
  }
  // Drain the body without ever looking at it.
  try { await res.body?.cancel(); } catch { /* ignore */ }
  if (res.status >= 200 && res.status < 300) return { status: 'valid' };
  if (res.status === 401) return { status: 'invalid', reason: 'rejected by provider' };
  if (res.status === 403) return { status: 'unknown', reason: 'key accepted but not permitted (HTTP 403)' };
  if (res.status === 429) return { status: 'unknown', reason: 'rate limited (HTTP 429), try again' };
  return { status: 'unknown', reason: `provider returned HTTP ${res.status}` };
}

// Like statusOf, but lets a provider look at its JSON error body to tell
// "restricted but valid" apart from "invalid". Only the classification is kept.
async function checkWith(fetchImpl, url, headers, classify, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  } catch {
    return { status: 'unknown', reason: 'network error' };
  }
  let body = null;
  try { body = typeof res.json === 'function' ? await res.json() : null; } catch { body = null; }
  const verdict = classify(res.status, body ?? {});
  if (verdict) return { status: verdict, reason: verdict === 'invalid' ? 'rejected by provider' : undefined };
  if (res.status >= 200 && res.status < 300) return { status: 'valid' };
  if (res.status === 401) return { status: 'invalid', reason: 'rejected by provider' };
  if (res.status === 429) return { status: 'unknown', reason: 'rate limited (HTTP 429), try again' };
  return { status: 'unknown', reason: `provider returned HTTP ${res.status}` };
}

export const PROVIDERS = [
  {
    id: 'anthropic-admin',
    name: 'Anthropic (Admin)',
    format: /^sk-ant-admin\d{2}-[A-Za-z0-9_-]{20,}$/,
    rotateUrl: 'https://platform.claude.com/settings/admin-keys',
  },
  {
    id: 'anthropic-oauth',
    name: 'Anthropic (OAuth token)',
    format: /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}$/,
    rotateUrl: 'https://claude.ai/settings',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    // api03 is the classic type; accept any type label so new formats still match.
    format: /^sk-ant-[A-Za-z0-9]+-[A-Za-z0-9_-]{20,}$/,
    prefix: 'sk-ant-',
    name_: /ANTHROPIC|CLAUDE/i,
    rotateUrl: 'https://platform.claude.com/settings/keys',
    verify: (key, fetchImpl) =>
      statusOf(fetchImpl, 'https://api.anthropic.com/v1/models?limit=1', {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      }),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    format: /^sk-or-v1-[A-Za-z0-9]{20,}$/,
    prefix: 'sk-or-',
    name_: /OPENROUTER/i,
    rotateUrl: 'https://openrouter.ai/settings/keys',
    verify: (key, fetchImpl) =>
      statusOf(fetchImpl, 'https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` }),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    format: /^sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}$|^sk-[A-Za-z0-9]{40,}$/,
    // Plain sk-... is also used by DeepSeek, Moonshot, Together and other OpenAI-compatible APIs.
    sharedFormat: /^sk-[A-Za-z0-9]{40,}$/,
    prefix: 'sk-',
    name_: /OPENAI/i,
    rotateUrl: 'https://platform.openai.com/api-keys',
    verify: (key, fetchImpl) => statusOf(fetchImpl, 'https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` }),
  },
  {
    id: 'resend-webhook',
    kind: 'signing',
    name: 'Resend (webhook secret)',
    name_: /RESEND.*WEBHOOK/i,
    shape: /^whsec_/,
    rotateUrl: 'https://resend.com/webhooks',
  },
  {
    id: 'resend',
    name: 'Resend',
    format: /^re_[A-Za-z0-9_]{20,}$/,
    prefix: 're_',
    name_: /RESEND/i,
    rotateUrl: 'https://resend.com/api-keys',
    // Sending-only keys can't list domains: Resend answers 401 "restricted_api_key", which still means the key is real.
    verify: (key, fetchImpl) => checkWith(fetchImpl, 'https://api.resend.com/domains', { Authorization: `Bearer ${key}` },
      (status, body) => (/restricted/i.test(String(body.name ?? body.message ?? '')) ? 'valid'
        : /api key is invalid/i.test(String(body.message ?? '')) ? 'invalid' : null)),
  },
  {
    // Clerk secret keys look exactly like Stripe's (sk_test_/sk_live_), so the variable name decides.
    id: 'clerk',
    name: 'Clerk',
    name_: /CLERK/i,
    preferName: true,
    shape: /^sk_(live|test)_/,
    rotateUrl: 'https://dashboard.clerk.com/last-active?path=api-keys',
    verify: (key, fetchImpl) => statusOf(fetchImpl, 'https://api.clerk.com/v1/users?limit=1', { Authorization: `Bearer ${key}` }),
  },
  {
    id: 'stripe-webhook',
    kind: 'signing',
    name: 'Stripe (webhook secret)',
    name_: /STRIPE.*WEBHOOK/i,
    shape: /^whsec_/,
    rotateUrl: 'https://dashboard.stripe.com/webhooks',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    format: /^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/,
    sharedFormat: /^sk_(live|test)_/, // Clerk uses the same shape
    name_: /STRIPE/i,
    rotateUrl: 'https://dashboard.stripe.com/apikeys',
    verify: (key, fetchImpl) => checkWith(fetchImpl, 'https://api.stripe.com/v1/balance', { Authorization: `Bearer ${key}` },
      (status) => (status === 403 ? 'valid' : null)), // restricted key without balance access: real, just limited
  },
  {
    // Any other service's webhook signing secret (Svix-style whsec_...).
    id: 'webhook-secret',
    kind: 'signing',
    name: 'Webhook signing secrets',
    format: /^whsec_[A-Za-z0-9+/=_-]{16,}$/,
    rotateUrl: null,
  },
  {
    id: 'vercel-blob',
    name: 'Vercel Blob',
    format: /^vercel_blob_rw_[A-Za-z0-9_]{20,}$/,
    name_: /^BLOB_READ_WRITE_TOKEN$/i,
    rotateUrl: 'https://vercel.com/dashboard/stores',
  },
  {
    id: 'vercel-oidc',
    kind: 'signing',
    name: 'Vercel (OIDC, auto-generated)',
    name_: /^VERCEL_OIDC_TOKEN$/i,
    shape: /^eyJ/,
    rotateUrl: 'https://vercel.com/docs/oidc',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    name_: /VERCEL/i,
    rotateUrl: 'https://vercel.com/account/settings/tokens',
    verify: (key, fetchImpl) => checkWith(fetchImpl, 'https://api.vercel.com/v2/user', { Authorization: `Bearer ${key}` },
      (status, body) => (status === 403 && body?.error?.invalidToken ? 'invalid' : status === 403 ? 'valid' : null)),
  },
  {
    id: 'paypal',
    name: 'PayPal',
    name_: /PAYPAL/i,
    rotateUrl: 'https://developer.paypal.com/dashboard/applications',
  },
  {
    id: 'github',
    name: 'GitHub',
    format: /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$|^github_pat_[A-Za-z0-9_]{50,}$/,
    name_: /GITHUB|GH_TOKEN/i,
    rotateUrl: 'https://github.com/settings/tokens',
    verify: (key, fetchImpl) => statusOf(fetchImpl, 'https://api.github.com/user', { Authorization: `Bearer ${key}`, 'User-Agent': 'burnkeys' }),
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    format: /^sk_[a-f0-9]{48}$/,
    sharedFormat: /^sk_/,
    name_: /ELEVEN/i,
    rotateUrl: 'https://elevenlabs.io/app/developers/api-keys',
    verify: (key, fetchImpl) => checkWith(fetchImpl, 'https://api.elevenlabs.io/v1/user', { 'xi-api-key': key },
      (status, body) => (/missing_permissions/i.test(JSON.stringify(body)) ? 'valid'
        : /invalid_api_key/i.test(JSON.stringify(body)) ? 'invalid' : null)),
  },
  {
    id: 'fishaudio',
    name: 'Fish Audio',
    name_: /FISH/i,
    rotateUrl: 'https://fish.audio/app/api-keys/',
    verify: (key, fetchImpl) => statusOf(fetchImpl, 'https://api.fish.audio/wallet/self/api-credit', { Authorization: `Bearer ${key}` }),
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare / R2',
    name_: /(^|_)(R2|CLOUDFLARE|CF)(_|$)/i,
    rotateUrl: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
  },
  {
    id: 'firebase',
    name: 'Firebase / Google Cloud',
    format: /"private_key"[\s\S]*"client_email"|"client_email"[\s\S]*"private_key"/,
    name_: /FIREBASE|FCM_|GOOGLE_APPLICATION_CREDENTIALS|GCP_|SERVICE_ACCOUNT/i,
    rotateUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    verify: (key, fetchImpl) => checkServiceAccount(key, fetchImpl),
  },
  {
    id: 'cjdropshipping',
    name: 'CJdropshipping',
    name_: /^CJ_|CJDROPSHIPPING/i,
    rotateUrl: 'https://cjdropshipping.com/myCJ.html#/apikey',
  },
  {
    id: 'cloudways',
    name: 'Cloudways',
    name_: /CLOUDWAYS/i,
    rotateUrl: 'https://platform.cloudways.com/api',
  },
  {
    id: 'apns',
    name: 'Apple APNs',
    name_: /APNS|APN_/i,
    rotateUrl: 'https://developer.apple.com/account/resources/authkeys/list',
  },
  {
    id: 'x',
    name: 'X (Twitter) API',
    name_: /(^|_)(X|TWITTER)_.*(BEARER|TOKEN|KEY|SECRET)/i,
    rotateUrl: 'https://console.x.com',
  },
  {
    id: 'railway',
    name: 'Railway',
    name_: /RAILWAY/i,
    rotateUrl: 'https://railway.com/account/tokens',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    name_: /NETLIFY_(AUTH_)?TOKEN/i,
    rotateUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
  },
  {
    id: 'fly',
    name: 'Fly.io',
    name_: /FLY_(API_|ACCESS_)?TOKEN/i,
    rotateUrl: 'https://fly.io/user/personal_access_tokens',
  },
  {
    id: 'render',
    name: 'Render',
    name_: /RENDER_API_KEY/i,
    rotateUrl: 'https://dashboard.render.com/u/settings#api-keys',
  },
  {
    // Secrets the app owner invents: no provider, rotate by generating a new random value.
    id: 'self',
    name: 'Your own secret',
    name_: /PASSWORD|PASSWD|SESSION_SECRET|COOKIE_SECRET|JWT_SECRET|AUTH_SECRET|NEXTAUTH_SECRET|ENCRYPTION_KEY|SIGNING_SECRET|APP_SECRET/i,
    rotateUrl: null,
  },
];

// Names that suggest a secret even when the value format is unknown.
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|BEARER|AUTH|SERVICE_ACCOUNT/i;
const NOT_SECRET_VALUE = /^(true|false|null|undefined|\d{1,6}|https?:\/\/[^@\s]*)$/i;
// Values that are meant to be public (shipped to browsers / apps).
const PUBLIC_NAME = /^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_)/;
const PUBLIC_VALUE = /^pk_(live|test)_/;
// Identifiers: not secret on their own.
const IDENTIFIER_NAME = /(_KEY_ID|_CLIENT_ID|_ACCOUNT_ID|_PROJECT_ID|_TEAM_ID|_APP_ID|_ORG_ID)$/i;

// Services that reuse another provider's key shape (mostly OpenAI-compatible APIs).
// If the variable name mentions one of them, a shared shape is not trusted.
const OTHER_SERVICE_NAME = /DEEPSEEK|MOONSHOT|KIMI|QWEN|DASHSCOPE|TOGETHER|FIREWORKS|PERPLEXITY|GROQ|MISTRAL|XAI|GROK|ZHIPU|BAICHUAN|MINIMAX|SILICONFLOW|NOVITA|DEEPINFRA|LEPTON|ANYSCALE|OLLAMA|LITELLM|AZURE/i;

const nameFits = (p, name, value) => !!name && !!p.name_?.test(name) && (!p.shape || p.shape.test(value));

// Returns { provider, confidence } or null if the variable does not look like a secret.
// Order matters, so lookalike keys from different services never get mixed up:
//   1. public values are skipped;
//   2. providers whose keys look exactly like another's (Clerk vs Stripe) win by name;
//   3. a format unique to one provider wins;
//   4. a format shared with other services only counts when the name doesn't point elsewhere;
//   5. otherwise the variable name decides.
export function identify(name, value) {
  if (!value) return null;
  if (PUBLIC_NAME.test(name) || PUBLIC_VALUE.test(value)) return null;
  const trimmed = value.trim();
  const plausible = !NOT_SECRET_VALUE.test(value) && value.length >= 8;
  if (plausible) {
    for (const p of PROVIDERS) if (p.preferName && nameFits(p, name, trimmed)) return { provider: p, confidence: 'name' };
  }
  for (const p of PROVIDERS) {
    if (!p.format?.test(trimmed)) continue;
    if (p.sharedFormat?.test(trimmed) && name && !p.name_?.test(name)) {
      if (OTHER_SERVICE_NAME.test(name)) return { provider: null, confidence: 'name' };
      const other = PROVIDERS.find((q) => q !== p && !q.kind && q.id !== 'self' && nameFits(q, name, trimmed));
      if (other) return { provider: other, confidence: 'name' };
    }
    // Signing secrets: pick the service by name when we know it.
    if (p.id === 'webhook-secret') {
      const svc = PROVIDERS.find((q) => q.kind === 'signing' && q.shape?.test(trimmed) && nameFits(q, name, trimmed));
      if (svc) return { provider: svc, confidence: 'format' };
    }
    return { provider: p, confidence: 'format' };
  }
  // From here on only the variable name hints at a secret: require the value
  // to look like one too, so R2_BUCKET=photos or PORT=3000 are not reported.
  if (IDENTIFIER_NAME.test(name)) return null;
  if (!SECRET_NAME.test(name) || !plausible) return null;
  for (const p of PROVIDERS) {
    if (nameFits(p, name, trimmed)) return { provider: p, confidence: 'name' };
  }
  return { provider: null, confidence: 'name' };
}

// For a key recognised only by its variable name although the provider has a
// known format: describe why the format did not match - without revealing the value.
export function formatHint(provider, value) {
  if (!provider?.format) return null;
  const notes = [`length ${value.length}`];
  if (provider.prefix) notes.push(value.trim().startsWith(provider.prefix) ? `starts with ${provider.prefix}` : `does NOT start with ${provider.prefix}`);
  if (value !== value.trim()) notes.push('has spaces at the start/end');
  else if (/\s/.test(value)) notes.push('contains spaces');
  if (/^(your|xxx|changeme|replace|todo|<)/i.test(value)) notes.push('looks like a placeholder');
  // The type label right after the prefix (e.g. "api03") is a public format marker, not secret.
  const v = value.trim();
  if (provider.prefix && v.startsWith(provider.prefix)) {
    const label = v.slice(provider.prefix.length).split('-')[0];
    notes.push(/^[a-z]{2,10}\d{0,3}$/.test(label) ? `type "${label}"` : 'no type label after the prefix');
  }
  if (/[^A-Za-z0-9_-]/.test(v)) notes.push('contains characters other than letters, digits, - and _');
  return notes.join(', ');
}

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}
