# Reliability

## Current Mechanisms

- `/health` reports bot status plus database, client assets, and local proxy health
- `npm run smoke` verifies env, proxy health, proxy models, and app health
- agent turns use warm continuation through `previous_response_id` only while the stored response id is fresh; otherwise they fall back to SQLite-backed cold context rebuild
- if proxy-side tool-call state is lost during a warm turn, the agent clears `previous_response_id` and retries from SQLite-backed cold recovery context with recent tool summaries instead of failing immediately
- if the proxy reports a tool-call mismatch inside a successful Responses payload, the same cold-recovery path is used instead of surfacing the raw `call_id` mismatch
- ESI GETs use SQLite cache with `ETag` and `If-Modified-Since` revalidation
- ESI retry logic is bounded for `420`, `429`, and transient `5xx`
- token refresh is deduplicated in-flight per character
- malformed or no-longer-decryptable stored EVE tokens degrade to a relink-required auth miss instead of throwing through the Telegram turn
- Telegram request handling dedupes identical in-flight requests per chat/thread
- Telegram ingress rejects overlapping agent turns in the same chat, rate-limits recent requests per actor, and caps global in-process concurrency
- static moon-count questions use a deterministic local-SDE path (`count_moons` / `mapPlanets`) instead of exploratory web or live-ESI loops
- simple static aggregate count questions (systems, constellations, planets, moons, asteroid belts, stations, stargates) use a reduced static toolset plus deterministic local-SDE counters instead of the full ESI namespace catalog
- when a deterministic static count tool fully answers the user request, the executor finalizes the reply server-side and skips the extra model round-trip

## Skills Execution Model

- skills work through a function tool `"shell"` on `gpt-5.5` and current GPT-5.x Codex models, not `type: "local_shell"` or `type: "shell"` (both rejected by ChatGPT backend)
- skill metadata (name, description, path) is injected into `instructions`; the model reads `SKILL.md` via the shell tool and follows its instructions
- the client must execute shell commands in a sandboxed environment with timeouts and output caps
- full protocol reference: [skills-protocol.md](./skills-protocol.md)

## Failure Model

- if Telegram bot startup fails, health becomes degraded or failed
- if proxy health fails, app health reports dependency failure
- if the stored `previous_response_id` is stale, missing, or no longer trustworthy, the agent falls back to local history instead of assuming proxy-side continuity
- if a `function_call_output` no longer matches proxy-side tool state, the agent drops warm continuation and retries from local recovery context instead of surfacing the raw call-id mismatch to the user
- if stored EVE secrets no longer decrypt under the current auth key, private requests fail closed as "relink required" instead of crashing the request handler
- if a user asks a simple static geography count question, including current-location aliases like "мой регион", "current region", or "here", the runtime should stay within local SDE-backed tools; drifting into `web_search`, `tool_search`, or live ESI is treated as a routing failure
- if ESI pagination changes during collection, the request fails instead of silently truncating
- if required auth state expires, callback flows fail closed
- if Telegram ingress exceeds the configured recent-rate or global active ceiling, the request is rejected early with a retry-later message instead of consuming more model or ESI capacity

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
- Telegram abuse controls are intentionally in-memory because the app is single-process; they do not coordinate across multiple app instances
