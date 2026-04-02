# Evidence: eve-board travel intelligence hardening

## Summary

Implemented a route-intelligence repair that removes one-shot snapshot drift between route summary and pre-flight briefing, restores real gate-attribution input for live monitoring, and aligns deterministic/live tactical semantics around `Сейчас`, `Впереди`, `Действие`.

## Acceptance Criteria

### AC1: shared selected-route snapshot for one-shot route output

PASS

- `plan_route` now passes one selected-route snapshot into `generateBriefingFromSnapshot()` instead of letting route summary and briefing rescan independently.
- Route-planner danger entries now preserve `systemId`, `killmail_id`, and raw `killmail_time`, so the appended briefing uses the same kill set and time window as `киллов/ч` and `zKB срез`.
- Regression coverage:
  - `tests/unit/route-planner.test.ts`
  - `tests/unit/briefing.test.ts`

### AC2: live gate-camp analytics uses real killmail positions

PASS

- `monitor.ts` now fetches killmail positions via `getKillmailBatch()` and injects them into `buildSystemDigest()`.
- `analytics.attributeKillsToGates()` now receives real `position` data in the live path instead of `undefined`.
- Regression coverage:
  - `tests/unit/eve-board-monitor.test.ts`
  - `tests/unit/eve-board-analytics.test.ts`

### AC3: aligned tactical semantics between pre-flight and live ESP

PASS

- Pre-flight remains `Сейчас`, `Впереди`, `Действие`, but now uses the same selected-route kill snapshot as the summary.
- Live advisor now treats gate-level activity as meaningful/actionable context and can surface it in deterministic output or LLM gating.
- Destination-local activity continues to be treated as arrival intel by briefing tests.

### AC4: regression coverage for the repaired flow

PASS

- Added or updated focused tests for:
  - shared pre-flight snapshot
  - stale kill filtering consistency
  - live gate attribution
  - actionable gate intel gating in advisor

### AC5: docs reflect the repaired architecture

PASS

- Updated `docs/eve-kill.md` to describe:
  - `route-snapshot.ts`
  - shared selected-route snapshot behavior
  - live gate-position flow into analytics
  - deterministic vs LLM split

## Verification

Commands run successfully:

```bash
npm run test -- tests/unit/route-planner.test.ts tests/unit/briefing.test.ts tests/unit/eve-board-monitor.test.ts tests/unit/eve-board-analytics.test.ts tests/unit/eve-board-advisor.test.ts
npm run typecheck
npm run lint -- src/eve/route-planner.ts src/eve-board/briefing.ts src/eve-board/route-snapshot.ts src/eve-board/monitor.ts src/eve-board/advisor.ts tests/unit/route-planner.test.ts tests/unit/briefing.test.ts tests/unit/eve-board-monitor.test.ts tests/unit/eve-board-analytics.test.ts tests/unit/eve-board-advisor.test.ts
npm run check
```

Observed final result:

- `npm run check` passed
- 42 test files / 229 tests passed in the repo-wide check
