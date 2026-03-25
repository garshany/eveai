# EVE Agent

This file is a map, not the full manual.

Repository knowledge lives in versioned docs under `docs/`. Read only the next document you need.

## Hard Invariants

- Single-process Node.js app. No workers, queues, Redis, or Postgres.
- Telegram uses grammY long polling only. No webhooks.
- Fastify is limited to auth callback, web auth, dashboard support, and health.
- Private ESI access stays isolated per Telegram user and chat.
- Private ESI access must be gated by `get_eve_capabilities` when access is not already fresh.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.
- Static game data comes from local SDE in SQLite. Live character and market data comes from ESI.
- TypeScript strict mode is required across the repo.
- Use `gh` for GitHub-aware workflows when repo operations are needed.

## Start Here

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [docs/DESIGN.md](./docs/DESIGN.md)
- [docs/PRODUCT_SENSE.md](./docs/PRODUCT_SENSE.md)
- [docs/FRONTEND.md](./docs/FRONTEND.md)
- [docs/PLANS.md](./docs/PLANS.md)
- [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md)
- [docs/RELIABILITY.md](./docs/RELIABILITY.md)
- [docs/SECURITY.md](./docs/SECURITY.md)

## Deep Links

- [docs/design-docs/index.md](./docs/design-docs/index.md)
- [docs/product-specs/index.md](./docs/product-specs/index.md)
- [docs/generated/db-schema.md](./docs/generated/db-schema.md)
- [docs/exec-plans/active/index.md](./docs/exec-plans/active/index.md)
- [docs/exec-plans/completed/index.md](./docs/exec-plans/completed/index.md)
- [docs/exec-plans/tech-debt-tracker.md](./docs/exec-plans/tech-debt-tracker.md)
- [docs/deployment.md](./docs/deployment.md)

## Repo Map

- `src/app.ts` boots DB, HTTP server, and Telegram bot.
- `src/config.ts` is the runtime config boundary.
- `src/agent/` contains the model runtime, prompts, planning, execution, and finalization.
- `src/auth/` contains Telegram login, handoff, session, and user resolution.
- `src/db/` contains SQLite schema, migrations, and DB helpers.
- `src/eve/` contains ESI, SSO, SDE, route planning, zKill, and user profile logic.
- `src/telegram/` contains grammY bot setup and command handlers.
- `src/web/` contains Fastify routes, middleware, security headers, health, and frontend shell.
- `client/src/` contains the Vite/React landing page and dashboard.
- `tests/unit/` covers module rules and regressions.
- `tests/integration/` covers auth, DB, and Telegram flow seams.
- `deploy/systemd/` contains service units.
- `skills/` contains local Codex skills for ESI, planning, and SDE workflows.
- `data/` contains local runtime DBs, cached swagger, SDE inputs, and generated user snapshots.

## Working Rules

- If behavior changes, update the matching doc in `docs/` in the same change.
- For complex work, add or update an execution plan in `docs/exec-plans/`.
- Prefer generated or source-backed docs over hand-maintained duplicated lists.
- Keep `AGENTS.md` short. Move durable knowledge into `ARCHITECTURE.md` and `docs/`.

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
<!-- repo-task-proof-loop:end -->
