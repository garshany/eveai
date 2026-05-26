# Refactor Modernization 2026-05-25

## Goal

Modernize internal structure without changing product behavior. Keep public APIs stable and split any functional migration into a separate task.

## Passes

| Pass | Current behavior | Structural improvement | Stability check |
| --- | --- | --- | --- |
| Proof loop | Refactor intent exists in chat only. | Freeze `.agent/tasks/refactor-modernization-20260525/spec.md` and collect raw evidence. | AC1 evidence files exist. |
| Dead-code audit | Deprecated and legacy-looking paths coexist with live code. | Record import graph and remove only proven-unused code. | `rg` import evidence, typecheck, tests. |
| Logging facade | Runtime logs directly through `console.*`. | Add a repo-local logger with redaction, preserving console transport. | Logger unit checks plus full check. |
| Agent executor | `src/agent/executor.ts` mixes context, recovery, static aggregate, tool loop, and execution. | Extract helpers/modules behind stable exports. | Existing executor/static aggregate/warm-cold tests. |
| Agent tools | `src/agent/tools.ts` mixes schema, predicates, SDE SQL, universe count, and catalog assembly. | Extract catalog/schema/executor helpers, keep re-export boundary stable. | Existing tools/SDE SQL/moon count tests. |
| Route monitor | `src/eve-board/monitor.ts` owns lifecycle, polling, digesting, watches, and notifications. | Extract monitor helpers while preserving lifecycle API. | Existing route board monitor/advisor/briefing tests. |
| Route planner | `src/eve/route-planner.ts` mixes route fetch, danger scan, autopilot, Thera shortcut, and formatting. | Extract planner submodules with stable `planRoute`. | Route planner and briefing tests. |
| OSINT inference | `src/eve-osint/inference.ts` owns orchestration, scoring, formatting. | Extract collection/scoring/format helpers. | OSINT inference fixture tests. |
| Client app | `client/src/app.tsx` contains landing, dashboard, auth, and API concerns. | Extract components/hooks/API helpers, preserve routes and copy. | Client build and web/auth tests. |
| Test type debt | Tests use broad casts for DB rows and private seams. | Add typed row helpers/fixtures where safe. | Full test suite and typecheck. |

## Separate Migration Tasks

- Dependency/framework upgrades.
- ESI generated client or compatibility-date updates.
- Removing legacy auth/session compatibility rows.
- Replacing console transport with a structured logging backend.
- Any workers, queues, Redis, Postgres, or Telegram webhook architecture change.

## Runtime Parity

After implementation, launch the app locally and record ten representative requests in `.agent/tasks/refactor-modernization-20260525/raw/`, including observed tool calls or a reason no tool was expected.
