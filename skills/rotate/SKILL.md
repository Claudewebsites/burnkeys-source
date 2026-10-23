---
name: rotate
description: Replace (rotate) an API key everywhere it is used - local .env files and, if the user agrees, the linked Vercel project - without the key ever passing through the chat. Use when a key is dead, leaked, or the user asks to rotate/replace/change a key.
---

# Burnkeys: rotate a key

The Burnkeys CLI is in this plugin: `bin/burnkeys.js`, two directories above this skill's base directory. Use the Node.js that ships next to it (`<plugin root>/../node/bin/node`, inside the Burnkeys app) if it exists, otherwise `node`.

1. Find the key's fingerprint: run `node "<plugin root>/bin/burnkeys.js" scan "<folder>"` and pick the row the user means (provider + variable). If it is ambiguous, ask.
2. Tell the user, briefly:
   - "I'll open the provider's key page. Create a new key there and click its Copy button. Don't paste it here - Burnkeys picks it up from the clipboard by itself and clears it."
   - For Anthropic: create the key inside a workspace.
   - Ask whether to also update Vercel and redeploy, if the project is hosted there.
3. Run, with a timeout of at least 5 minutes:
   `node "<plugin root>/bin/burnkeys.js" replace <fingerprint> "<folder>" --open --wait-clipboard --yes`
   Add `--vercel` only if the user agreed to update Vercel and redeploy.
4. Burnkeys checks the new key with the provider before writing anything. Report the result in plain language: files updated, Vercel updated, redeploy link, or what went wrong. If it says the new key does not work, nothing was changed; help the user create a working key and run step 3 again.
5. Remind the user to revoke the old key on the provider's site once everything works, and offer to confirm with the `keys` skill.

Rules:
- Never ask for the key in chat, never read .env files yourself, never print key values.
- If the user pastes a key into the chat anyway, tell them to treat it as exposed and rotate it.
