---
name: keys
description: Check the API keys in this project (or a folder the user names) - which provider each belongs to, where it is used, and whether it still works. Use when the user asks about their API keys, secrets, .env files, a leak or breach, or why an integration (email, AI, payments) stopped working.
---

# Burnkeys: check API keys

The Burnkeys CLI is in this plugin: `bin/burnkeys.js`, two directories above this skill's base directory. Run it with the Node.js that ships next to it (`<plugin root>/../node/bin/node`, inside the Burnkeys app) or, if that doesn't exist, with `node`.

1. Run `node "<plugin root>/bin/burnkeys.js" verify "<folder>"` (default folder: the current project). It prints each key's provider, variable name, a one-way fingerprint (`fp:xxxxxxxx`) and a status. It never prints key values.
2. If the user wants the full inventory (every secret, where it lives, rotation links, git safety), also run `scan` on the same folder.
3. Summarise in plain language: which keys are dead (and what is probably broken because of it), which are shared between projects, and any file-safety warnings. Offer to rotate a dead or leaked key with the `rotate` skill.

Rules:
- Never ask the user to paste a key into the chat, and never print, read or `cat` .env files yourself. Burnkeys does the reading.
- Fingerprints are safe to show; key values are not.
