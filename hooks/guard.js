#!/usr/bin/env node
// UserPromptSubmit hook: if the message contains an API key, block it before it
// reaches the model. Only the provider and a fingerprint are shown - never the key.
import { detectSecretsInText } from '../src/detect.js';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const input = JSON.parse(await readStdin());
  const found = detectSecretsInText(String(input.prompt ?? ''));
  if (found.length) {
    const list = found.map((f) => `${f.provider}${f.fp !== 'fp:-' ? ` (${f.fp})` : ''}`).join(', ');
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `Burnkeys blocked this message: it contains a secret (${list}). It was not sent to Claude. ` +
        'Remove the key and send again. To give a key to a project, use the Burnkeys app or `burnkeys replace` in your terminal. ' +
        'If this key was ever shared somewhere it should not be, rotate it.',
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
    }));
  }
} catch {
  // Never break the chat because of a guard error.
}
process.exit(0);
