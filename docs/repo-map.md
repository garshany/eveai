# Repo Map

Status: active
Verified against code: 2026-07-06

This file is the fast file-and-domain map for the repository.

Use it when you need to find the right file or folder before reading implementation details.

## Root Entry Points

- `AGENTS.md`: shortest map plus invariants and deep links
- `ARCHITECTURE.md`: system shape and request flows
- `README.md`: public-facing project overview
- `package.json`: scripts, package metadata, dependency surface
- `src/app.ts`: runtime bootstrap
- `src/config.ts`: env/config boundary
- `src/smoke.ts`: smoke-check entrypoint

## Runtime Domains

### `src/agent/`

- `native-responses.ts`: official OpenAI Responses API loop, including SSE function-call reconstruction from `response.function_call_arguments.done`
- `executor.ts`: tool execution, continuation, persistence
- `planner.ts` / `replanner.ts`: plan generation and adjustment
- `compact.ts`: history reduction and compaction
- `prompts.ts`: prompt-policy boundary
- `finalizer.ts`: response shaping and final output path
- `tools.ts`: model-visible tool schema surface
- `market-context.ts`, `model.ts`: supporting runtime context

### `src/auth/`

- `auth-request.ts`: one-time EVE SSO state token storage
- `user-resolver.ts`: user/chat identity resolution (Telegram + Discord + outbound chat lookup)
- `secret-storage.ts`: encrypted secret persistence

### `src/chat/`

- `shared.ts`: platform-neutral chat pipeline — session rows, thread resolution, in-flight dedupe, rate limiting, agent turn, error normalization

### `src/messaging/`

- `outbound.ts`: platform-routing notification dispatcher (positive chat id -> Telegram, negative -> Discord)

### `src/db/`

- `schema.ts`: SQLite source of truth
- `migrations.ts`: in-place schema upgrades
- `sqlite.ts`: DB open/setup helpers
- `diagnose-links.ts`: identity-link diagnostics

### `src/eve/`

- `esi-client.ts`: native ESI transport and caching
- `esi-catalog.ts`: operation catalog derived from ESI spec
- `sso.ts` / `sso-auth.ts`: token refresh and JWT verification
- `capabilities.ts`: scope-aware private-access gating
- `sde.ts`, `sde-loader.ts`, `sde-downloader.ts`: static data ingestion and lookup
- `route-planner.ts`, `killmail.ts`: higher-level EVE features
- `user-profile.ts`: generated user snapshot/profile flow
- `scopes.ts`, `eve-links.ts`, `http.ts`: support modules

### `src/eve-osint/`

- `inference.ts`: activity collection, graph digest, deterministic scoring, optional LLM pattern pass
- `llm.ts`: compact graph-digest LLM interpretation with deterministic fallback
- `types.ts`: OSINT tool-facing argument/result types

### `src/eve-kill/`

PvP killboard integration (EVE-KILL, replaces zKillboard). See `docs/eve-kill.md`.

- `client.ts`: HTTP client with caching (getKilllist, getKillmail, etc.)
- `tools.ts`: 8 deferred tools in `eve_kill` namespace
- `executor.ts`: tool call router
- `feed.ts`: kill_feed handler (recent kills via /api/killlist)
- `kill-query.ts`: kill_query handler (MongoDB-style, pending API deployment)
- `intel.ts`: kill_stats/battles/entity/lookup/spatial/prices handlers
- `query.ts`: MongoDB filter builder and sanitizer
- `types.ts`: shared TypeScript types
- `zkb-ws.ts`: zKillboard R2Z2 poller for real-time kill alerts

### `src/telegram/`

- `bot.ts`: grammY bot bootstrap
- `handlers.ts`: commands and agent entrypoint (delegates to `src/chat/shared.ts`)
- `access.ts`: Telegram access checks
- `formatting.ts`: HTML parse-mode detection

### `src/discord/`

- `bot.ts`: discord.js client, slash commands, DM message handling
- `session.ts`: snowflake identity mapping and negative chat-key allocation
- `format.ts`: HTML -> Discord markdown conversion and 2000-char chunking

### `src/web/`

- `server.ts`: Fastify server assembly (SSO login redirect/callback + health only)
- `auth-routes.ts`: one-time EVE SSO login redirect, OAuth callback, and `/callback` alias
- `health.ts`: runtime/dependency health endpoint for both bot platforms
- `security.ts`: security headers

## Tests

- `tests/unit/`: module rules and regressions by boundary
- `tests/integration/`: auth and Telegram seam tests
- `vitest.config.ts`: test runner config

## Deployment And Operations

- `deploy/systemd/eveai.service`: generic self-host systemd unit
- `scripts/export-public.sh`: clean public export helper that excludes local/private state
- `docs/deployment.md`: generic self-host deployment guide
- `docs/open-source-release.md`: public release/history-safety checklist
- `data/`: local DBs, SDE inputs, cached swagger, generated user snapshots

## Repo-Local Knowledge

- `docs/index.md`: docs catalog and reading order
- `docs/design-docs/`: durable architectural beliefs
- `docs/product-specs/`: product-facing contracts
- `docs/exec-plans/`: active plans, completed plans, tech debt
- `docs/generated/`: generated inventories
- `docs/references/`: source links and reference notes for external systems

## Local Agent Extensions

- `skills/eve-esi/SKILL.md`: ESI workflow skill
- `skills/eve-planning/SKILL.md`: planning workflow skill
- `skills/eve-sde/SKILL.md`: SDE workflow skill
- `docs/skills-protocol.md`: local development notes for optional skill-style tool workflows
- `.agent/tasks/`: repo-task-proof-loop task artifacts

## Read This Next

- Need system shape -> [../ARCHITECTURE.md](../ARCHITECTURE.md)
- Need docs catalog -> [index.md](./index.md)
- Need product intent -> [PRODUCT_SENSE.md](./PRODUCT_SENSE.md)
- Need operational rules -> [RELIABILITY.md](./RELIABILITY.md), [SECURITY.md](./SECURITY.md), [deployment.md](./deployment.md)
- Need OSINT behavior -> [osint.md](./osint.md)
