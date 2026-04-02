# EVE Agent Architecture

## System Context

```text
Telegram private chat
  -> grammY bot
  -> agent runtime
  -> native /v1/responses
  -> hosted tool_search + deferred ESI/SDE tools
  -> SQLite + local SDE + EVE SSO

Browser
  -> Fastify
  -> Telegram web auth + EVE SSO callback + dashboard API + health
  -> same SQLite state
```

The app is a single-process Node.js service. There is no job queue, no event bus, and no separate background worker tier.

## How To Read This Repo

Start with the smallest stable entrypoint that matches the question:

- [`AGENTS.md`](./AGENTS.md) for routing, invariants, and the next document to open
- [`docs/index.md`](./docs/index.md) for the docs catalog
- [`docs/repo-map.md`](./docs/repo-map.md) for the fast file-and-domain map

The repo knowledge model is progressive disclosure: short map first, then indexed docs, then domain files.

## Runtime Boundaries

### Telegram Boundary

- `src/telegram/bot.ts` creates the grammY bot and enforces private-chat usage.
- `src/telegram/handlers.ts` handles commands, request dedupe, thread reset, and agent handoff.

### Agent Boundary

- `src/agent/native-responses.ts` owns the native responses API loop.
- `src/agent/executor.ts` drives tool execution, tool audit persistence, and response continuation.
- `src/agent/planner.ts`, `replanner.ts`, and `compact.ts` handle plan state and history reduction.
- `src/agent/prompts.ts` is the model-policy boundary.
- Hosted deferred ESI surfaces are grouped into concise namespaces by use case and access boundary so `tool_search` can stay the primary discovery path without mixing unrelated public and private tools.

### Web Boundary

- `src/web/server.ts` registers HTTP concerns only.
- `src/web/auth-routes.ts` handles Telegram login, EVE callback, logout, and bot-to-web handoff.
- `src/web/api-routes.ts` exposes authenticated dashboard APIs.
- `src/web/frontend.ts` serves the built Vite client and HTML shell.
- `src/web/health.ts` exposes runtime and dependency health.

### EVE Boundary

- `src/eve/esi-client.ts` is the only native ESI transport layer.
- `src/eve/sso.ts` and `src/eve/sso-auth.ts` own token refresh and JWT verification.
- `src/eve/capabilities.ts` computes scope-aware access for private ESI.
- `src/eve/sde.ts`, `sde-loader.ts`, and `sde-downloader.ts` own static data ingestion and lookup.
- `src/eve/route-planner.ts`, `zkill.ts`, and `killmail.ts` provide higher-level EVE features.
- `src/eve-osint/inference.ts` builds residence/staging hypotheses from kill activity, SDE geography, and an optional compact LLM pattern pass.

### Persistence Boundary

- `src/db/schema.ts` is the source of truth for SQLite tables.
- `src/db/migrations.ts` upgrades local DB state in place.
- `src/db/sqlite.ts` owns DB setup.

## State Model

### Identity and Session

- `users` and `telegram_accounts` represent durable user identity.
- `web_sessions` stores browser sessions.
- `telegram_sessions` stores per-chat session state and backward-compatible auth state.
- `auth_requests` and `telegram_login_attempts` store one-time auth state.

### Agent Memory

- `agent_threads` stores a thread per conversation lane.
- `messages` stores user, assistant, and tool audit messages.
- `thread_summaries` stores compaction snapshots.
- `thread_artifacts` stores durable thread-side artifacts.
- `plans` and `plan_steps` store multi-step execution plans.

### EVE State

- `eve_accounts` stores encrypted token material and granted scopes.
- `eve_character_links` binds characters to user/chat ownership.
- `esi_cache` stores GET cache entries with revalidation metadata.

### Static Game Data

- `sde_*` tables store the local normalized SDE index.
- `sde_raw_records` stores dataset-level raw JSON payloads for generic lookup.

## Request Flows

### Telegram Request Flow

1. User sends a message in a private chat.
2. grammY middleware validates access and session context.
3. The handler resolves user/chat identity and active character.
4. The agent runtime chooses a warm or cold context path: it reuses a fresh `last_response_id` as `previous_response_id` for warm turns, or rebuilds context from SQLite history for cold starts.
5. When a linked character has fresh private location access, the developer prompt also carries current live location context resolved as system plus constellation and region via local SDE.
6. The model uses hosted `tool_search` to discover/load deferred tools when endpoint selection is unclear or the needed namespace is not yet loaded, then reuses the loaded tools directly instead of repeating discovery.
7. Tool calls and final messages are written back to SQLite.

### Web Auth Flow

1. Browser authenticates with Telegram login widget.
2. Fastify verifies Telegram login data and sets `web_sessions`.
3. Authenticated user starts EVE SSO from `/auth/eve/start`.
4. Callback stores encrypted tokens in `eve_accounts`.
5. Character ownership is linked back to the same user/chat graph.

## Package Map

- `src/agent/`: model runtime and tool orchestration
- `src/auth/`: auth state and user resolution
- `src/db/`: schema and migrations
- `src/eve/`: EVE integrations and domain logic
- `src/telegram/`: bot commands and message entrypoint
- `src/web/`: Fastify routes and browser shell
- `client/src/`: React landing page and dashboard
- `tests/unit/`: module and policy regression coverage
- `tests/integration/`: auth and Telegram seam coverage
- `deploy/systemd/`: production service units

## Knowledge Map

- Docs catalog: [docs/index.md](./docs/index.md)
- File-and-domain map: [docs/repo-map.md](./docs/repo-map.md)
- Product and UX intent: [docs/PRODUCT_SENSE.md](./docs/PRODUCT_SENSE.md)
- Design constraints: [docs/DESIGN.md](./docs/DESIGN.md)
- Frontend behavior: [docs/FRONTEND.md](./docs/FRONTEND.md)
- DB inventory: [docs/generated/db-schema.md](./docs/generated/db-schema.md)
- Reliability and security posture: [docs/RELIABILITY.md](./docs/RELIABILITY.md), [docs/SECURITY.md](./docs/SECURITY.md)
