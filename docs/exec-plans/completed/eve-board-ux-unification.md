# Eve-Board UX Unification

Status: completed

## Goal

Turn `eve-board` into one coherent travel assistant for Telegram so pre-flight and live ESP speak the same cockpit language instead of producing multiple overlapping analytical blocks.

## Findings

- The route answer was split across `route-planner` and `briefing`, so the pilot received two pre-flight layers with different priorities and phrasing.
- The summary mixed the chosen route with danger coverage from alternatives, which polluted the main decision surface with irrelevant systems.
- Live ESP already had the right product direction, but its structure and semantics were not fully aligned with the initial route answer.
- Quiet route states need a deterministic output contract; leaving them to free-form LLM wording makes the UX feel inconsistent and noisy.

## Change

- Compressed `plan_route` into a compact selected-route-first summary and moved the main pilot decision into a single unified pre-flight brief.
- Reworked `generateBriefing()` around action-state semantics and the stable pilot-facing order `Маршрут`, `Корабль`, `Сейчас`, `Впереди`, `Действие`.
- Kept alternatives, compact comparison, traffic, and danger details as a secondary layer instead of the primary verdict.
- Aligned live ESP formatting with the same operational contract and preserved deterministic fallback behavior for quiet or low-signal situations.
- Kept the monitor start behavior gated by active autopilot while allowing the pre-flight brief to appear whenever the selected route and linked character are available.

## Verification

- `npx vitest run tests/unit/route-planner.test.ts tests/unit/briefing.test.ts tests/unit/eve-board-briefing.test.ts tests/unit/eve-board-advisor.test.ts tests/unit/eve-board-intel.test.ts tests/unit/eve-board-monitor.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run check`
