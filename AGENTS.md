# EVE Agent

## Goal

Build and maintain a multi-user EVE Online agent with:

- Telegram input via grammY long polling
- EVE SSO for private data access
- Native ESI access through generated endpoint tools
- Local SDE index in SQLite from JSON Lines
- Fastify only for auth callback and health endpoints
- OpenAI-driven agent runtime over native codex-proxy `responses`

## Hard rules

- No Redis
- No Postgres
- No image features
- No raw shell access from model-facing code
- No Telegram webhooks
- All user state, auth state, plans, threads, and private ESI access must remain isolated per Telegram user/chat
- All private ESI access must check permissions through `get_eve_capabilities` first when access is not already known
- Model never sees tokens, refresh logic, pagination internals, or rate-limit handling
- Keep the codebase single-process and simple
- TypeScript strict mode everywhere

## Stack

| Component | Library / Tool | Purpose |
| --- | --- | --- |
| Runtime | Node.js + TypeScript | Main platform |
| Telegram | grammY | Bot framework, long polling |
| HTTP server | Fastify | EVE SSO callback + `/health` |
| Database | better-sqlite3 | All persistence |
| ESI catalog | Live ESI swagger + local cache | Generated endpoint tool metadata |
| Auth/JWT | jose | EVE SSO JWT verification |
| AI model | Native codex-proxy `/v1/responses` | Hosted `tool_search`, tool loop, reasoning |

## Architecture overview

```text
Telegram user
   |
grammY bot (long polling)
   |
Agent runtime (native responses loop -> hosted tool_search -> deferred tools -> finalizer)
   |
tools: tool_search | get_eve_capabilities | web_search | update_plan | deferred ESI ops | deferred SDE tools
   |
infra: EVE SSO | native ESI client | SQLite | local SDE index
```

Single process. No workers. No queues. No event bus.

## Model-facing tools

Always-on:

1. `tool_search`
2. `get_eve_capabilities`
3. `web_search`
4. `update_plan`

Deferred:

- One tool per ESI `operationId`
- SDE namespace tools for types, universe, dogma, and dataset lookup

## Agent runtime

- Native `/v1/responses` only
- Hosted `tool_search`
- Parallel tool calls for read-only batches
- Stores user/assistant messages plus tool audit messages in SQLite
- Uses thread summaries for compaction
- Refreshes `USER.md`-style user profile data in the background when needed
- Uses backend web search when non-ESI background information is needed

## Local runbook

Deployment и production SSH/runbook описаны отдельно:

- [docs/deployment.md](./docs/deployment.md)

- `codex proxy 2` for this project lives in `/home/antipedik/codex_proxy_v2`
- The binary name is `codex-openai-proxy`
- CLI flags:
  - `--port` sets the listen port
  - `--auth-path` accepts either a single `auth.json` file or a directory with auth `*.json` files
  - `--openai-api-key` is only needed for fallback routing of unsupported tools such as `image_generation` and `code_interpreter`
- The proxy exposes:
  - `POST /v1/responses`
  - `POST /v1/responses/compact`
  - `GET /v1/models`
  - `GET /health`
- The proxy listens on `0.0.0.0`, but this app should target it via `OPENAI_BASE_URL=http://localhost:8088/v1`
- Start proxy 2 first:

```bash
cd /home/antipedik/codex_proxy_v2
cargo run -- --port 8088 --auth-path ~/.codex/auth.json
```

- Then start this app from repo root:

```bash
cd /home/antipedik/eveai
npm run dev
```

- Health check for the proxy:

```bash
curl http://localhost:8088/health
```

## SQLite tables

Core tables:

- `telegram_sessions`
- `agent_threads`
- `messages`
- `thread_summaries`
- `plans`
- `plan_steps`
- `esi_cache`

Auth tables:

- `eve_accounts`
- `eve_character_links`

SDE tables:

- `sde_meta`
- `sde_raw_records`
- `sde_types`
- `sde_groups`
- `sde_categories`
- `sde_market_groups`
- `sde_meta_groups`
- `sde_dogma_attributes`
- `sde_dogma_units`
- `sde_dogma_effects`
- `sde_type_dogma`
- `sde_type_bonus`
- `sde_type_materials`
- `sde_certificates`
- `sde_masteries`
- `sde_factions`
- `sde_races`
- `sde_regions`
- `sde_constellations`
- `sde_systems`
- `sde_stations`
- `sde_npc_corporations`
- `sde_stargates`
- `sde_blueprints`

## HTTP routes

- `GET /auth/eve/start`
- `GET /auth/eve/callback`
- `GET /callback`
- `GET /health`

## Telegram commands

- `/start`
- `/help`
- `/commands`
- `/eve_login`
- `/eve-login`
- `/whoami`
- `/characters`
- `/chars`
- `/use <id|name>`
- `/market <type_id>`
- `/info <target_id>`
- `/clear`
- `/reset`

## What we do NOT build

- Telegram webhooks
- Multi-user support
- Admin panel
- Image features
- Separate frontend
- Background jobs or workers
- Redis/Postgres infrastructure
- Direct model access to shell or secrets
