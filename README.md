# EVE Agent

Single-process multi-user EVE Online agent with Telegram as the main interface, native ESI access, local SDE, SQLite persistence, and an OpenAI-compatible runtime over `codex-proxy` `responses`.

## Stack

- Node.js + TypeScript
- grammY long polling for Telegram
- Fastify for auth callback, web auth, dashboard, and health
- better-sqlite3 for all persistence
- Native ESI client generated from the live swagger catalog
- Local SDE index in SQLite
- EVE SSO via `jose`
- Native `responses` runtime through `codex-openai-proxy`

## Features

- Telegram bot with isolated per-user/per-chat state
- EVE SSO linking and multi-character management
- Scope-aware private ESI access via `get_eve_capabilities`
- Local web dashboard for login and character switching
- SQLite-backed message history, plans, summaries, auth state, and caches
- Route planning, market access, zKill integration, and SDE-backed lookups
- Readiness `/health` with dependency checks
- `npm run smoke` for local runtime verification

## Requirements

- Node.js 20+
- npm
- A Telegram bot token
- EVE SSO application credentials
- Local access to `codex-openai-proxy`

## Environment

Start from `.env.example`:

```bash
cp .env.example .env
```

Required values:

- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`
- `EVE_CLIENT_ID`
- `EVE_CLIENT_SECRET`
- `AUTH_SECRET_KEY` for production
- `DEFAULT_MARKET_REGION_ID`
- `DEFAULT_MARKET_REGION_NAME`

Important local defaults:

- `OPENAI_BASE_URL=http://localhost:8088/v1`
- `WEB_BASE_URL=http://localhost:8000` or your chosen local port

## Local Run

Start the proxy first:

```bash
cd /home/antipedik/codex_proxy_v2
cargo run -- --port 8088 --auth-path ~/.codex/auth.json
```

Then start the app:

```bash
cd /home/antipedik/eveai
npm install
npm run dev
```

Production-style local run:

```bash
npm run build
npm start
```

## Checks

Static and test checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Local smoke check:

```bash
npm run smoke
```

This verifies:

- required env vars
- local proxy `/health`
- local proxy `/v1/models`
- application `/health`

## Health

`GET /health` returns bot state plus dependency checks for:

- SQLite
- built client manifest
- local `codex-proxy` health when `OPENAI_BASE_URL` points to a local proxy

## Main Commands

Telegram:

- `/start`
- `/help`
- `/eve_login`
- `/whoami`
- `/characters`
- `/use <id|name>`
- `/market <type_id>`
- `/info <target_id>`
- `/clear`
- `/reset`
- `/web`

## Repo Layout

- `src/agent` agent runtime, prompts, tool loop, compaction
- `src/auth` web session, Telegram login, auth request, secret storage
- `src/eve` ESI, SSO, SDE, route planning, zKill, user profile
- `src/telegram` bot bootstrap and handlers
- `src/web` Fastify routes, dashboard, middleware, health, security
- `client/src` web dashboard frontend
- `tests` unit and integration tests
- `deploy/systemd` example service units

## Notes

- No Redis
- No Postgres
- No Telegram webhooks
- No shell access from model-facing tools
- Private ESI is backend-enforced and requires a fresh capability handshake
