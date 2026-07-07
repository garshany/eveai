<p align="center">
  <img src="https://img.shields.io/badge/EVE%20Online-AI%20Assistant-1a1a2e?style=for-the-badge" alt="EVE AI" />
  <img src="https://img.shields.io/badge/Telegram-Long%20Polling-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
  <img src="https://img.shields.io/badge/Discord-Bot-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
</p>

# EVE AI Agent

> **Landing page:** [`index.html`](./index.html) — enable GitHub Pages (Settings → Pages → Deploy from branch → root) to publish it.

Self-hosted chat-first AI assistant for EVE Online with Telegram and Discord bots. It combines local EVE SDE data, live ESI data, killboard intelligence, route planning, and the official OpenAI Responses API model loop with tool calling.

This repository is designed for operators to run their own instance in a terminal. It does not require Redis, Postgres, queues, workers, webhooks, or a web frontend.

## Capabilities

- Natural-language Telegram and Discord assistant for EVE Online questions and workflows.
- EVE SSO linking for private character data, with scope-aware capability gating.
- Local SDE SQLite lookups for static game data such as systems, items, dogma, blueprints, and routes.
- Live ESI access for character, corporation, market, location, mail, skills, industry, assets, and related data when scopes are granted.
- Route planning with live danger analysis, killmail context, gate-camp signals, Thera/Turnur shortcut support, and monitor mode.
- D-scan, fleet, local, OSINT, EVE-KILL, EVE-Scout, zKillboard, and intel notes.
- Heartbeat notifications (mail, skills, wallet, industry, kills, and more) delivered to the chat where you talk to the bot.

## Architecture

```text
Telegram private chat ──> grammY long polling bot ─┐
                                                   ├─> shared agent runtime
Discord DM ───────────────> discord.js gateway bot ─┘        │
                                                             v
                                        OpenAI Responses API (/v1/responses)
                                                             │
                                                             v
                                          ESI / SDE / killboard tools ──> SQLite

Browser ──> Fastify ──> EVE SSO callback + /health ──> same SQLite state
```

Hard constraints:

- Single-process Node.js app.
- SQLite only.
- Telegram long polling only; no webhooks. Discord standard gateway connection.
- Fastify is limited to the EVE SSO OAuth callback and the health endpoint. There is no web frontend.
- Static game data comes from local SDE SQLite; live data comes from ESI.
- Private ESI access is isolated per user/chat and gated by `get_eve_capabilities`.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.

## Requirements

