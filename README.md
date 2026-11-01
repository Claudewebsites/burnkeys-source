# Burnkeys

Find every API key in your projects, check each one with its provider, and replace it everywhere it's used. Burnkeys never prints a secret: keys appear as short fingerprints (`fp:1a2b3c4d`).

This repository is the open core. The Mac app from [burnkeys.com](https://burnkeys.com) also includes Pro: unlimited projects and providers, checks while Burnkeys is closed, email alerts, and the assistant. Those parts are not in this repository. Email alerts and the assistant run on burnkeys.com and only work when that site says the account is Pro.

- **Mac app:** [burnkeys.com](https://burnkeys.com) (Apple silicon or Intel, macOS 13.5 or later)
- **Terminal:** `brew install claudewebsites/burnkeys/burnkeys`
- **Claude Code plugin:** install it from the app (Settings, Claude Code)

## What this code does

- **Finds** every key in every `.env` file across your projects and names its provider.
- **Checks** each key live with its provider: works, dead, or couldn't check.
- **Replaces** a key everywhere it's used: copy the new key on the provider's site, Burnkeys checks it, backs up your files, writes it, and can update Vercel (and, in the Mac app, Railway, Netlify, Fly.io and Render).
- **Watches** for keys committed to git, keys shared between projects, and breaches at services you use.
- **Keeps keys out of AI chats:** the Claude Code plugin blocks messages that contain a key. Cursor, Codex and Claude Desktop can ask Burnkeys about your keys over MCP and only ever see statuses.

This code keeps the free limits: 3 projects and 10 providers. The downloaded Mac app lifts them only after burnkeys.com says the account is Pro. Changing this repository cannot make burnkeys.com send Pro email or answer the assistant.

## Terminal

```sh
burnkeys scan ~/code            # every key, its provider and where it's used
burnkeys verify ~/code          # ask each provider whether the key still works
burnkeys replace fp:1a2b3c4d    # put a new key everywhere the old one is used
burnkeys push fp:1a2b3c4d       # copy a key to the linked Vercel project and redeploy
burnkeys mcp                    # MCP server for Cursor, Codex, Claude Desktop
```

## Providers

Recognizes keys from Anthropic, OpenAI, OpenRouter, ElevenLabs, Fish Audio, Resend, Stripe, Clerk, PayPal, GitHub, Vercel, Cloudflare R2, Firebase, Apple APNs, X, Railway and more. Live checks for Anthropic, OpenAI, OpenRouter, Stripe, Clerk, Resend, ElevenLabs, Fish Audio, GitHub, Vercel and Firebase.

## Privacy

Key values are never printed and never sent to burnkeys.com. A check sends a key only to its own provider. Updating a host sends it only to that host (Vercel, and in the Mac app also Railway, Netlify, Fly.io and Render) when you ask. The Mac app requires a free account (Apple, GitHub or Google) before it shows projects or keys, including on the Free plan. The account holds your email and plan, never a key. The terminal version does not ask you to sign in. The app and CLI use no third-party packages and send no telemetry. Details: [burnkeys.com/privacy](https://burnkeys.com/privacy/).

## Plans

Free, with a free account: 3 projects and 10 providers. Pro ($8 a month or $72 a year): unlimited, checks while Burnkeys is closed, email alerts, and the assistant. Team: $20 per member a month. Pro and Team ship in the Mac app from burnkeys.com. They are not in this repository.

---

© 2026 SSTA Digital Industry Ltd. The code in this repository is licensed under Apache-2.0. Pro features and the burnkeys.com website and service are not included.
