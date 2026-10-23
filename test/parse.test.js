import { test } from 'node:test';
import { parseEnv } from '../src/envfiles.js';
import { identify } from '../src/providers.js';
import { fake } from './helpers.js';

test('parseEnv handles export, quotes, comments and multi-line values', (t) => {
  const vars = parseEnv([
    '# comment',
    'export A=1',
    'B="two words" # trailing',
    "C='single'",
    'D=plain # inline comment',
    'E="-----BEGIN PRIVATE KEY-----',
    'abc',
    '-----END PRIVATE KEY-----"',
    'F=',
  ].join('\n'));
  const m = Object.fromEntries(vars.map((v) => [v.name, v.value]));
  t.assert.equal(m.A, '1');
  t.assert.equal(m.B, 'two words');
  t.assert.equal(m.C, 'single');
  t.assert.equal(m.D, 'plain');
  t.assert.equal(m.E, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  t.assert.equal(m.F, '');
});

test('identify recognises providers by key format', (t) => {
  t.assert.equal(identify('X', fake.anthropic()).provider.id, 'anthropic');
  t.assert.equal(identify('X', fake.anthropicAdmin()).provider.id, 'anthropic-admin');
  t.assert.equal(identify('X', fake.openrouter()).provider.id, 'openrouter');
  t.assert.equal(identify('X', fake.openai()).provider.id, 'openai');
  t.assert.equal(identify('X', fake.resend()).provider.id, 'resend');
  t.assert.equal(identify('X', fake.elevenlabs()).provider.id, 'elevenlabs');
});

test('identify uses variable names only when the value looks secret', (t) => {
  const fish = identify('FISH_AUDIO_API_KEY', fake.generic());
  t.assert.equal(fish.provider.id, 'fishaudio');
  t.assert.equal(fish.confidence, 'name');
  t.assert.equal(identify('R2_SECRET_ACCESS_KEY', fake.generic()).provider.id, 'cloudflare');
  t.assert.equal(identify('ADMIN_PASSWORD', fake.generic()).provider.id, 'self');
  t.assert.equal(identify('CJ_API_KEY', fake.generic()).provider.id, 'cjdropshipping');
  t.assert.equal(identify('SOME_API_KEY', fake.generic()).provider, null); // unknown secret
  t.assert.equal(identify('R2_BUCKET', 'photos'), null);
  t.assert.equal(identify('FIREBASE_PROJECT_ID', 'my-app'), null);
  t.assert.equal(identify('PORT', '3000'), null);
  t.assert.equal(identify('API_KEY_ENABLED', 'true'), null);
});

test('identify: findings from the founder\'s first real scan', (t) => {
  // An Anthropic key in an unexpected format is still recognised by its name (and gets checked).
  t.assert.equal(identify('ANTHROPIC_API_KEY', fake.generic()).provider.id, 'anthropic');
  // Public values are not secrets.
  t.assert.equal(identify('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_' + 'live_' + fake.generic()), null);
  t.assert.equal(identify('STRIPE_KEY', 'pk_' + 'test_' + fake.generic()), null);
  // Identifiers are not secrets.
  t.assert.equal(identify('APNS_KEY_ID', 'ABCDE12345'), null);
  t.assert.equal(identify('R2_ACCESS_KEY_ID', fake.generic()), null);
  // Previously "Unknown secret".
  t.assert.equal(identify('RESEND_WEBHOOK_SECRET', 'whsec_' + fake.generic()).provider.id, 'resend-webhook');
  t.assert.equal(identify('RESEND_API_KEY', fake.resend()).provider.id, 'resend');
  t.assert.equal(identify('VERCEL_TOKEN', fake.generic()).provider.id, 'vercel');
  t.assert.equal(identify('VERCEL_OIDC_TOKEN', 'eyJ' + fake.generic()).provider.id, 'vercel-oidc');
  t.assert.equal(identify('BLOB_READ_WRITE_TOKEN', fake.generic()).provider.id, 'vercel-blob');
  t.assert.equal(identify('PAYPAL_CLIENT_SECRET', fake.generic()).provider.id, 'paypal');
  t.assert.equal(identify('SESSION_SECRET', fake.generic()).provider.id, 'self');
  t.assert.equal(identify('FCM_SERVICE_ACCOUNT', '{"type":"service_account"}' + fake.generic()).provider.id, 'firebase');
  t.assert.equal(identify('X', 'sk-ant-' + 'oat01-' + fake.generic()).provider.id, 'anthropic-oauth');
});

test('formatHint explains a format mismatch without revealing the value', async (t) => {
  const { providerById, formatHint } = await import('../src/providers.js');
  const anthropic = providerById('anthropic');
  const secret = fake.generic();
  const hint = formatHint(anthropic, ' ' + secret);
  t.assert.match(hint, /does NOT start with sk-ant-/);
  t.assert.match(hint, /spaces at the start\/end/);
  t.assert.ok(!hint.includes(secret.slice(0, 8)));
  t.assert.equal(identify('ANTHROPIC_API_KEY', ' ' + fake.anthropic() + ' ').confidence, 'format');
  t.assert.equal(identify('CLOUDWAYS_API_KEY', secret).provider.id, 'cloudways');
});

test('Anthropic keys with a new type label still match by format', (t) => {
  t.assert.equal(identify('X', 'sk-ant-' + 'api04-' + fake.generic() + fake.generic()).confidence, 'format');
  t.assert.equal(identify('ANTHROPIC_API_KEY', 'sk-ant-' + 'api03-' + fake.generic() + '.x').confidence, 'name');
});

test('identify never mixes up lookalike keys from different services', (t) => {
  const stripeShape = () => 'sk_' + 'live_' + fake.generic();
  // Clerk and Stripe secret keys have the same shape: the name decides.
  t.assert.equal(identify('CLERK_SECRET_KEY', stripeShape()).provider.id, 'clerk');
  t.assert.equal(identify('STRIPE_SECRET_KEY', stripeShape()).provider.id, 'stripe');
  t.assert.equal(identify('X', stripeShape()).provider.id, 'stripe');
  // A Clerk webhook secret is not a Clerk API key.
  t.assert.equal(identify('CLERK_WEBHOOK_SECRET', 'whsec_' + fake.generic()).provider.id, 'webhook-secret');
  t.assert.equal(identify('STRIPE_WEBHOOK_SECRET', 'whsec_' + fake.generic()).provider.id, 'stripe-webhook');
  // A real Resend API key under a webhook-ish name is still the API key.
  t.assert.equal(identify('RESEND_WEBHOOK_SECRET', fake.resend()).provider.id, 'resend');
  // Plain sk-... keys from OpenAI-compatible services are not OpenAI.
  const legacy = 'sk-' + fake.generic() + fake.generic();
  t.assert.equal(identify('OPENAI_API_KEY', legacy).provider.id, 'openai');
  t.assert.equal(identify('DEEPSEEK_API_KEY', legacy).provider, null);
  t.assert.equal(identify('TOGETHER_API_KEY', legacy).provider, null);
  // But a unique format always wins over the name.
  t.assert.equal(identify('DEEPSEEK_API_KEY', fake.openai()).provider.id, 'openai');
  t.assert.equal(identify('OPENAI_API_KEY', fake.anthropic()).provider.id, 'anthropic');
  // ElevenLabs-shaped value under a Fish Audio name is Fish Audio.
  t.assert.equal(identify('FISH_API_KEY', fake.elevenlabs()).provider.id, 'fishaudio');
  // The OIDC rule needs a JWT; anything else under that name is a normal Vercel secret.
  t.assert.equal(identify('VERCEL_OIDC_TOKEN', fake.generic()).provider.id, 'vercel');
});
