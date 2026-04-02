# Evidence

## Scope
- Replaced raw `<-` with Unicode `←` in Telegram-facing route and briefing kill lines.
- Made helpful-commands appendix HTML-aware in finalizer.
- Added regression tests for route summary, briefing, and finalizer.

## Commands
- `npm run test -- tests/unit/route-planner.test.ts tests/unit/briefing.test.ts tests/unit/finalizer.test.ts tests/unit/telegram-formatting.test.ts`
- `npm run typecheck`
- `npm run check`

## Result
- PASS: AC1
- PASS: AC2
- PASS: AC3
