# Aggregate Latency Hardening

Status: completed

## Goal

Eliminate the avoidable long-turn overhead for deterministic static aggregate count questions and extend the moon-style fix to analogous geography counts that should stay inside local SDE data.

## Findings

- The post-moon fix still paid for large `/responses` payloads because every turn carried the full namespace tool catalog, even when the request was a simple static count.
- For a pure deterministic count question, the model still needed a second round-trip only to paraphrase an already complete tool result.
- The same failure pattern could recur for adjacent questions such as:
  - how many systems in a region
  - how many constellations in a region
  - how many planets in a constellation or region
  - how many stations or stargates in a system/constellation/region

## Change

- Added `count_universe_objects` as a deterministic local-SDE tool for systems, constellations, planets, moons, stations, and stargates across system/constellation/region scopes.
- Added a conservative static-aggregate goal detector that switches those turns onto a reduced toolset instead of the full ESI namespace catalog.
- Added server-side fast-finalization for simple deterministic count answers so the executor can return immediately after the count tool result without a second model turn.
- Expanded prompt routing and reliability docs to keep these requests away from `tool_search`, `web_search`, and live ESI when local SDE is sufficient.

## Verification

- `npm run test -- tests/unit/static-aggregate.test.ts tests/unit/moon-count.test.ts tests/unit/warm-cold-path.test.ts tests/unit/tools.test.ts tests/unit/sso.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
