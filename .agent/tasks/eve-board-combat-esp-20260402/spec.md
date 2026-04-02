# EVE Board Combat ESP

## Goal
Upgrade `src/eve-board` from a kill-feed digest into a more tactical combat ESP assistant for in-flight route analysis.

## Scope
- Improve live ESP output, not the one-shot route preflight.
- Reuse existing repo signals only: route digest, gate attribution, ganker cache, pursuit, ship assessment, jump spikes.
- Keep the system single-process and deterministic-first; LLM stays optional and bounded.

## Acceptance Criteria
- AC1: Live ESP builds a tactical assessment that explicitly distinguishes `start`, `transit`, and `destination` risk from the current route digest.
- AC2: Live ESP identifies and surfaces a route state such as `camp likely`, `pursuit`, `window open`, or `hot start`, instead of only generic threat prose.
- AC3: Deterministic ESP output includes action-oriented operational lines grounded in that tactical assessment, with a compact military-style summary layer.
- AC4: LLM prompt context is upgraded to consume the tactical assessment, so model output is constrained by the same route-relative facts as the deterministic fallback.
- AC5: Unit coverage proves the new tactical layer and output shape on at least quiet, hot-start, gate-camp, and destination-hot scenarios.
- AC6: `npm run check` passes on the final code.
