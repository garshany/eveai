# Telegram Region Moons Debug

Status: completed

## Goal

Investigate the production/dev Telegram failure path for the question `Сколько лун в моем регионе`, separate proxy/API issues from app/runtime issues, and apply the smallest safe code change that makes the current region available to the model.

## Findings

- Production `/opt/eveai` was running an older checkout (`3edf505`) than the latest pushed repository state.
- Codex proxy communication itself was functional for fresh turns; `/responses` accepted the app payload and returned normal streamed outputs.
- PM2 logs showed two independent runtime risks:
  - recovered proxy-side tool-state loss (`No tool call found for function call output with call_id ...`)
  - private ESI decrypt failures for some turns (`Unsupported state or unable to authenticate data`)
- For linked-character turns that rely on current location, the executor prompt only carried `system_id` and system name, not the resolved constellation/region chain, so the model often asked the user to name the region manually or looped through extra lookups.

## Change

- Enriched executor live context with `system + constellation + region` resolved from local SDE.
- Added an explicit prompt hint telling the model to treat "мой регион" and similar phrasing as the current live location when the prompt already carries that state.
- Added targeted regression coverage for SDE-backed live-location resolution.

## Verification

- `npm run test -- tests/unit/warm-cold-path.test.ts tests/unit/prompts.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
