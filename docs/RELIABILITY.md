# Reliability

## Current Mechanisms

- `/health` reports bot status plus database and client asset readiness.
- `npm run smoke` verifies required env vars, the configured model `/responses` endpoint, and app health.
- agent turns use `OPENAI_RESPONSE_STATE_MODE=stateless` by default, so tool continuation does not depend on provider-retained `previous_response_id` state.
- `OPENAI_RESPONSE_STATE_MODE=server` is available only for providers that explicitly support stored Responses continuation.
- if provider-side tool-call state is lost during server-state mode, the agent clears `previous_response_id` and retries from SQLite-backed cold recovery context with recent tool summaries.
- ESI GETs use SQLite cache with `ETag` and `If-Modified-Since` revalidation.
- ESI retry logic is bounded for `420`, `429`, and transient `5xx`.
- token refresh is deduplicated in-flight per character.
- malformed or no-longer-decryptable stored EVE tokens degrade to a relink-required auth miss instead of throwing through the Telegram turn.
- Telegram request handling dedupes identical in-flight requests per chat/thread.
- Telegram ingress rejects overlapping agent turns in the same chat, rate-limits recent requests per actor, and caps global in-process concurrency.
- simple static aggregate count questions use local-SDE deterministic paths instead of exploratory web or live-ESI loops.
- when a deterministic static count tool fully answers the user request, the executor finalizes the reply server-side and skips the extra model round-trip.

## Tool Loop Model

- runtime tools are Responses API function tools implemented by this Node.js process.
- in stateless mode, each tool continuation includes the previous `function_call` item plus its matching `function_call_output`.
- in server mode, the app can send only `function_call_output` with `previous_response_id`, but only for providers that retain response state.
- local `skills/` files are maintainer workflow docs and are not required for end-user runtime operation.
- protocol notes: [skills-protocol.md](./skills-protocol.md).

## Failure Model

- if Telegram bot startup fails, health becomes degraded or failed.
- if the configured model endpoint rejects `/responses`, smoke reports `model_responses` failure.
- if the stored `previous_response_id` is stale, missing, or no longer trustworthy in server-state mode, the agent falls back to local history instead of assuming provider-side continuity.
- if a `function_call_output` no longer matches provider-side tool state, the agent drops warm continuation and retries from local recovery context instead of surfacing the raw call-id mismatch to the user.
- if stored EVE secrets no longer decrypt under the current auth key, private requests fail closed as relink-required instead of crashing the request handler.
- if a user asks a simple static geography count question, the runtime should stay within local SDE-backed tools; drifting into web or live ESI is treated as a routing failure.
- if ESI pagination changes during collection, the request fails instead of silently truncating.
- if required auth state expires, callback flows fail closed.
- if Telegram ingress exceeds the configured recent-rate or global active ceiling, the request is rejected early with a retry-later message instead of consuming more model or ESI capacity.

## Operational Checks

- `GET /health`
- `npm run smoke`
- `npm run test`
- `npm run typecheck`
- `npm run lint`

## ESI Notes

- `X-Pages` pagination treats `Last-Modified` as the page-set snapshot signal and fails closed if later pages disagree.
- page-local `ETag` differences do not by themselves invalidate a paginated collection.

## Known Reliability Risks

- no separate background worker means long-running synchronous work can still contend with the main process.
- docs do not yet have mechanical freshness checks.
- production operation still depends on each self-hosting operator's process supervision, backups, and secret handling.
- Telegram abuse controls are intentionally in-memory because the app is single-process; they do not coordinate across multiple app instances.
