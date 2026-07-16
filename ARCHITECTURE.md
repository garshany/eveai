# EVE Agent Architecture

## System Context

```text
Telegram private chat -> grammY bot ─┐
                                     ├─> shared chat pipeline -> agent runtime
Discord DM -> discord.js gateway bot ┤            │
Terminal CLI -> local chat_id 0 ─────┤            │
Browser /app -> Fastify session API ─┘            │
                                                  v
                       selected Responses transport (OpenAI or CheapVibeCode)
                                                  │
                                                  v
             tool_search + deferred local ESI/SDE/EVE-KILL tools
                                                  │
                                                  v
                    SQLite + local SDE + EVE SSO + EVE-KILL REST/feed
                                                  │
                                                  v
          local validated analytics wrapper -> fixed EVE-KILL MCP endpoint

Browser -> Fastify -> opaque session + EVE SSO + health -> same SQLite state
```

The app is a single-process Node.js service. The bot entrypoint and interactive
CLI acquire the same DB-adjacent ownership lock, so exactly one process owns the
SQLite feed cursor for a `DB_PATH`. There is no job queue, event bus, separate
background worker tier, or external state store. The optional web frontend is
built into and served by the same Fastify process.

## How To Read This Repo

Start with the smallest stable entrypoint that matches the question:

- [`AGENTS.md`](./AGENTS.md) for routing, invariants, and the next document to open
- [`docs/index.md`](./docs/index.md) for the docs catalog
- [`docs/repo-map.md`](./docs/repo-map.md) for the fast file-and-domain map

The repo knowledge model is progressive disclosure: short map first, then indexed docs, then domain files.

## Runtime Boundaries

### Chat Boundary (shared)

- `src/chat/shared.ts` is the platform-neutral pipeline: chat-session rows, thread resolution, in-flight request tracking and dedupe, rate limiting, agent invocation, EVE SSO login links, and user-facing error normalization.
- `src/messaging/outbound.ts` routes push notifications by the established platform lane contract; browser chat is request/response only.

### Terminal CLI Boundary

- `src/cli/chat.ts` owns the local `chat_id = 0` identity, readline loop, feed lifecycle, and graceful shutdown.
- `src/cli/async-output.ts` serializes background alerts with spinner/readline output and redraws an idle prompt without losing buffered input.
- The CLI exposes feed-backed route monitoring and EVE-KILL watches while open; heartbeat remains a bot-service scheduler.

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
- Full mode adds a local deferred `eve_kill_analytics` namespace with four application-owned function tools. The app validates public numeric IDs, dates, enums, and limits before it sends a fixed JSON-RPC call to EVE-KILL MCP. Aggregate-only mode adds none; MCP output is untrusted third-party data and rejected arguments are audited by field name only.

### Web Boundary

- `src/web/server.ts` registers security headers, health, EVE SSO, the browser session/chat API, and built React assets when explicitly enabled.
- `src/web/web-session.ts` owns opaque hashed sessions, CSRF, browser chat-lane allocation, expiry, and anonymous-session admission.
- `src/web/chat-routes.ts` owns session-bound history, character switching, and the adapter into the shared agent loop.
- `src/web/auth-routes.ts` validates one-time EVE SSO state and returns browser logins to `/app` without exposing tokens.
- `src/web/health.ts` exposes runtime and dependency health for both bot platforms.

### Project Update Boundary

- `src/update/` reads the installed package version and checks only the fixed canonical GitHub latest-release endpoint.
- `/version` and `/update` are deterministic platform commands, not agent tools. They use a bounded, cached request and never render release body text.
- A running CLI or bot never mutates Git, installs packages, invokes a service manager, or restarts itself; activation remains an operator deployment action.

### EVE Boundary

- `src/eve/esi-client.ts` is the only native ESI transport layer.
- `src/eve/sso.ts` and `src/eve/sso-auth.ts` own token refresh and JWT verification.
- `src/eve/capabilities.ts` computes scope-aware access for private ESI.
- `src/eve/sde.ts`, `sde-loader.ts`, and `sde-downloader.ts` own static data ingestion and lookup.
- `src/eve/route-planner.ts` and `killmail.ts` provide higher-level route and official killmail features.
- `src/eve-kill/client.ts` owns the fixed current EVE-KILL REST boundary; `mcp-analytics.ts` owns the fixed public analytics JSON-RPC boundary; `feed-poll.ts` owns one durable global feed cursor.
- `src/eve-board/route-snapshot.ts` builds the shared route kill baseline; `monitor.ts` consumes the global feed after that baseline.
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
- `web_sessions` maps hashed browser cookies to isolated users and reserved negative chat keys.
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
- `eve_kill_feed_state` stores the one global EVE-KILL sequence cursor.
- `eve_kill_notification_dedup` stores accepted per-chat killmail deliveries for at-least-once retry handling.
- `kill_watches`, `route_monitors`, `route_monitor_kill_dedup`, and `route_ganker_cache` store public feed subscriptions, restart-safe per-monitor event idempotency, and route-monitor state.