- Node.js 20+.
- npm.
- At least one bot token:
  - Telegram bot token from [@BotFather](https://t.me/BotFather), and/or
  - Discord bot token from <https://discord.com/developers/applications> (no privileged intents needed; the bot works in DMs).
- EVE Developer application from <https://developers.eveonline.com/>.
- OpenAI API key (official Responses API).

## Quick Start

```bash
git clone <your-public-fork-url> eveai
cd eveai
cp .env.example .env       # fill in the tokens
npm install
npm run setup              # download + load EVE static data (SDE)
npm run dev
```

Then open a private chat with your Telegram bot, or DM your Discord bot.

For local EVE SSO callbacks, set the callback URL in the EVE Developer Portal to:

```text
http://localhost:3000/auth/eve/callback
```

## Required Environment

Minimum local `.env` values (at least one bot token is required):

```env
TELEGRAM_BOT_TOKEN=...        # and/or DISCORD_BOT_TOKEN
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=medium
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSE_LANGUAGE=Russian
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
AUTH_SECRET_KEY=replace-with-random-secret
EVE_CALLBACK_URL=http://localhost:3000/auth/eve/callback
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/2.2 (+https://github.com/your-org/eveai; contact=you@example.com)
```

Generate `AUTH_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

Model defaults:

- `OPENAI_MODEL=gpt-5.5` — the current OpenAI recommendation for tool-heavy Responses API agents.
- `OPENAI_REASONING_EFFORT=medium` is the balanced starting point; evaluate `low` for latency-sensitive deployments.
- `OPENAI_TEXT_VERBOSITY=low` keeps chat answers compact; set `medium` if your community wants longer explanations.
- `OPENAI_RESPONSE_LANGUAGE=Russian` sets the default final-answer language. Aliases like `ru`, `русский`, `en`, `English`, and custom language names are accepted; an explicit user request can override it per answer.

## Scripts

```bash
npm run dev            # tsx watch mode (recommended for local runs)
npm run build          # compile server (tsc)
npm start              # run built app: node dist/app.js
npm run check          # typecheck + tests + lint
npm test               # vitest
npm run smoke          # env, model endpoint, app health checks
npm run smoke:openai   # authenticated /v1/responses probe
npm run smoke:eve-tool # authenticated model + EVE SDE tool probe
npm run db:migrate     # run SQLite migrations
npm run setup          # download and load SDE data
```

On startup the app prints a status banner with every subsystem (database, SDE data, HTTP, Telegram, Discord, OpenAI, heartbeat), and logs are colored, timestamped, and secret-redacted — everything an operator needs lives in the terminal.

## Runtime Smoke Test

Authenticated OpenAI smoke test:

```bash
OPENAI_API_KEY=... npm run smoke:openai
```

EVE tool smoke test:

```bash
OPENAI_API_KEY=... npm run smoke:eve-tool
```

For a DB-only SDE tool check without calling the model:

```bash
EVE_TOOL_SMOKE_MODE=direct npm run smoke:eve-tool
```

The scripts print only sanitized endpoint/model/tool metadata and answer previews. They never log API keys.

## Self-Hosting

See [docs/deployment.md](./docs/deployment.md) for a generic production deployment guide. Keep operator-specific server addresses, credentials, logs, certificates, and runbooks outside this repository.

## Documentation

- [AGENTS.md](./AGENTS.md): concise repo map and invariants.
- [ARCHITECTURE.md](./ARCHITECTURE.md): runtime boundaries and request flows.
- [docs/index.md](./docs/index.md): documentation catalog.
- [docs/SECURITY.md](./docs/SECURITY.md): security rules and current gaps.
- [docs/RELIABILITY.md](./docs/RELIABILITY.md): reliability model.
- [docs/deployment.md](./docs/deployment.md): generic self-host guide.
- [docs/openai-integration.md](./docs/openai-integration.md): OpenAI Responses API configuration.
- [docs/generated/db-schema.md](./docs/generated/db-schema.md): SQLite schema reference.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), keep PRs focused, and run `npm run check` when feasible. Good first areas include documentation, reproducible bug fixes, prompt tests, EVE SDE lookups, chat formatting, and self-hosting troubleshooting.

Please do not include secrets, private deployment notes, server IPs, logs, database files, or SDE dumps in issues or pull requests.

## Legal Notice

EVE Online and all related logos, images, and trademarks are the property of CCP hf. This project is a third-party tool and is not affiliated with, endorsed by, or supported by CCP Games.

Use of EVE Online SSO, ESI, SDE, and related game data is subject to the [EVE Online Developer License Agreement](https://developers.eveonline.com/license-agreement). Each self-hosting operator is responsible for accepting and complying with that agreement when creating an EVE Developer application and running an instance.

## Community Showcase Readiness

CCP's community documentation lists requirements for services/resources submitted to the EVE Developer Community Showcase: the project must be directly related to EVE Online, comply with the Developer License Agreement, be public, be production-ready, be public for at least three months, and be actively maintained within the last year. See [Community tools and Services](https://developers.eveonline.com/docs/community/).

This repository is public and EVE-related, but operators should only submit a hosted instance once it has been production-ready, publicly available for the required period, and actively maintained.

## Open-Source Safety Notice

If you are publishing a fork that previously contained private deployment files or secrets, do not make that repository public as-is. Publish from a clean sanitized export or rewrite history, rotate exposed credentials, and run a secret scan before release.

## License

MIT. See [LICENSE](./LICENSE).
