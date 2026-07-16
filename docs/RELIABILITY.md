# Reliability

## Current Mechanisms

- `/health` reports Telegram and Discord startup state plus SQLite database readiness.
- both runtime entrypoints atomically own a DB-adjacent process lock; PID plus process-start identity rejects a live second owner without letting a recycled PID pin stale state, and a crashed owner's lock is reclaimed atomically.
- `npm run smoke` verifies required env vars, the configured model `/responses` endpoint, and app health.
- normal agent turns honor fixed `OPENAI_REASONING_EFFORT` values; `auto` alone invokes the local low/medium/high goal classifier.
- `OPENAI_REASONING_MODE=pro` is scoped to the top-level user turn so internal compaction, OSINT, and advisor calls retain standard-mode latency.
- Responses usage logs distinguish cached reads from GPT-5.6 cache writes.
- top-level requests include an HMAC-derived `safety_identifier` when `AUTH_SECRET_KEY` is configured; raw platform and database user ids are not sent.
- agent turns default to `OPENAI_RESPONSE_STATE_MODE=stateless`; opt-in `server` mode requires stored Responses and reuses only a recent id atomically anchored to the exact latest assistant message.
- SQLite remains canonical in both modes. Server-state drift or explicit provider state loss triggers an exact active-turn cold replay; transient transport failures retry the same continuation first.
- `OPENAI_STORE_RESPONSES` controls OpenAI Dashboard/API retention independently; enabling it alone does not change the state mode.
- ESI GETs use SQLite cache with `ETag` and `If-Modified-Since` revalidation.
- ESI retry logic is bounded for `420`, `429`, and transient `5xx`.
- token refresh is deduplicated in-flight per character.
- EVE-KILL REST responses are size-capped and runtime-validated; search windows, ID chunks, cursor progress, request budgets, deduplication, and result truncation are enforced locally.
- one global EVE-KILL feed cursor is durable in SQLite. A missing cursor bootstraps to the current head without history replay; restored route listeners are registered before any resumed event is processed.
- the open CLI is an explicit feed delivery platform at `chat_id = 0`; prompt-aware alerts are awaited, route/watch rows survive restart, and missed events are not replayed while the CLI is closed.
- feed/watch delivery is at-least-once for retryable failures: the cursor moves only after awaited active listeners and active-platform chat sends, while per-chat killmail dedup skips recipients already accepted during a partial retry. A definitive platform rejection (for example, a blocked Telegram bot or deleted/inaccessible Discord DM) is recorded as a terminal acknowledgement so one unreachable recipient cannot freeze the shared cursor; transport errors and rate limits remain retryable. Watches and restored route monitors for a platform disabled in the current process are suspended rather than allowed to hold the one global cursor; events missed while disabled are not replayed.
- resumed route-feed events older than the one-hour threat window are acknowledged without enrichment, alerts, stats, pursuit state, or ganker-cache promotion. Current events are serialized per monitor and commit the per-monitor-run killmail dedup marker, ganker update, and stats in one SQLite transaction; baseline-overlap, concurrent, and post-restart replays are absorbed.
- route planning, briefing, and monitor startup share one bounded baseline; matching events captured during the snapshot-to-live handoff are drained by the monitor without a second scan. The temporary listener does not acknowledge a captured event until the permanent monitor listener is registered, so a crash leaves the durable cursor unchanged; a full buffer likewise rejects the next event.
- a restored route monitor that cannot rebuild its one-hour EVE-KILL baseline is explicitly stopped, its durable monitor row is removed, and the user is notified instead of continuing with an empty threat history.
- heartbeat state that produced findings is committed only after awaited outbound delivery. Failed official killmail detail or failed delivery leaves its cursor unchanged for retry.
- malformed or no-longer-decryptable stored EVE tokens degrade to a relink-required auth miss instead of throwing through the Telegram turn.
- Chat request handling dedupes identical in-flight requests per chat/thread.
- Telegram and Discord ingress reject overlapping agent turns in the same chat lane, rate-limit recent requests per actor, and cap global in-process concurrency.
- simple static aggregate count questions use local-SDE deterministic paths instead of exploratory web or live-ESI loops.
- when a deterministic static count tool fully answers the user request, the executor finalizes the reply server-side and skips the extra model round-trip.
- Programmatic Tool Calling remains default-off. When enabled, exactly nine bounded public-read tools use application-enforced caller linkage, one-family coherence, atomic batch reservation, four calls per batch/turn/program, family work ceilings, and a 16-iteration ceiling.
- `market_history_summary`, `system_metric_snapshot`, `doctrine_summary`, and `dynamic_item_summary` validate strict inputs before fixed-source egress, validate and narrowly project upstream data, and replace drifted, non-finite, unserializable, or over-12,000-character results wholesale with fixed schema-valid errors.
- upstream processing is also bounded before projection: market history accepts at most 500 daily rows, system bulk metrics at most 10,000 rows, dynamic dogma at most 1,000 attributes and 1,000 effects, and doctrine analytics retains the wrapper's 2 MiB/32-level/50,000-node response limits plus at most 100 example modules per projected cluster.
- project update checks are outside the startup/health critical path. They use one process-wide 15-minute cache, coalesce concurrent checks, cap the response at 64 KiB, time out after five seconds, and degrade to an informational unavailable state.

### Context compaction

