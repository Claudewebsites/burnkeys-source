import { PROVIDERS } from './providers.js';

// Every provider the app offers under "Add a provider": the detected ones
// (with live checks where available) plus common services people add by hand.
// `variable` is the usual env var name; `keysUrl` is where a key is created.
const EXTRA = [
  { id: 'gemini', name: 'Google Gemini', variable: 'GEMINI_API_KEY', keysUrl: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', name: 'Mistral', variable: 'MISTRAL_API_KEY', keysUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', name: 'Groq', variable: 'GROQ_API_KEY', keysUrl: 'https://console.groq.com/keys' },
  { id: 'xai', name: 'xAI (Grok)', variable: 'XAI_API_KEY', keysUrl: 'https://console.x.ai' },
  { id: 'replicate', name: 'Replicate', variable: 'REPLICATE_API_TOKEN', keysUrl: 'https://replicate.com/account/api-tokens' },
  { id: 'fal', name: 'fal', variable: 'FAL_KEY', keysUrl: 'https://fal.ai/dashboard/keys' },
  { id: 'deepgram', name: 'Deepgram', variable: 'DEEPGRAM_API_KEY', keysUrl: 'https://console.deepgram.com' },
  { id: 'cohere', name: 'Cohere', variable: 'COHERE_API_KEY', keysUrl: 'https://dashboard.cohere.com/api-keys' },
  { id: 'supabase', name: 'Supabase', variable: 'SUPABASE_SERVICE_ROLE_KEY', keysUrl: 'https://supabase.com/dashboard/project/_/settings/api' },
  { id: 'twilio', name: 'Twilio', variable: 'TWILIO_AUTH_TOKEN', keysUrl: 'https://console.twilio.com' },
  { id: 'sendgrid', name: 'SendGrid', variable: 'SENDGRID_API_KEY', keysUrl: 'https://app.sendgrid.com/settings/api_keys' },
  { id: 'postmark', name: 'Postmark', variable: 'POSTMARK_SERVER_TOKEN', keysUrl: 'https://account.postmarkapp.com/servers' },
  { id: 'mailgun', name: 'Mailgun', variable: 'MAILGUN_API_KEY', keysUrl: 'https://app.mailgun.com/settings/api_security' },
  { id: 'posthog', name: 'PostHog', variable: 'POSTHOG_API_KEY', keysUrl: 'https://us.posthog.com/settings/user-api-keys' },
  { id: 'sentry', name: 'Sentry', variable: 'SENTRY_AUTH_TOKEN', keysUrl: 'https://sentry.io/settings/account/api/auth-tokens/' },
  { id: 'revenuecat', name: 'RevenueCat', variable: 'REVENUECAT_API_KEY', keysUrl: 'https://app.revenuecat.com' },
  { id: 'pinecone', name: 'Pinecone', variable: 'PINECONE_API_KEY', keysUrl: 'https://app.pinecone.io' },
  { id: 'upstash', name: 'Upstash', variable: 'UPSTASH_REDIS_REST_TOKEN', keysUrl: 'https://console.upstash.com' },
  { id: 'cloudinary', name: 'Cloudinary', variable: 'CLOUDINARY_API_SECRET', keysUrl: 'https://console.cloudinary.com/settings/api-keys' },
];

const VARS = {
  anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', resend: 'RESEND_API_KEY',
  stripe: 'STRIPE_SECRET_KEY', github: 'GITHUB_TOKEN', elevenlabs: 'ELEVENLABS_API_KEY', fishaudio: 'FISH_API_KEY',
  cloudflare: 'R2_SECRET_ACCESS_KEY', vercel: 'VERCEL_TOKEN', paypal: 'PAYPAL_CLIENT_SECRET', x: 'X_BEARER_TOKEN',
  cjdropshipping: 'CJ_API_KEY', cloudways: 'CLOUDWAYS_API_KEY', clerk: 'CLERK_SECRET_KEY',
  firebase: 'FIREBASE_SERVICE_ACCOUNT', apns: 'APNS_PRIVATE_KEY', railway: 'RAILWAY_TOKEN',
  netlify: 'NETLIFY_AUTH_TOKEN', fly: 'FLY_API_TOKEN', render: 'RENDER_API_KEY',
};

