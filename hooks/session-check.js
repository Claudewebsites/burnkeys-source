#!/usr/bin/env node
// SessionStart hook: quietly check this project's API keys. If one was rejected
// by its provider, tell the user (systemMessage) and Claude (additionalContext).
// Silent when everything works or nothing can be checked.
import { checkProject } from '../src/sessioncheck.js';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const input = JSON.parse(await readStdin());
  if (input.source !== 'compact' && input.cwd) {
    const result = await checkProject(input.cwd);
    if (result) {
      process.stdout.write(JSON.stringify({
        systemMessage: `Burnkeys: ${result.summary}. Anything that uses it is probably broken.`,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `Burnkeys (key health check): ${result.summary}. ` +
            'Tell the user about this at the start of your first reply, briefly, and mention that ' +
            'features depending on that key are likely broken. Never ask the user to paste a key into ' +
            'the chat; suggest running `burnkeys replace <fingerprint>` in their own terminal instead.',
        },
      }));
    }
  }
} catch {
  // Never block a session because of a check error.
}
process.exit(0);
