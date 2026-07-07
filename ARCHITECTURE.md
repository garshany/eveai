# EVE Agent Architecture

## System Context

```text
Telegram private chat -> grammY bot ─┐
                                     ├─> shared chat pipeline -> agent runtime
Discord DM -> discord.js gateway bot ┘            │
                                                  v
                             native /v1/responses (official OpenAI API)
                                                  │
                                                  v
                     hosted tool_search + deferred ESI/SDE tools
                                                  │
                                                  v
                              SQLite + local SDE + EVE SSO

Browser -> Fastify -> EVE SSO callback + health -> same SQLite state
```

The app is a single-process Node.js service. There is no job queue, no event bus, no separate background worker tier, and no web frontend.

## How To Read This Repo

Start with the smallest stable entrypoint that matches the question:

- [`AGENTS.md`](./AGENTS.md) for routing, invariants, and the next document to open
- [`docs/index.md`](./docs/index.md) for the docs catalog
- [`docs/repo-map.md`](./docs/repo-map.md) for the fast file-and-domain map

The repo knowledge model is progressive disclosure: short map first, then indexed docs, then domain files.

## Runtime Boundaries

### Chat Boundary (shared)

- `src/chat/shared.ts` is the platform-neutral pipeline: chat-session rows, thread resolution, in-flight request tracking and dedupe, rate limiting, agent invocation, EVE SSO login links, and user-facing error normalization.
- `src/messaging/outbound.ts` routes user-keyed notifications to the right platform: positive chat ids go to Telegram, negative chat keys go to Discord.

### Telegram Boundary

- `src/telegram/bot.ts` creates the grammY bot and enforces private-chat usage.
- `src/telegram/handlers.ts` handles commands and hands text messages to the shared pipeline.
- `src/telegram/formatting.ts` picks the HTML parse mode; `splitForTelegram` chunks replies at 4096 chars.

### Discord Boundary

- `src/discord/bot.ts` creates the discord.js client, registers slash commands, and handles DMs, slash commands, and character-switch buttons.
- `src/discord/session.ts` maps snowflakes to internal identity: `discord_accounts` (user), `discord_sessions` (DM channel -> negative `chat_key`).
- `src/discord/format.ts` converts agent HTML output to Discord markdown and chunks replies at 2000 chars.

### Agent Boundary

- `src/agent/native-responses.ts` owns the native responses API loop against the official OpenAI endpoint.
- `src/agent/executor.ts` drives tool execution, tool audit persistence, and response continuation.
- `src/agent/planner.ts`, `replanner.ts`, and `compact.ts` handle plan state and history reduction.
- `src/agent/prompts.ts` is the model-policy boundary.
- Hosted deferred ESI surfaces are grouped into concise namespaces by use case and access boundary so `tool_search` can stay the primary discovery path without mixing unrelated public and private tools.

### Web Boundary

- `src/web/server.ts` registers HTTP concerns only: security headers, health, and the EVE SSO callback.
- `src/web/auth-routes.ts` handles the EVE OAuth callback (`/auth/eve/callback` plus the `/callback` alias) and renders a minimal success page.
- `src/web/health.ts` exposes runtime and dependency health for both bot platforms.

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

- `users` represents durable user identity across platforms.
- `telegram_accounts` maps Telegram user ids to internal users.
- `discord_accounts` maps Discord snowflakes (TEXT) to internal users.
- `telegram_sessions` stores per-chat session state for all lanes; Discord lanes use negative chat keys.
- `discord_sessions` maps Discord DM channels to negative chat keys.
- `auth_requests` stores one-time EVE SSO state tokens.

### Agent Memory

- `agent_threads` stores a thread per conversation lane, keyed by `(chat_id, character_id)`.
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

### Chat Request Flow (Telegram or Discord)

1. User sends a message in a Telegram private chat or a Discord DM.
2. Platform middleware validates access (private-chat/DM only, optional allowlist).
3. The handler resolves user identity and the chat lane (Discord DMs map to a negative chat key), applies rate limits and in-flight dedupe.
4. The agent runtime chooses a warm or cold context path: it reuses a fresh `last_response_id` as `previous_response_id` for warm turns (server state mode), or rebuilds context from SQLite history for cold starts.
5. When a linked character has fresh private location access, the developer prompt also carries current live location context resolved as system plus constellation and region via local SDE.
6. The model uses hosted `tool_search` to discover/load deferred tools when endpoint selection is unclear or the needed namespace is not yet loaded, then reuses the loaded tools directly instead of repeating discovery.
7. Tool calls and final messages are written back to SQLite.
8. The reply is formatted per platform: Telegram HTML (4096-char chunks) or Discord markdown (2000-char chunks).

### EVE SSO Linking Flow

1. User runs `/eve_login` in either bot.
2. The bot stores a one-time hashed state token (`auth_requests`) bound to the user and chat lane, and sends the EVE SSO authorize URL.
3. EVE redirects the browser to `GET /auth/eve/callback` with code and state.
4. The callback validates the state, exchanges the code, verifies the JWT, stores encrypted tokens in `eve_accounts`, and links the character to the originating user and chat lane.
5. The browser shows a minimal success page; the user returns to the chat.

### Outbound Notification Flow

1. Producers (heartbeat worker, route monitor, kill watch) address a chat id.
2. `sendOutbound` routes by sign: positive -> Telegram `sendMessage`, negative -> Discord DM channel resolved via `discord_sessions`.
3. Failures are logged and never crash the producer.

## Package Map

- `src/agent/`: model runtime and tool orchestration
- `src/auth/`: auth state and user resolution
- `src/chat/`: shared platform-neutral chat pipeline
- `src/db/`: schema and migrations
- `src/discord/`: Discord bot, sessions, formatting
- `src/eve/`: EVE integrations and domain logic
- `src/messaging/`: outbound platform-routing dispatcher
- `src/telegram/`: Telegram bot and command handlers
- `src/web/`: Fastify SSO callback + health
- `tests/unit/`: module and policy regression coverage
- `tests/integration/`: auth and Telegram seam coverage
- `deploy/systemd/`: generic self-host service examples

## Knowledge Map

- Docs catalog: [docs/index.md](./docs/index.md)
- File-and-domain map: [docs/repo-map.md](./docs/repo-map.md)
- Product and UX intent: [docs/PRODUCT_SENSE.md](./docs/PRODUCT_SENSE.md)
- Design constraints: [docs/DESIGN.md](./docs/DESIGN.md)
- DB inventory: [docs/generated/db-schema.md](./docs/generated/db-schema.md)
- Reliability and security posture: [docs/RELIABILITY.md](./docs/RELIABILITY.md), [docs/SECURITY.md](./docs/SECURITY.md)