// Providers whose credentials come in several parts. Each part is collected in
// order (clipboard, typed, or a dropped file) and all are written together.
// `id: true` marks identifiers (not secret); `file` parts are dropped as files.
const FIELDS = {
  x: [
    { variable: 'X_API_KEY', label: 'API Key (Consumer Key)' },
    { variable: 'X_API_SECRET', label: 'API Key Secret' },
    { variable: 'X_BEARER_TOKEN', label: 'Bearer Token' },
    { variable: 'X_ACCESS_TOKEN', label: 'Access Token', optional: true },
    { variable: 'X_ACCESS_TOKEN_SECRET', label: 'Access Token Secret', optional: true },
  ],
  paypal: [
    { variable: 'PAYPAL_CLIENT_ID', label: 'Client ID', id: true },
    { variable: 'PAYPAL_CLIENT_SECRET', label: 'Secret' },
  ],
  cloudflare: [
    { variable: 'R2_ACCOUNT_ID', label: 'Account ID', id: true },
    { variable: 'R2_ACCESS_KEY_ID', label: 'Access Key ID', id: true },
    { variable: 'R2_SECRET_ACCESS_KEY', label: 'Secret Access Key' },
  ],
  apns: [
    { variable: 'APNS_KEY_ID', label: 'Key ID', id: true },
    { variable: 'APNS_TEAM_ID', label: 'Team ID', id: true },
    { variable: 'APNS_PRIVATE_KEY', label: 'The .p8 key file', file: '.p8' },
  ],
  firebase: [
    { variable: 'FIREBASE_SERVICE_ACCOUNT', label: 'The service account .json file', file: '.json' },
  ],
};

// Turn a dropped/typed value into what goes in the .env file (one line), or null if it doesn't fit.
export function normalizePart(field, raw) {
  const v = String(raw ?? '').trim();
  if (field.file === '.p8') {
    if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(v)) return null;
    return v.replace(/\r?\n/g, '\\n'); // single line; apps read it with .replace(/\\n/g, '\n')
  }
  if (field.file === '.json') {
    try { const j = JSON.parse(v); return j.private_key && j.client_email ? JSON.stringify(j) : null; } catch { return null; }
  }
  if (!v || /\s/.test(v) || v.length > 400) return null;
  return v.length >= (field.id ? 4 : 16) ? v : null;
}

// Check a full set of parts where we can, without paid calls. Returns 'valid' | 'invalid' | 'unknown'.
export async function checkParts(providerId, parts, fetchImpl) {
  try {
    if (providerId === 'paypal' && parts.PAYPAL_CLIENT_ID && parts.PAYPAL_CLIENT_SECRET) {
      const auth = 'Basic ' + Buffer.from(`${parts.PAYPAL_CLIENT_ID}:${parts.PAYPAL_CLIENT_SECRET}`).toString('base64');
      for (const host of ['api-m.paypal.com', 'api-m.sandbox.paypal.com']) {
        const r = await fetchImpl(`https://${host}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10_000) });
        try { await r.body?.cancel(); } catch { /* ignore */ }
        if (r.ok) return 'valid';
      }
      return 'invalid';
    }
    if (providerId === 'firebase' && parts.FIREBASE_SERVICE_ACCOUNT) {
      return (await PROVIDERS.find((p) => p.id === 'firebase').verify(parts.FIREBASE_SERVICE_ACCOUNT, fetchImpl)).status;
    }
  } catch { /* fall through */ }
  return 'unknown';
}

export const CATALOG = [
  ...PROVIDERS.filter((p) => VARS[p.id]).map((p) => ({ id: p.id, name: p.name, variable: VARS[p.id], keysUrl: p.rotateUrl, provider: p, fields: FIELDS[p.id] ?? null })),
  ...EXTRA,
].sort((a, b) => a.name.localeCompare(b.name));

export function catalogEntry(id) {
  return CATALOG.find((c) => c.id === id) ?? null;
}

// Does a clipboard value look like a key for this catalog entry?
export function looksLikeKeyFor(entry, value) {
  if (!value || /\s/.test(value) || value.length < 16) return false;
  if (entry.provider?.format) return entry.provider.format.test(value);
  return value.length <= 400;
}
