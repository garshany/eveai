# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # Full build: client (Vite) + server (tsc)
npm run dev                # Watch mode: concurrent Vite + tsx hot-reload
npm start                  # Production: node dist/app.js
npm run check              # Full CI pipeline: typecheck + test + lint
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm test:watch             # vitest watch mode
npm run lint               # eslint src/ --max-warnings 0
npm run lint:fix           # eslint auto-fix
npm run smoke              # Smoke tests: env, proxy, app health
npm run db:migrate         # Run SQLite migrations
npm run setup              # Download + load SDE data
```

## Architecture

Single-process Node.js app (ES modules, TypeScript strict). Telegram bot is the primary product surface; the web layer is support infrastructure.

```
Telegram private chat → grammY bot (long polling) → agent runtime → native /v1/responses API → ESI + SDE tools → SQLite
Browser → Fastify → auth callback + dashboard + health → same SQLite
```

**Entry point:** `src/app.ts` boots DB, runs migrations, starts Fastify server, starts grammY bot, registers graceful shutdown.

**Domain boundaries:**
- `src/agent/` — model runtime: responses loop, tool execution, planning, compaction, prompts
- `src/auth/` — Telegram login, EVE SSO, sessions, user resolution, encrypted secret storage
- `src/db/` — SQLite schema (`schema.ts` is source of truth), migrations, helpers
- `src/eve/` — ESI client, SSO token refresh, SDE lookups, capabilities gating, route planner
- `src/telegram/` — grammY bot setup, command handlers, access control
- `src/web/` — Fastify routes, frontend shell, middleware, security headers, health
- `client/src/` — React + Vite landing page and dashboard (built to `dist/client/`)

**Config:** `src/config.ts` is the single config boundary. All env vars resolved there with `required()`/`optional()` helpers.

## Hard Invariants

- No workers, queues, Redis, or Postgres. SQLite only.
- Telegram uses grammY long polling only. No webhooks.
- Fastify is limited to auth callback, web auth, dashboard support, and health.
- Private ESI access stays isolated per Telegram user and chat.
- Private ESI access must be gated by `get_eve_capabilities` when access is not already fresh.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.
- Static game data from local SDE in SQLite. Live data from ESI.
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

## Production Server

SSH доступ для проверок и деплоя:

```bash
sshpass -p 'AA1Ctpe=S8hb9fJ)' ssh -o StrictHostKeyChecking=no root@144.31.223.134
```

- host: `144.31.223.134`, user: `root`, app dir: `/opt/eveai`
- Process manager: `pm2` (app), `systemd` (codex proxy, nginx)
- Логи: `pm2 logs eveai --lines 50 --nostream`
- Рестарт: `pm2 restart eveai`
- Деплой: `cd /opt/eveai && git pull origin BRANCH && npm run build:server && pm2 restart eveai`
- Подробный runbook: `docs/deployment.md`

## Documentation

`docs/` is the system of record. Key docs:
- `AGENTS.md` — repo map and hard invariants
- `docs/repo-map.md` — fast file-and-domain reference
- `docs/DESIGN.md` — doc structure rules
- `docs/PRODUCT_SENSE.md` — product intent and non-goals
- `docs/SECURITY.md`, `docs/RELIABILITY.md` — operational contracts
- `docs/deployment.md` — production runbook
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
- `.claude/agents/task-spec-freezer.md`
- `.claude/agents/task-builder.md`
- `.claude/agents/task-verifier.md`
- `.claude/agents/task-fixer.md`

Claude Code note:
- If `init` just created or refreshed these files during a running Claude Code session, start a new Claude Code session before relying on the updated agent list.
- Use `/agents` to inspect the available agents.
- Keep this block in the root `CLAUDE.md`. If the workflow needs longer repo guidance, prefer `@path` imports or `.claude/rules/*.md` instead of expanding this block.
<!-- repo-task-proof-loop:end -->
