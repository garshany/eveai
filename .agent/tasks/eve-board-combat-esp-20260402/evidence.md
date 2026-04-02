# Evidence

## Scope
- Extended `RouteThreatDigest` with tactical assessment metadata.
- Route analytics now derives tactical state, confidence, headline, zone risk, and window-open status.
- Live ESP already had a route-tactical layer in `advisor.ts`; this change feeds richer digest context and keeps one-shot `briefing.ts` aligned with a new `Тактика:` line.

## Commands
- `npm run test -- tests/unit/eve-board-analytics.test.ts tests/unit/eve-board-advisor.test.ts tests/unit/briefing.test.ts tests/unit/eve-board-monitor.test.ts`
- `npm run check`

## Result
- PASS: AC1
- PASS: AC2
- PASS: AC3
- PASS: AC4
