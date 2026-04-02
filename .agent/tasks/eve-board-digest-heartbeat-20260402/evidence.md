# Evidence

## Root Cause
`sendRouteDigest()` only emitted when deltas changed (`newKills`, threat, pilot system, ganker signature, pursuit). On a stable but still actionable route, Telegram got one ESP digest and then only raw threat alerts or silence.

## Fix
- Added a 6-minute heartbeat resend for actionable route digests.
- Actionable means non-LOW route threat or active route intel such as gankers, gate activity, recent kills, or jump spikes.

## Commands
- `npm run test -- tests/unit/eve-board-monitor.test.ts tests/unit/eve-board-advisor.test.ts tests/unit/eve-board-analytics.test.ts`
- `npm run typecheck`
- `npm run check`

## Result
- PASS: AC1
- PASS: AC2
- PASS: AC3
