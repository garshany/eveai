# Task Spec: eve-board travel intelligence hardening

Status: frozen
Task ID: `eve-board-travel-intel-hardening`
Scope: `src/eve-board/`, `src/eve/route-planner.ts`, tightly coupled Telegram senders/tests/docs only when required by the acceptance criteria.

## Goal

Make route intelligence behave like one correct travel assistant instead of three partially disconnected layers. The selected-route summary, pre-flight briefing, and live ESP must use compatible data and semantics. Gate-camp analysis must rely on real killmail position data in live monitoring instead of dead code paths.

## Problem

Current route intelligence has three structural weaknesses:

1. `plan_route` selected-route summary and `generateBriefing()` run separate scans, so one answer can contain conflicting systems, kill counts, or timing.
2. Live analytics exposes gate attribution in `analytics.ts`, but `monitor.ts` does not pass killmail positions into digests, so "camp on gate" logic is effectively disabled in the live path.
3. Pre-flight and live ESP use related but not fully aligned tactical semantics, which makes the product feel inconsistent even when the raw data is correct.

## Product intent

The system should work as a legal travel ESP by API:

- one-shot route build answers the question "can I undock and take this route now?"
- live monitor answers the question "what changed around me and what should I do next?"
- both layers must use the same tactical language: current situation, nearest relevant risk ahead, and action

## Non-goals

- No rewrite of unrelated Telegram agent flows.
- No new infrastructure, queues, workers, Redis, or external stores.
- No attempt to build perfect PvP prediction beyond the signals already available from ESI/zKB/SDE.
- No broad redesign of kill-watch subscriptions outside the minimum coupling needed for route intelligence correctness.

## Acceptance Criteria

### AC1: shared selected-route snapshot for one-shot route output

- The selected-route summary and appended pre-flight briefing must be derived from one shared selected-route threat snapshot, not from two independent scans.
- Within a single `plan_route` response, `киллов/ч`, `zKB срез`, `Сейчас`, `Впереди`, `Анализ`, and `Последние киллы` must agree on the same kill set and timing window.
- Stale killmails whose real `killmail_time` falls outside the allowed window must not leak into either the selected-route summary or the pre-flight section.

### AC2: live gate-camp analytics uses real killmail positions

- The live monitor must carry killmail position data from ESI enrichment into `buildSystemDigest()`.
- `attributeKillsToGates()` must receive real positions in live monitoring so gate-level attribution can produce non-empty `gateKills` when killmails occur near a stargate.
- Actionable live digests and LLM context must be able to reference gate-level activity based on actual attributed kills instead of only indirect heuristics.

### AC3: aligned tactical semantics between pre-flight and live ESP

- Pre-flight and live ESP must both center on the same tactical contract: `Сейчас`, `Впереди`, `Действие`.
- Quiet states must remain deterministic and concise.
- Actionable states may still use the LLM, but only after the code has produced a coherent route digest with correct current/ahead/gate/ganker context.
- Destination-local activity must remain arrival intel, not be mislabeled as the nearest transit threat.

### AC4: regression coverage for the repaired flow

- Add or update tests proving that:
  - one `plan_route` response cannot contradict itself due to separate scans,
  - stale killmail filtering applies consistently to both summary and briefing,
  - live gate attribution works when killmail positions are present,
  - quiet live states still bypass the LLM, while actionable gate/ganker states can trigger richer analysis.

### AC5: docs reflect the repaired architecture

- Update the relevant docs in `docs/` so they describe:
  - the shared selected-route snapshot used by pre-flight output,
  - the real gate-camp signal path in live monitoring,
  - the exact split between deterministic logic and LLM reasoning.

## Verification Plan

1. Add/adjust targeted unit tests for route planner, briefing, analytics, advisor, and monitor behavior.
2. Run targeted `vitest` coverage for the repaired route-intelligence path.
3. Run `npm run typecheck`, `npm run lint`, and `npm run check`.
4. Record evidence in `.agent/tasks/eve-board-travel-intel-hardening/`.

## Assumptions

- The correct fix is to share enriched selected-route data across one-shot output layers instead of trying to make two independent scans "usually match".
- Gate-camp attribution based on actual kill positions is a better product signal than trying to infer every camp from text heuristics or LLM wording alone.
- The LLM should remain a reasoning layer over structured route intelligence, not a substitute for missing telemetry.
