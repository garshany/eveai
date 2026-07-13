# EVE Agent

This file is a map, not the full manual.

Repository knowledge lives in versioned docs under `docs/`. Read only the next document you need.

## Hard Invariants

- Single-process Node.js app. No workers, queues, Redis, or Postgres.
- Chat platforms: Telegram (grammY long polling, no webhooks) and Discord (discord.js gateway, DMs only). Both share one agent runtime; at least one bot token must be configured.
- There is no web frontend. Fastify is limited to the EVE SSO login redirect/callback and health.
- Model provider: official OpenAI Responses API only.
- Private ESI access stays isolated per user and chat lane.
- Private ESI access must be gated by `get_eve_capabilities` when access is not already fresh.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.
- Static game data comes from local SDE in SQLite. Live character and market data comes from ESI.
- Discord snowflake ids are stored as TEXT; Discord DM lanes map to negative internal chat keys (Telegram chat ids are positive).
- TypeScript strict mode is required across the repo.
- Use `gh` for GitHub-aware workflows when repo operations are needed.

## Self-Hosting

- This repository is intended to be self-hosted by each operator.
- Do not commit local server addresses, credentials, tokens, or deployment-only runbooks.
- Deployment guidance lives in [docs/deployment.md](./docs/deployment.md) and must stay generic.

## Start Here

- [docs/index.md](./docs/index.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [docs/DESIGN.md](./docs/DESIGN.md)
- [docs/PRODUCT_SENSE.md](./docs/PRODUCT_SENSE.md)
- [docs/PLANS.md](./docs/PLANS.md)
- [docs/QUALITY_SCORE.md](./docs/QUALITY_SCORE.md)
- [docs/RELIABILITY.md](./docs/RELIABILITY.md)
- [docs/SECURITY.md](./docs/SECURITY.md)

## Deep Links

- [docs/repo-map.md](./docs/repo-map.md)
- [docs/design-docs/index.md](./docs/design-docs/index.md)
- [docs/product-specs/index.md](./docs/product-specs/index.md)
- [docs/generated/db-schema.md](./docs/generated/db-schema.md)
- [docs/exec-plans/active/index.md](./docs/exec-plans/active/index.md)
- [docs/exec-plans/completed/index.md](./docs/exec-plans/completed/index.md)
- [docs/exec-plans/tech-debt-tracker.md](./docs/exec-plans/tech-debt-tracker.md)
- [docs/deployment.md](./docs/deployment.md)

## Repo Map

- Runtime entrypoints:
  - `src/app.ts` boots DB, HTTP server, and the Telegram/Discord bots.
  - `src/config.ts` is the runtime config boundary.
- Domain folders:
  - `src/agent/`, `src/auth/`, `src/chat/`, `src/db/`, `src/discord/`, `src/eve/`, `src/messaging/`, `src/telegram/`, `src/web/`
- Verification and ops:
  - `tests/unit/`, `tests/integration/`, `deploy/systemd/`
- Repo-local knowledge:
  - `docs/` is the system of record.
  - `docs/repo-map.md` is the fast file-and-domain map.
  - `skills/` contains local Codex skills for ESI, planning, and SDE workflows.

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
