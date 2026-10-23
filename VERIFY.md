# Verify it yourself

Burnkeys reads your `.env` files, so you shouldn't have to take our word for what it does with them.

## Where keys go

A key value is sent only to:

- **its own provider**, to check that it works (for example `api.openai.com`, `api.anthropic.com`, `api.stripe.com`, `api.github.com`, `api.resend.com`); the provider list is in [`src/providers.js`](src/providers.js);
- **your hosting platform**, only when you tick "Also update …" while replacing a key: `api.vercel.com`, `backboard.railway.com`, `api.netlify.com`, `api.fly.io`, `api.render.com` ([`src/vercel.js`](src/vercel.js), [`src/hosts.js`](src/hosts.js)).

`burnkeys.com` never receives a key. The app talks to it only for the optional account, the public breach list (`/advisories.json`), Pro email alerts and the assistant, and sends provider names, variable names, project names and fingerprints. The assistant refuses a message that looks like a key before anything is sent ([`src/app/server.js`](src/app/server.js), route `/api/assistant`).

## Check it

- **Read the code.** It has no dependencies: everything that runs is in `bin/`, `src/` and `mac/`.
- **Watch the network.** Run Burnkeys with Little Snitch or LuLu, or with `sudo lsof -i -n -P | grep -i node`, and compare the hosts with the list above.
- **Check the build.** The Mac app is signed with Developer ID "SSTA Digital industry LTD (WS7RN89595)" and notarized by Apple:
  `codesign -dv --verbose=2 /Applications/Burnkeys.app` and `spctl -a -vv /Applications/Burnkeys.app`.
- **Run the tests.** `npm test` (Node 20 or later).

Found something? Email hello@burnkeys.com (see [SECURITY.md](SECURITY.md)).
