# Reliability

## Current Mechanisms

- `/health` reports bot status plus database, client assets, and local proxy health
- `npm run smoke` verifies env, proxy health, proxy models, and app health
- agent turns use warm continuation through `previous_response_id` only while the stored response id is fresh; otherwise they fall back to SQLite-backed cold context rebuild
- ESI GETs use SQLite cache with `ETag` and `If-Modified-Since` revalidation
- ESI retry logic is bounded for `420`, `429`, and transient `5xx`
- token refresh is deduplicated in-flight per character
- Telegram request handling dedupes identical in-flight requests per chat/thread

## Failure Model

- if Telegram bot startup fails, health becomes degraded or failed
- if proxy health fails, app health reports dependency failure
- if the stored `previous_response_id` is stale, missing, or no longer trustworthy, the agent falls back to local history instead of assuming proxy-side continuity
- if ESI pagination changes during collection, the request fails instead of silently truncating
- if required auth state expires, callback flows fail closed

## Operational Checks

- `GET /health`
- `npm run smoke`
- `npm run test`
- `npm run typecheck`
- `npm run lint`

## ESI Notes

- `X-Pages` pagination treats `Last-Modified` as the page-set snapshot signal and fails closed if later pages disagree
- page-local `ETag` differences do not by themselves invalidate a paginated collection

## Known Reliability Risks

- no separate background worker means long-running synchronous work can still contend with the main process
- docs do not yet have mechanical freshness checks
- production runbook still depends on external operator discipline
