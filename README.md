# EVE Agent

EVE Agent is a multi-user EVE Online assistant built around Telegram, EVE SSO, native ESI access, and a local SQLite-backed knowledge/runtime layer.

It is designed for one thing: let players ask normal questions in Telegram and get useful answers backed by live EVE data, local static data, and strict access boundaries for private character information.

## What It Does

- Runs a Telegram bot as the primary interface
- Links EVE characters through official EVE SSO
- Uses live ESI for character, market, route, and other online data
- Uses local SDE data in SQLite for static game knowledge
- Keeps private ESI access scoped to the active Telegram user and chat
- Exposes a small web surface for login, auth callback, dashboard support, and health

## Why This Repo Exists

Most EVE tools expose APIs, tables, IDs, and forms. This project instead treats natural-language interaction as the main UX:

- Telegram is the product surface
- web is support infrastructure, not a separate app
- the model can ask for capabilities and data
- the backend owns tokens, retries, caching, pagination, and secret handling

That split is the core design rule of the repo.

## Architecture At A Glance

```text
Telegram private chat
  -> grammY bot
  -> agent runtime
  -> OpenAI-compatible /v1/responses backend
  -> ESI + SDE tools
  -> SQLite state

Browser
  -> Fastify
  -> Telegram web auth + EVE callback + dashboard + health
  -> same SQLite state
```

Hard constraints:

- single-process Node.js app
- no Redis, Postgres, workers, or queues
- Telegram uses grammY long polling only
- Fastify is limited to auth, dashboard support, and health
- model-facing code never gets raw secrets, refresh flow details, or pagination internals

## Main Features

- Multi-user Telegram assistant with persistent chat state
- EVE SSO linking and multi-character management
- Scope-aware private ESI access through `get_eve_capabilities`
- Native ESI transport with cache revalidation, bounded retries, and guarded pagination
- Local SDE-backed lookups for static game data
- Web login flow and lightweight dashboard support
- Health endpoint and smoke checks for runtime verification

## Stack

- Node.js 20+
- TypeScript
- grammY
- Fastify
- better-sqlite3
- React + Vite
- `jose` for EVE JWT verification
- OpenAI-compatible `responses` runtime

## Repository Map

- `src/agent/` model runtime, prompts, planning, execution, compaction
- `src/auth/` Telegram login, handoff, sessions, user resolution, secret storage
- `src/db/` SQLite schema, migrations, helpers
- `src/eve/` ESI, SSO, SDE, market, routes, zKill, user profile logic
- `src/telegram/` bot setup and command handlers
- `src/web/` Fastify routes, frontend shell, middleware, health
- `client/src/` landing page and dashboard UI
- `tests/unit/` module and regression coverage
- `tests/integration/` auth and flow seam coverage
- `docs/` architecture, product, security, reliability, deployment docs

## Local Setup

1. Clone the repo.
2. Copy env file.
3. Install dependencies.
4. Build or run in dev mode.

```bash
cp .env.example .env
npm install
npm run dev
```

Production-style local run:

```bash
npm run build
npm start
```

## Required Environment

Minimum required values:

- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`
- `EVE_CLIENT_ID`
- `EVE_CLIENT_SECRET`
- `DEFAULT_MARKET_REGION_ID`
- `DEFAULT_MARKET_REGION_NAME`

Important runtime values:

- `AUTH_SECRET_KEY` for production
- `OPENAI_BASE_URL` for your OpenAI-compatible backend
- `WEB_BASE_URL`
- `EVE_CALLBACK_URL`
- `ESI_USER_AGENT`
- `ZKILL_USER_AGENT`

## Typical Development Commands

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm test
npm run smoke
```

`npm run smoke` verifies env, proxy health, available models, and app health.

## EVE Integration Rules

- Private ESI access must be gated by `get_eve_capabilities`
- ESI requests send `User-Agent` and `X-Compatibility-Date`
- Cached GETs revalidate with `ETag` / `If-None-Match`
- Retries are bounded for `420`, `429`, and transient `5xx`
- `X-Pages` collections fail closed instead of silently truncating data
- JWT validation checks issuer, audience, and `CHARACTER:EVE:<id>` subject format

## Health And Operations

App health:

```bash
curl http://127.0.0.1:8000/health
```

Production runbook:

- [`docs/deployment.md`](./docs/deployment.md)

Core reference docs:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/PRODUCT_SENSE.md`](./docs/PRODUCT_SENSE.md)
- [`docs/RELIABILITY.md`](./docs/RELIABILITY.md)
- [`docs/SECURITY.md`](./docs/SECURITY.md)

## Status

`v1.0.0` is the first public release line of the current architecture: Telegram-first, single-process, ESI-backed, SQLite-backed, with explicit auth and transport boundaries.
