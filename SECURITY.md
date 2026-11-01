# Security

Burnkeys handles the most sensitive strings you own, so its design rules are strict:

- **Keys stay on your Mac.** Scanning, checking and replacing run on your computer. A key is sent
  only to the provider it belongs to (to check it), and, when you ask, to the host you are updating
  (Vercel, Railway, Netlify, Fly.io or Render). Nothing else ever receives a key value.
- **Never prints a secret.** Keys are shown only as a one-way fingerprint (`fp:` + first 8 hex
  chars of SHA-256), plus the last 4 characters when you need to find a key on a provider's site.
  All output goes through a scrubber that removes any secret seen during the run.
- **Locked storage.** In the Mac app, saved keys are the app's own macOS Keychain items: any other
  program that tries to read them gets a macOS permission prompt.
- **Never takes secrets as arguments.** New keys come from the clipboard (cleared right after) or a
  hidden prompt, so they never end up in shell history or process lists.
- **No dependencies.** Nothing to hijack in a supply-chain attack beyond Node.js itself.
- **Careful writes.** Replacing checks the new key first, backs up each file (to
  `~/.burnkeys/backups`, readable only by you), writes atomically, and re-reads to confirm.

## What reaches burnkeys.com

Only if you use these features, and never a key:

- **Account:** the Mac app requires a free account before it shows projects or keys. The account
  holds your email and plan, never a key. The terminal version does not ask you to sign in.
- **Breach list:** the app downloads the public list from burnkeys.com/advisories.json and matches
  it on your Mac.
- **Pro email alerts and the assistant:** only if burnkeys.com has this account as Pro. The request
  carries provider names, variable names, project names and fingerprints. A message that looks like
  a key is refused on the Mac before anything is sent. The open core does not include these features.

Details: https://burnkeys.com/privacy/

## Reporting a vulnerability

Please do not open a public issue. Email hello@burnkeys.com with steps to reproduce.
We aim to respond within 48 hours.