### Static Game Data

- `sde_*` tables store the local normalized SDE index.
- `sde_raw_records` stores dataset-level raw JSON payloads for generic lookup.

## Request Flows

### Chat Request Flow (Browser, Telegram, Discord, or CLI)

1. A user sends a message from one enabled adapter.
2. The adapter validates its boundary: private-chat/DM policy, local CLI identity, or opaque browser session plus same-origin CSRF.
3. The handler resolves the user and disjoint chat lane, then applies shared actor rate limits, in-flight dedupe, and global concurrency.
4. The agent runtime rebuilds each top-level turn from SQLite history. During a tool turn it replays the preceding `function_call` item with its matching `function_call_output`; provider-retained response state is not used.
5. When a linked character has fresh private location access, the developer prompt also carries current live location context resolved as system plus constellation and region via local SDE.
6. The model uses hosted `tool_search` to discover/load deferred tools when endpoint selection is unclear or the needed namespace is not yet loaded, then reuses the loaded tools directly instead of repeating discovery.
7. Tool calls and final messages are written back to SQLite.
8. The reply is formatted per platform: Telegram HTML, Discord markdown, terminal text, or safe browser Markdown elements.

### EVE SSO Linking Flow

1. User runs `/eve_login` in either bot.
2. The bot stores a one-time hashed state token (`auth_requests`) bound to the user and chat lane, and sends the EVE SSO authorize URL.
3. EVE redirects the browser to `GET /auth/eve/callback` with code and state.
4. The callback validates the state, exchanges the code, verifies the JWT, stores encrypted tokens in `eve_accounts`, and links the character to the originating user and chat lane.
5. The browser shows a minimal success page; the user returns to the chat.

### Outbound Notification Flow

1. Producers (heartbeat worker, route monitor, kill watch) address a chat id.
2. `deliverOutbound` routes explicitly: zero -> prompt-aware CLI output, positive -> Telegram `sendMessage`, negative -> Discord DM channel resolved via `discord_sessions`.
3. Durable producers await delivery before advancing cursors or heartbeat state. Failures propagate to their retry boundary; `sendOutbound` remains only the explicitly best-effort wrapper.

### EVE-KILL Feed And Route Flow

1. On a new database, the global poller persists the current `/feed/poll` head without replaying history.
2. Its readiness hook restores route listeners before the first later event; an existing cursor restores listeners before the first resumed poll.
3. A watch event advances the feed cursor only after all active listeners and unmatched-dedup sends for active chat platforms complete; disabled-platform consumers remain stored but suspended.
4. Route planning builds one one-hour EVE-KILL baseline. A temporary listener captures events during the scan and hands them, plus that exact baseline, to the monitor after autopilot succeeds.
5. The monitor serializes feed callbacks and atomically records a per-monitor-run killmail marker with ganker/stats updates, so concurrent and post-restart replay is idempotent. ESI owns live/private state and official `(id, hash)` details; SDE owns static names/topology; EVE-KILL owns public discovery and value/fitting enrichment.

## Package Map

- `src/agent/`: model runtime and tool orchestration
- `src/auth/`: auth state and user resolution
- `src/chat/`: shared platform-neutral chat pipeline
- `src/db/`: schema and migrations
- `src/discord/`: Discord bot, sessions, formatting
- `src/eve/`: EVE integrations and domain logic
- `src/eve-kill/`: current public EVE-KILL REST, feed, tools, and watches
- `src/eve-board/`: route threat snapshot, deterministic analysis, briefing, and monitor
- `src/messaging/`: outbound platform-routing dispatcher
- `src/cli/`: interactive terminal adapter and prompt-safe background output
- `src/runtime/`: single-process DB ownership
- `src/update/`: bounded read-only canonical release discovery
- `src/telegram/`: Telegram bot and command handlers
- `src/web/`: Fastify browser sessions/chat, EVE SSO, static app serving, and health
- `web/`: React/Vite same-origin browser client
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
