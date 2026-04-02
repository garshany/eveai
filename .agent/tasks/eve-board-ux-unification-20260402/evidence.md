# Evidence: eve-board UX unification

## Scope

- `src/eve/route-planner.ts`
- `src/eve-board/briefing.ts`
- `src/eve-board/advisor.ts`
- `src/eve-board/monitor.ts`
- `docs/eve-kill.md`
- `docs/exec-plans/completed/eve-board-ux-unification.md`
- targeted unit tests under `tests/unit/`

## Acceptance criteria status

- AC1: PASS
  - `plan_route` now returns a compact selected-route-first summary and appends one unified pre-flight brief instead of relying on two large overlapping pre-flight blocks.
  - Verified by `tests/unit/route-planner.test.ts`.

- AC2: PASS
  - Pre-flight and live ESP now both center the pilot-facing answer around action-state plus `Сейчас`, `Впереди`, `Действие`.
  - Verified by `tests/unit/briefing.test.ts`, `tests/unit/eve-board-briefing.test.ts`, `tests/unit/eve-board-advisor.test.ts`, and `tests/unit/eve-board-intel.test.ts`.

- AC3: PASS
  - Alternative routes and comparisons remain visible but are compressed into the summary secondary layer; primary focus stays on the selected route and next action.
  - Verified by `src/eve/route-planner.ts` formatting changes and `tests/unit/route-planner.test.ts`.

- AC4: PASS
  - Live ESP keeps state-change semantics, quiet states stay deterministic, and monitor/session dedupe still prevents repeated kill growth from raw zKB overlap.
  - Verified by `src/eve-board/advisor.ts`, `src/eve-board/monitor.ts`, `tests/unit/eve-board-advisor.test.ts`, `tests/unit/eve-board-intel.test.ts`, and `tests/unit/eve-board-monitor.test.ts`.

- AC5: PASS
  - Docs and execution-plan records now describe the unified travel-assistant contract.
  - Verified by `docs/eve-kill.md`, `docs/exec-plans/completed/eve-board-ux-unification.md`, and the updated completed index.

## Verification commands

1. `npx vitest run tests/unit/route-planner.test.ts tests/unit/briefing.test.ts tests/unit/eve-board-briefing.test.ts tests/unit/eve-board-advisor.test.ts tests/unit/eve-board-intel.test.ts tests/unit/eve-board-monitor.test.ts`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run check`

## Raw artifacts

- `artifacts/vitest-targeted.txt`
- `artifacts/typecheck.txt`
- `artifacts/lint.txt`
- `artifacts/check.txt`

## Notes

- The worktree already contained unrelated untracked task/test artifacts; they were left untouched.
- Full `npm run check` passed on the current codebase after the UX unification changes.
