# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # Compile server (tsc)
npm run dev                # tsx watch mode
npm start                  # Production: node dist/app.js
npm run check              # Full local pipeline: typecheck + test + lint
npm run typecheck          # tsc --noEmit
npm test                   # vitest run (all tests)
npm run test:watch         # vitest watch mode
npx vitest run tests/unit/planner.test.ts   # Run a single test file
npx vitest run -t "test name pattern"       # Run tests matching a name
npm run lint               # eslint src/ --max-warnings 0
npm run lint:fix           # eslint auto-fix
npm run smoke              # Smoke tests: env, model endpoint, app health
npm run smoke:openai       # Authenticated /v1/responses probe
npm run smoke:eve-tool     # Model + SDE tool probe (EVE_TOOL_SMOKE_MODE=direct = DB-only, no model call)
npm run db:migrate         # Run SQLite migrations
npm run setup              # Download + load SDE data (required before first run)
```

CI (`.github/workflows/ci.yml`) runs build + typecheck + tests + lint. Tests are hermetic: `tests/setup.ts` provides env defaults and seeds the ESI swagger fixture, so the suite passes on a clean clone without a `.env`.

## Architecture

Single-process Node.js app (ES modules, TypeScript strict). The Telegram and Discord bots are the product surface; the web layer is limited to the EVE SSO login redirect/callback plus health. There is no web frontend.

```
Telegram private chat → grammY bot (long polling) ─┐
Discord DM → discord.js gateway bot ───────────────┴→ shared chat pipeline → agent runtime → official OpenAI /v1/responses → ESI + SDE tools → SQLite
Browser → Fastify → EVE SSO login redirect/callback + health → same SQLite
```

**Entry point:** `src/app.ts` boots DB, runs migrations, starts Fastify server, starts whichever bots have tokens (at least one required), registers graceful shutdown, and prints a startup status banner.

**Domain boundaries:**
- `src/agent/` — model runtime: responses loop (`native-responses.ts`), tool execution (`executor.ts`), planning, compaction, prompts. Top-level turns rebuild context from SQLite history; tool continuations replay the preceding `function_call` and its output without provider-retained state.
- `src/auth/` — EVE SSO state tokens, user resolution (Telegram + Discord), encrypted secret storage
- `src/chat/` — shared platform-neutral pipeline: session rows, thread resolution, in-flight dedupe, rate limiting, agent turn, error normalization
- `src/db/` — SQLite schema (`schema.ts` is source of truth), migrations, helpers
- `src/discord/` — discord.js bot, slash commands, snowflake identity (TEXT ids, negative chat keys), HTML→markdown formatting
- `src/eve/` — ESI client (`esi-client.ts` is the only ESI transport), SSO token refresh, SDE lookups, capabilities gating, route planner
- `src/eve-kill/` — EVE-KILL / zKillboard integration: kill queries, intel, live feed via zKB websocket
- `src/eve-board/` — route monitoring: briefings, threat analytics, advisor, route snapshots
- `src/eve-osint/` — OSINT inference from kill activity: movement, ships, social, temporal patterns
- `src/eve-intel/`, `src/eve-local/`, `src/eve-scan/` — intel notes, local-chat analyzer, d-scan analyzer
- `src/messaging/` — outbound dispatcher: routes notifications by chat id sign (positive → Telegram, negative → Discord)
- `src/scheduled/` — heartbeat worker (croner-based scheduled tasks)
- `src/observability/` — colored, secret-redacting logger + startup banner
- `src/telegram/` — grammY bot setup, command handlers, access control
- `src/web/` — Fastify: EVE SSO login redirect/callback, security headers, health

**Config:** `src/config.ts` is the single config boundary. All env vars resolved there with `required()`/`optional()` helpers.

## Hard Invariants

- No workers, queues, Redis, or Postgres. SQLite only.
- Telegram uses grammY long polling only (no webhooks); Discord uses the standard gateway, DMs only.
- No web frontend. Fastify is limited to the EVE SSO login redirect/callback and health.
- Model provider: official OpenAI Responses API only.
- Private ESI access stays isolated per user and chat lane.
- Private ESI access must be gated by `get_eve_capabilities` when access is not already fresh.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.
- Static game data from local SDE in SQLite. Live data from ESI.
- Discord snowflakes are stored as TEXT (they exceed `Number.MAX_SAFE_INTEGER`); Discord DM lanes use negative internal chat keys.
- TypeScript strict mode required.

## Testing

- **Framework:** Vitest with globals enabled
- **Unit tests:** `tests/unit/` — module rules and regressions by boundary
- **Integration tests:** `tests/integration/` — auth and Telegram seam tests
- **Pattern:** `tests/**/*.test.ts`

## ESI Transport Rules

- Cache revalidation with ETag / If-None-Match
- Bounded retries for 420, 429, and transient 5xx
- X-Pages collections fail closed (no silent truncation)
- ESI field whitelisting in `src/agent/executor.ts`

## Self-Hosting

This public repo must not contain private production server details. Use [docs/deployment.md](./docs/deployment.md) for generic self-host deployment guidance, and keep operator-specific notes in ignored local files such as `.env` or private runbooks outside the repository.

## Documentation

`docs/` is the system of record. Key docs:
- `AGENTS.md` — repo map and hard invariants
- `docs/repo-map.md` — fast file-and-domain reference
- `docs/DESIGN.md` — doc structure rules
- `docs/PRODUCT_SENSE.md` — product intent and non-goals
- `docs/SECURITY.md`, `docs/RELIABILITY.md` — operational contracts
- `docs/deployment.md` — generic self-host deployment guide
- `docs/generated/db-schema.md` — SQLite schema reference

When behavior changes, update the matching doc in `docs/` in the same change.

<!-- repo-task-proof-loop:start -->
## Repo task proof loop

For substantial features, refactors, and bug fixes, use the repo-task-proof-loop workflow.

Required artifact path:
- Keep all task artifacts in `.agent/tasks/<TASK_ID>/` inside this repository.

Required sequence:
1. Freeze `.agent/tasks/<TASK_ID>/spec.md` before implementation.
2. Implement against explicit acceptance criteria (`AC1`, `AC2`, ...).
3. Create `evidence.md`, `evidence.json`, and raw artifacts.
4. Run a fresh verification pass against the current codebase and rerun checks.
5. If verification is not `PASS`, write `problems.md`, apply the smallest safe fix, and reverify.

Hard rules:
- Do not claim completion unless every acceptance criterion is `PASS`.
- Verifiers judge current code and current command results, not prior chat claims.
- Fixers should make the smallest defensible diff.

Installed workflow agents:
- `.codex/agents/task-spec-freezer.toml`
- `.codex/agents/task-builder.toml`
- `.codex/agents/task-verifier.toml`
- `.codex/agents/task-fixer.toml`

Claude Code note:
- Keep this block in the root `CLAUDE.md`. If the workflow needs longer repo guidance, prefer linked docs under `docs/` instead of expanding this block.
<!-- repo-task-proof-loop:end -->
