# Verify it yourself

Burnkeys reads your `.env` files, so you shouldn't have to take our word for what it does with them.

This repository's open core (Apache-2.0) finds keys, checks each one with its own provider, and replaces keys. It sends no telemetry. Pro features are not part of the public source at [github.com/Claudewebsites/burnkeys-source](https://github.com/Claudewebsites/burnkeys-source). The Mac app from burnkeys.com includes them. Email alerts and the assistant run on burnkeys.com, which refuses them unless that site's record of the account is Pro.

## Where keys go

A key value is sent only to:

- **its own provider**, to check that it works (for example `api.openai.com`, `api.anthropic.com`, `api.stripe.com`, `api.github.com`, `api.resend.com`); the provider list is in [`src/providers.js`](src/providers.js);
- **your hosting platform**, only when you tick "Also update …" while replacing a key: `api.vercel.com`, `backboard.railway.com`, `api.netlify.com`, `api.fly.io`, `api.render.com` ([`src/vercel.js`](src/vercel.js), [`src/hosts.js`](src/hosts.js)).

burnkeys.com never receives a key. The Mac app requires a free account before it shows projects or keys. It talks to burnkeys.com for that account (email and plan only) and downloads the public breach list (`/advisories.json`). The terminal version does not ask you to sign in.

Checks while the app is closed, the email that follows them, and the assistant are Pro. They are not in the public source. The app we ship asks burnkeys.com whether the account is Pro before it turns them on, and burnkeys.com checks the account again before it sends an email or answers the assistant. Those requests carry provider names, variable names, project names and fingerprints, never a key. A message that looks like a key is refused on the Mac before it is sent.

The free limits in the open core are 3 projects and 10 providers. The scan stays on your computer, so a modified copy of the open core can change that local limit. That change cannot make burnkeys.com send Pro email or run the assistant.

## Check it

- **Read the code.** The open core has no dependencies: everything that runs in the public source is in `bin/`, `src/`, `hooks/`, `skills/` and `mac/`.
- **Watch the network.** Run Burnkeys with Little Snitch or LuLu, or with `sudo lsof -i -n -P | grep -i node`, and compare the hosts with the list above.
- **Check the build.** The Mac app from burnkeys.com is signed with Developer ID "SSTA Digital industry LTD (WS7RN89595)" and notarized by Apple:
  `codesign -dv --verbose=2 /Applications/Burnkeys.app` and `spctl -a -vv /Applications/Burnkeys.app`.
- **Run the tests.** `npm test` (Node 22 or later).

Found something? Email hello@burnkeys.com (see [SECURITY.md](SECURITY.md)).

