# Refactor Modernization 2026-05-25

## Objective

Implement the ten-pass modernization plan while preserving behavior unless a pass is explicitly marked as a separate migration.

## Scope

- Create durable proof artifacts and parity checks before code changes.
- Identify dead code, duplicated paths, oversized modules, stale abstractions, and legacy patterns that slow changes down.
- Refactor runtime structure in small reviewable passes while keeping public APIs stable.
- Run the application and exercise ten representative requests, verifying tool-call behavior.

## Non-Goals

- No framework or dependency upgrades.
- No ESI compatibility-date migration or generated-client rewrite.
- No removal of intentionally supported legacy auth/session compatibility.
- No architecture moves to workers, queues, Redis, Postgres, or Telegram webhooks.
- No functional changes to model/provider behavior except safer logging/redaction wrappers.

## Acceptance Criteria

- AC1: Proof-loop artifacts exist under `.agent/tasks/refactor-modernization-20260525/`, including this frozen spec, evidence, evidence JSON, and raw command/runtime artifacts.
- AC2: An active execution plan exists under `docs/exec-plans/active/` and documents the refactor passes, parity checks, and separate migrations.
- AC3: Dead-code/import audit is recorded and only proven-unused code is deleted or explicitly deferred.
- AC4: Runtime logging goes through a repo-local logging facade for refactored runtime paths, with secret-like values redacted and console transport preserved.
- AC5: Agent executor responsibilities are split into smaller modules while preserving existing public entrypoints and test seams.
- AC6: Agent tool catalog responsibilities are split into smaller modules while preserving `src/agent/tools.ts` public exports.
- AC7: Route board monitor, route planner, OSINT inference, and client app are decomposed into smaller modules/components without intended behavior changes.
- AC8: Test-only type debt is reduced through typed fixtures or typed wrappers without broadening production internals.
- AC9: Fresh verification commands pass or any failures are captured with a problem record and smallest safe fix attempt.
- AC10: The app is launched locally and ten representative requests are exercised, with evidence showing which tool calls were triggered or intentionally not triggered.

## Parity Request Set

1. Static SDE aggregate count.
2. SDE SQL item/type lookup.
3. Route planning.
4. Route monitor status.
5. Public EVE kill lookup.
6. EVE Scout lookup.
7. OSINT inference.
8. Local/D-scan analysis.
9. Auth/capability-gated private ESI request.
10. General web-search eligible knowledge request.

## Validation Commands

- `npm run typecheck`
- `npm run test`
- `npm run lint`
- `npm run build`
- `npm run smoke`
- Local app launch and ten parity requests, recorded in raw artifacts.
