# EVE-KILL v1 Integration

Status: active
Verified against code: 2026-07-15

The app uses the current public EVE-KILL REST API at the fixed base
`https://api.eve-kill.com/` and its durable `/feed/poll` transport. The
upstream reference is [eve-kill.com/docs](https://eve-kill.com/docs).

## Source Ownership

| Source | Owned data |
| --- | --- |
| Official CCP ESI | identity and affiliation, character history, wars, private rosters, authenticated recent killmail references, official `(id, hash)` killmail detail, live location, and market data |
| Installed local SDE SQLite snapshot | universe topology, systems, regions, types, groups, dogma, blueprints, materials, gates, and static labels |
| EVE-KILL | arbitrary public kill discovery, public aggregates, battle clustering, observed killboard membership, public hash discovery, value/fitting enrichment, and the global public feed |

EVE-KILL observations are third-party and may be incomplete. They never replace
official ESI for linked-character/private flows or local SDE for static data.
Observed membership is explicitly non-authoritative and carries its source,
window, coverage, and truncation limits.

## REST Client

`src/eve-kill/client.ts` owns all requests. Runtime configuration does not
expose a base-URL override. The client provides:

- bounded timeout, retry, exponential backoff, and response-size limits;
- schema-versioned SQLite cache keys;
- runtime validation for summary, ESI-shaped, detail, feed, stats, and battle payloads;
- explicit normalization into source-neutral internal killmail types;
- local caps, deterministic sort, killmail-ID deduplication, and truncation metadata.

Search behavior is deliberately stricter than the upstream:

- each `POST /killmails/search` window is at most seven days;
- each ID filter is chunked to at most 15 values;
- no request sends more than three filter categories;
- `after` cursors must advance and cannot repeat;
- list endpoints use backward `before` pagination where supported;
- merged windows/pages are capped locally even if the server returns too much.

Coordinates from the third-party ESI-shaped response are not trusted for route
gate attribution. `route-snapshot.ts` uses official CCP ESI only when an exact
`(killmail_id, killmail_hash)` pair is available and reads
`victim.position`. Participant names are batch-resolved through official ESI;
type and group labels come from the local SDE. EVE-KILL detail supplies value
and fitting enrichment.

## Agent Tool Surface

The deferred `eve_kill` namespace contains exactly six local tools:

| Tool | Purpose |
| --- | --- |
| `kill_search` | explicit-window public killmail discovery |
| `kill_activity` | observed system/entity kills, losses, or combined activity; dual-role entity rows are tagged `all` |
| `kill_detail` | value/detail, observed fitting, or non-authoritative hash discovery |
| `kill_intel` | character aggregates, public intel, and leaderboards |
| `kill_battles` | list or inspect EVE-KILL battle clusters |
| `kill_watch` | manage system, region, victim, and attacker feed alerts |

`kill_activity_summary` is a separate top-level public facade. It requires one
explicit system/character/corporation/alliance ID and a canonical UTC window no
longer than seven days, examines at most 100 deduplicated observations, and
returns only role/value aggregates, coverage, freshness, and one-to-ten newest
evidence killmail IDs. It never returns hashes, participants, ships, items,
fits, positions, raw kill arrays, pages, cursors, request counts, retries, or
response bodies. System scope has no attacker/victim split and therefore uses
`activity=all`.

The facade is directly callable. With the default-off Programmatic Tool Calling
feature enabled, a hosted program may compare two-to-four public targets or
non-overlapping windows with `evidence_limit <= 5`; the application still
enforces exact caller linkage, one tool family, a four-call/400-observation
ceiling, and fixed schema-valid output. The original `kill_activity` and all
other raw/detail/analytics/watch tools remain direct-only. The source is always
non-authoritative EVE-KILL observation; search cache freshness is bounded at 90
seconds and coverage may be incomplete.

`doctrine_summary` is a second top-level public facade over the local
`doctrine_detect` wrapper. It accepts only one already-resolved public
corporation/alliance ID, an explicit canonical window of at most 366 days, and
`top` (`1..10` direct, `1..5` programmatic). The application reconstructs the
fixed upstream arguments with rookie ships excluded; callers cannot select a
generic analytics method, character scope, implicit window, arbitrary URL, or
cluster threshold.

The facade validates the wrapper provenance plus upstream entity, window,
cluster count, unique 64-character family hashes, timestamps, finite values,
ship fields, and bounded example structure before projecting any value. Output
preserves upstream rank order and contains only entity/window/freshness,
bounded doctrine classification, loss/value aggregates, and one evidence
killmail ID per row. Entity/example URLs, module lists, raw clusters, transport
data, and unrecognized analytics fields are excluded. Structural drift or an
over-12,000-character result becomes a fixed schema-valid error, never a
partial success.

With Programmatic Tool Calling enabled, one doctrine program compares two to
four distinct corporation/alliance targets using exactly the same `from`, `to`,
and `top`; the family ceiling is 20 requested rows. These calls also consume
the shared EVE-KILL turn budget and the existing four-call analytics ceiling.
Raw `doctrine_detect` and every other analytics method remain direct-only.

The namespace intentionally does not expose competing identity, affiliation,
history, roster, war, static-data, market, build-cost, arbitrary-query, or
private-character operations. Official detail is still resolved by
`src/eve/killmail.ts` through CCP ESI after `(id, hash)` discovery.
The interactive terminal CLI receives `kill_watch` and `route_monitor` because
it owns a real feed-poller lifecycle and explicit `chat_id = 0` outbound sender
while open. Heartbeat configuration remains omitted and fails closed: the CLI
does not start the user-addressed heartbeat scheduler. Historical sentinel-lane
cleanup is not reversed; newly created zero-lane watches and monitors persist.

## Durable Global Feed

`src/eve-kill/feed-poll.ts` runs one process-wide poller for watches and route
monitors.

Startup ordering closes the feed/baseline gap:

1. With no cursor, the poller calls `/feed/poll?after=0`, persists the current
   `latest` head, and emits no historical notifications.
2. The `onReady` hook restores route listeners after that head exists and
   before the first later event is processed.
3. With an existing cursor, route listeners are restored before the first
   resumed poll.
4. Each restored monitor registers its listener before its asynchronous
   one-hour baseline; incoming feed callbacks wait for that baseline.

Events must have strictly increasing sequence IDs. The cursor advances only
after every active in-process listener and every active-platform matching chat
delivery either succeeds or returns a definitive recipient rejection. Telegram
403 and Discord unknown/inaccessible/cannot-DM recipient errors are terminally
acknowledged; rate limits, transport errors, and server failures remain
retryable and keep the cursor unchanged.
Per-chat `(chat_id, killmail_id)` rows prevent already accepted recipients from
being resent when another recipient fails. Delivery is at-least-once across the
network-send/database-commit crash boundary: a send can be repeated, but a
retryable failed send must not be silently skipped. A terminal rejection is
also written to per-chat dedup, so another consumer can continue and that
recipient is not retried for the same killmail.

Only consumers whose chat platform has an active sender participate in a run.
Watches and route-monitor rows for a disabled platform remain durable but are
suspended, cannot hold the global cursor, and do not receive historical replay
when that platform is enabled later. CLI rows therefore resume when the CLI is
next opened, but events missed while it was closed are not replayed.

The poller uses bounded exponential backoff, never resets a valid cursor, prunes
old delivery dedup rows daily, and is awaited during graceful shutdown. Changing
a watch updates SQLite only; it does not reconnect or duplicate the global
poller. A DB-adjacent process lock prevents the bot entrypoint and CLI from
running competing pollers against the same cursor.

Watch topics are:

- `system.<id>`
- `region.<id>` (derived only from local SDE topology; a third-party region
  field is ignored)
- `victim.<character|corporation|alliance|faction id>`
- `attacker.<character|corporation|alliance|faction id>`

## Route Intelligence

`src/eve-board/route-snapshot.ts` builds one bounded one-hour search baseline
for all route system IDs. The route planner summary and briefing consume that
same snapshot. While it is built, a temporary feed listener captures matching
events; on successful autopilot start the snapshot and captured handoff events
are passed to the route monitor. The monitor therefore does not issue a second
baseline request. A captured event remains unacknowledged by the awaited
temporary listener until the permanent monitor listener is registered. A crash
inside that interval therefore leaves the durable global cursor unchanged and
replays the event after restart. The handoff buffer is locally capped; its next
event is rejected rather than acknowledged or dropped.

Kill counts cover the bounded one-hour search result, but ISK value enrichment
is limited to at most three recent killmails per system. Route output therefore
labels the ISK figure as a sample and always shows resolved/total killmail
coverage; it is never presented as the total value of all PvP kills.

For a selected Thera or Turnur shortcut, the one baseline and the permanent
monitor route include the K-space entry leg, the hub system itself, the K-space
exit leg, and the destination. Activity inside the WH hub is therefore not
hidden between the two gate legs.

After startup, the monitor consumes the single global feed. Official ESI remains
responsible for the pilot's live location, online state, recent death reference,
official killmail detail, and system jump counts. Local SDE supplies route,
security, ship, and gate data. If the baseline is unavailable, or the handoff
cap is reached before that baseline completes, route danger evaluation fails
closed and the app does not present zero kills as proof of safety or set
autopilot. A later cap applies feed backpressure rather than dropping activity.
Resumed events older than the one-hour route window are durably acknowledged
but never enriched or promoted into alerts, route stats, pursuit, or the ganker
cache. Feed processing is serialized per monitor. For a current event, the
per-monitor-run dedup marker, ganker-cache update, and stats form one SQLite
transaction; baseline-overlap, concurrent, and post-restart replays are
absorbed without another alert or increment.
If a monitor restored after restart cannot rebuild this baseline, restoration
stops explicitly: the listener is detached, the durable monitor row is removed,
and the user is told to start the route again later. It never remains active
with an empty one-hour history.

## OSINT And Local Analysis

OSINT uses explicit non-overlapping search windows and derives attacker/victim
roles locally from normalized killmails. Its coverage object reports the
requested window, request count, source errors, result cap, and truncation.
Corp/alliance membership inferred from kill activity is labeled observed and
non-authoritative.

The local-character analyzer gets character names and affiliations from ESI,
then batches public character stats through EVE-KILL. Missing stats remain
`unknown`; they are not converted to a low-risk answer.

## MCP Analytics

The EVE-KILL MCP descriptor is not exposed directly to model turns. Full agent turns can
contain chat history, linked-character context, fits, and private ESI results;
with a direct hosted descriptor, the remote call can execute before application
code can inspect its arguments. Post-response validation therefore cannot be a
pre-egress privacy boundary.

Ordinary access uses the local `eve_kill` REST namespace. Four additional
methods are available through the local deferred `eve_kill_analytics` namespace:
`doctrine_detect`, `meta_pulse`, `killmail_forensics`, and `coalition_graph`.
The application accepts only allowlisted public numeric CCP IDs, canonical
timestamp pairs, enums, booleans, and bounded limits, reconstructs a fresh
argument object, then sends one fixed `tools/call` JSON-RPC request to
`https://mcp.eve-kill.com/mcp`. Names must be resolved to IDs through the local
ESI universe-reference namespace first. No chat history, profile, fit, private
ESI result, credential, user/chat ID, or generic URL can cross this boundary.
Remote errors are reduced to fixed local categories, and analytics calls share
the EVE-KILL per-turn budget with an additional four-call analytics cap.
The top-level `doctrine_summary` facade uses this same transport but adds a
stable, narrow output contract and fail-closed upstream-drift validation; it
does not make the remote MCP descriptor or raw analytics payload programmatic.

## Configuration

```env
EVE_KILL_TIMEOUT_MS=8000
EVE_KILL_USER_AGENT=EVEAI/3.3 (+https://github.com/example/eveai; contact=operator@example.com)
EVE_KILL_RETRY_MAX_ATTEMPTS=3
EVE_KILL_BACKOFF_MAX_MS=10000
```

Cache lifetimes are fixed per endpoint in the client contract; there is no
global TTL override that would misleadingly change all response classes alike.
Timeout and backoff controls must be positive and are hard-capped at 60 seconds;
retry attempts are hard-capped at five.

## Persistence

| Table | Purpose |
| --- | --- |
| `eve_kill_feed_state` | global durable sequence cursor and dedup-prune timestamp |
| `eve_kill_notification_dedup` | accepted per-chat killmail deliveries |
| `kill_watches` | durable public feed topics |
| `route_monitors` | active route-monitor state |
| `route_monitor_kill_dedup` | per-monitor-run feed idempotency across concurrency and restart |
| `route_ganker_cache` | recent public attacker observations |

## Files

| File | Purpose |
| --- | --- |
| `src/eve-kill/client.ts` | defensive REST contract and pagination |
| `src/eve-kill/normalize.ts` | runtime validation and normalization |
| `src/eve-kill/feed-poll.ts` | global durable feed and watch matching |
| `src/eve-kill/watch.ts` | watch CRUD |
| `src/eve-kill/tools.ts` | six-tool raw namespace plus the bounded summary descriptor |
| `src/eve-kill/activity-summary.ts` | strict public summary validation and deterministic aggregation |
| `src/eve-kill/executor.ts` | validated tool execution and provenance projection |
| `src/eve-kill/analytics-tools.ts` | four strict deferred local analytics schemas |
| `src/eve-kill/mcp-analytics.ts` | validated fixed-endpoint MCP JSON-RPC transport |
| `src/eve-kill/doctrine-summary.ts` | bounded doctrine projection, drift validation, and direct/programmatic limits |
| `src/eve-board/route-snapshot.ts` | shared route baseline and official position/name enrichment |
| `src/eve-board/monitor.ts` | feed-driven route monitoring |
