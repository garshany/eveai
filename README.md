<p align="center">
  <img src="https://img.shields.io/badge/EVE%20Online-AI%20Assistant-1a1a2e?style=for-the-badge" alt="EVE AI" />
  <img src="https://img.shields.io/badge/Telegram-Long%20Polling-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
</p>

# EVE AI Agent

Self-hosted Telegram-first AI assistant for EVE Online. It combines local EVE SDE data, live ESI data, killboard intelligence, route planning, and an OpenAI-compatible Responses API model loop with tool calling.

This repository is designed for operators to run their own instance. It does not require Redis, Postgres, queues, workers, webhooks, or a private model proxy.

## Capabilities

- Natural-language Telegram assistant for EVE Online questions and workflows.
- EVE SSO linking for private character data, with scope-aware capability gating.
- Local SDE SQLite lookups for static game data such as systems, items, dogma, blueprints, and routes.
- Live ESI access for character, corporation, market, location, mail, skills, industry, assets, and related data when scopes are granted.
- Route planning with live danger analysis, killmail context, gate-camp signals, Thera/Turnur shortcut support, and monitor mode.
- D-scan, fleet, local, OSINT, EVE-KILL, EVE-Scout, zKillboard, intel notes, and dashboard support.

## Architecture

```text
Telegram private chat
  -> grammY long polling bot
  -> agent runtime
  -> OpenAI-compatible /v1/responses endpoint
  -> ESI/SDE/EVE tools
  -> SQLite

Browser
  -> Fastify
  -> Telegram web auth + EVE SSO callback + dashboard + health
  -> same SQLite state
```

Hard constraints:

- Single-process Node.js app.
- SQLite only.
- Telegram long polling only; no webhooks.
- Fastify is limited to auth, dashboard support, frontend serving, and health.
- Static game data comes from local SDE SQLite; live data comes from ESI.
- Private ESI access is isolated per Telegram user/chat and gated by `get_eve_capabilities`.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.

## Requirements

- Node.js 20+.
- npm.
- Telegram bot token from [@BotFather](https://t.me/BotFather).
- EVE Developer application from <https://developers.eveonline.com/>.
- OpenAI API key or an OpenAI-compatible provider that supports the Responses API.

## Quick Start

```bash
git clone <your-public-fork-url> eveai
cd eveai
cp .env.example .env
npm install
npm run setup
npm run dev
```

Then open a private chat with your Telegram bot.

For local EVE SSO callbacks, set the callback URL in the EVE Developer Portal to:

```text
http://localhost:3000/auth/eve/callback
```

## Required Environment

Minimum local `.env` values:

```env
TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_RESPONSE_STATE_MODE=stateless
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
AUTH_SECRET_KEY=replace-with-random-secret
EVE_CALLBACK_URL=http://localhost:3000/auth/eve/callback
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/2.1 (+https://github.com/your-org/eveai; contact=you@example.com)
```

Generate `AUTH_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

Model state mode:

- `OPENAI_RESPONSE_STATE_MODE=stateless` is the default and is recommended for OpenAI-compatible gateways that do not retain `previous_response_id` state.
- `OPENAI_RESPONSE_STATE_MODE=server` is only for providers that support stored Responses continuation.

## Scripts

```bash
npm run build       # client (Vite) + server (tsc)
npm run dev         # concurrent watch mode
npm run check       # typecheck + tests + lint
npm test            # vitest
npm run smoke       # env, model endpoint, app health checks
npm run db:migrate  # run SQLite migrations
npm run setup       # download and load SDE data
npm start           # run built app
```

## Self-Hosting

See [docs/deployment.md](./docs/deployment.md) for a generic production deployment guide. Keep operator-specific server addresses, credentials, logs, certificates, and runbooks outside this repository.

## Documentation

- [AGENTS.md](./AGENTS.md): concise repo map and invariants.
- [ARCHITECTURE.md](./ARCHITECTURE.md): runtime boundaries and request flows.
- [docs/index.md](./docs/index.md): documentation catalog.
- [docs/SECURITY.md](./docs/SECURITY.md): security rules and current gaps.
- [docs/RELIABILITY.md](./docs/RELIABILITY.md): reliability model.
- [docs/deployment.md](./docs/deployment.md): generic self-host guide.
- [docs/generated/db-schema.md](./docs/generated/db-schema.md): SQLite schema reference.

## Open-Source Safety Notice

If you are publishing a fork that previously contained private deployment files or secrets, do not make that repository public as-is. Publish from a clean sanitized export or rewrite history, rotate exposed credentials, and run a secret scan before release.

## License

MIT. See [LICENSE](./LICENSE).
