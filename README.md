# Burnkeys

Find every API key in your projects, check each one with its provider, and replace it everywhere it's used. Burnkeys never prints a secret: keys appear as short fingerprints (`fp:1a2b3c4d`).

- **Mac app:** [burnkeys.com](https://burnkeys.com) (Apple silicon, macOS 12 or later)
- **Terminal:** `brew install claudewebsites/burnkeys/burnkeys`
- **Claude Code plugin:** install it from the app (Settings, Claude Code)

## What it does

- **Finds** every key in every `.env` file across your projects and names its provider.
- **Checks** each key live with its provider: works, dead, or couldn't check.
- **Replaces** a key everywhere it's used: copy the new key on the provider's site, Burnkeys checks it, backs up your files, writes it, and can update Vercel and redeploy.
- **Watches** for keys committed to git, keys shared between projects, and breaches at services you use (for example Railway).
- **Keeps keys out of AI chats:** the Claude Code plugin blocks messages that contain a key. Cursor, Codex and Claude Desktop can ask Burnkeys about your keys over MCP and only ever see statuses.

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

Keys never leave your Mac except to their own provider (to check them) and to Vercel when you ask. The optional account, needed only for Pro, holds your email and plan. The app and CLI use no third-party packages and send no telemetry. Details: [burnkeys.com/privacy](https://burnkeys.com/privacy/).

## Plans

Free: 3 projects and 10 providers. Pro ($8 a month or $72 a year): unlimited, checks while Burnkeys is closed, email alerts, and the assistant.

---

© 2026 SSTA Digital Industry Ltd. All rights reserved. [Terms](https://burnkeys.com/terms/) · hello@burnkeys.com
