# Evidence

## Scope
- Added a tactical combat-ESP layer in `src/eve-board/advisor.ts`.
- Tactical assessment now separates `start / transit / destination` risk and derives route state plus tactical window/confidence.
- Live ESP output now includes a compact tactical layer before `Сейчас / Впереди / Действие`.
- LLM prompt context now includes the same tactical assessment as the deterministic fallback.

## Commands
- `npm run test -- tests/unit/eve-board-advisor.test.ts tests/unit/eve-board-monitor.test.ts tests/unit/eve-board-analytics.test.ts`
- `npm run typecheck`
- `npm run check`

## Result
- PASS: AC1
- PASS: AC2
- PASS: AC3
- PASS: AC4
- PASS: AC5
- PASS: AC6