- Per-thread history is compacted so old messages are summarized (not silently lost) as the conversation grows. The limit is `autoCompactLimit()` = 90% of `OPENAI_MODEL_CONTEXT_WINDOW` (default 200k → 180k), or `min(OPENAI_COMPACT_THRESHOLD, 90%)` when the override is set.
- Two triggers: a mid-turn backstop fires when a single model call's real input (`response.usage.input`) reaches the limit; a pre-turn counter tracks context growth. Stateless mode accumulates each turn's peak as a periodic SQLite-summary cadence, while server mode stores the latest chain input size because provider usage already includes the previous chain.
- Compaction keeps the most recent user/assistant messages up to a ~20k-token budget and summarizes everything older into a ≤4k-char structured summary (preserving IDs, numbers, location/ship, and what was already fetched). The keep-window token budget uses a UTF-8-byte-based estimate (`estimateTokens`) so it is honest for Cyrillic (a flat chars/4 under-counted Russian and kept ~2x too much), and the summary is trimmed on a line boundary (`capOnLineBoundary`) so bullets are never cut mid-fact.
- Summarization is incremental (the prior summary is extended, `last_message_id` tracks the boundary) and input-bounded (`COMPACT_MAX_INPUT_CHARS`); anything over budget carries to the next pass rather than being dropped unsummarized. After compaction the counter resets and `previous_response_id` is cleared, forcing a cold rebuild from `[summary + kept recent messages]`.

## Tool Loop Model

- runtime tools are Responses API function tools implemented by this Node.js process.
- in stateless mode, each tool continuation includes the previous `function_call` item plus its matching `function_call_output`.
- in server mode, normal continuations send `previous_response_id` plus only new outputs while an exact in-memory replay remains available until the turn ends.
- third-party hosted MCP descriptors are not serialized into model requests; EVE-KILL is available through local function tools whose bounded arguments are validated before REST or MCP egress.
- doctrine, meta, forensics, and coalition analytics use a fixed-endpoint local wrapper, a 2 MiB response cap, fixed safe error categories, the shared EVE-KILL call budget, and a four-call analytics cap per turn.
- the bounded doctrine facade consumes both the shared EVE-KILL and analytics call budgets; its programmatic family is additionally capped at four calls, `top<=5`, and 20 work units.
- programmatic market-history, system-metric, and dynamic-item facades use only their fixed unauthenticated public ESI operations; their family ceilings are respectively 360 requested history-days, 400 requested system rows, and 40 requested attributes.
- local `skills/` files are maintainer workflow docs and are not required for end-user runtime operation.
- protocol notes: [skills-protocol.md](./skills-protocol.md).

## Failure Model

- if Telegram bot startup fails, health becomes degraded or failed.
- if the configured model endpoint rejects `/responses`, smoke reports `model_responses` failure.
- if stored EVE secrets no longer decrypt under the current auth key, private requests fail closed as relink-required instead of crashing the request handler.
- if a user asks a simple static geography count question, the runtime should stay within local SDE-backed tools; drifting into web or live ESI is treated as a routing failure.
- if ESI pagination changes during collection, the request fails instead of silently truncating.
- if EVE-KILL search is unavailable, or the route handoff cap is reached before baseline validation, route planning returns an unknown/error result and does not present zero kills as proof of safety or set autopilot. A later handoff cap backpressures the durable feed instead of dropping the event.
- if an active feed listener or active-platform chat delivery fails transiently, the event cursor remains unchanged; already accepted recipients are skipped by durable dedup on retry. Definitive recipient rejections are terminally acknowledged and do not block other consumers. Consumers for an unconfigured platform are suspended and cannot poison active-platform delivery.
- if first-start feed bootstrap cannot reach EVE-KILL, route monitors are not restored early. The poller retries with bounded backoff and invokes restoration only after a durable head exists.
- if an official heartbeat killmail detail or outbound send fails, heartbeat state remains at the prior cursor and the finding is retried on a later scheduled run.
- if required auth state expires, callback flows fail closed.
- if enabled-chat ingress exceeds the configured recent-rate or global active ceiling, the request is rejected early with a retry-later message instead of consuming more model or ESI capacity.
- if a programmatic batch is malformed, unlinked, mixed-family, duplicate, incoherent, over four calls, or over its family work ceiling, the entire batch is rejected before any external call dispatches; a partial program cannot waive its minimum completion shape.
- if a bounded facade receives structural drift, conflicting duplicates, non-finite data, or an oversized result, it returns a fixed sanitized error instead of a partial or sliced success.

## Operational Checks

- `GET /health`
- `npm run smoke`
- `npm run test`
- `npm run typecheck`
- `npm run lint`
- `npm run smoke:eve-tool -- --public-source-matrix`
- `OPENAI_PROGRAMMATIC_TOOL_CALLING=true npm run smoke:eve-tool -- --programmatic-matrix`

## ESI Notes

- `X-Pages` pagination treats `Last-Modified` as the page-set snapshot signal and fails closed if later pages disagree.
- page-local `ETag` differences do not by themselves invalidate a paginated collection.

## Known Reliability Risks

- no separate background worker means long-running synchronous work can still contend with the main process.
- feed delivery can repeat across the send/SQLite-commit crash boundary; consumers and operators must treat duplicate notifications as an allowed at-least-once outcome.
- docs do not yet have mechanical freshness checks.
- production operation still depends on each self-hosting operator's process supervision, backups, and secret handling.
- Chat-ingress abuse controls are intentionally in-memory because the app is single-process; they do not coordinate across multiple app instances.
