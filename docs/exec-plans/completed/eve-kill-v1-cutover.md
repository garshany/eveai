# EVE-KILL v1 Clean Cutover

## Problem statement

The runtime still mixed the retired Thessia EVE-KILL contract, direct
zKillboard REST, and R2Z2/WebSocket subscriptions. Several agent tools duplicated
official ESI or local SDE authority, route and OSINT consumers implemented separate
killboard pipelines, and region watches were not represented by the existing
subscription topics. The current EVE-KILL service exposes a different REST
contract, durable poll feed, and an optional remote MCP analytics surface.

## Scope

- Replace legacy killboard clients and transports with current EVE-KILL REST.
- Add one durable global `/feed/poll` cursor and complete watch matching.
- Unify route, monitor, OSINT, and local-analysis consumers.
- Enforce ESI/SDE/EVE-KILL source ownership in the agent tool catalog.
- Add a four-tool deferred hosted MCP analytics supplement to Responses API.
- Update migrations, tests, current documentation, and proof artifacts.

## Boundaries

- No WebSocket/SSE dual transport; `/feed/poll` is the single live path.
- No queue/outbox architecture; delivery is at-least-once with durable dedupe.
- No EVE-KILL fallback for private or capability-gated ESI flows.
- No SDE duplication through REST or MCP.
- No generic hosted MCP tools that accept chat, EFT, fit, private identity, or
  arbitrary search text.
- No hard-DLP claim for direct hosted MCP.

## Implementation steps

1. Freeze `.agent/tasks/eve-kill-v1-cutover/spec.md`.
2. Implement the current REST contract, normalization, search helpers, and
   schema-versioned caching.
3. Add the durable global poller, migration, dedupe state, and complete topic
   matching; remove zKill/R2Z2 lifecycle code.
4. Migrate route, monitor, OSINT, and local-analysis consumers and shrink the
   tool surface to the canonical source boundary.
5. Add the fixed deferred MCP descriptor, output validation, stateless replay,
   fail-closed approval handling, prompt boundary, and safe telemetry.
6. Update tests and current docs, run focused and full checks, perform bounded
   live smoke, package evidence, and obtain fresh independent verification.

## Decision log

- 2026-07-13: selected `/feed/poll` over WebSocket/SSE for restart-safe cursor
  recovery in the existing single-process SQLite architecture.
- 2026-07-13: selected a clean cutover with no zKill compatibility layer.
- 2026-07-13: selected four hosted MCP tools only: doctrine, meta, killmail
  forensics, and coalition graph. REST/ESI/SDE remain primary.
- 2026-07-13: accepted structural MCP minimization and explicit prompt policy;
  hard pre-egress DLP would require a separately designed local wrapper.
- 2026-07-13: disabled-platform durable consumers are suspended for that run so
  one unavailable platform cannot hold the shared feed cursor; missed events
  are not replayed when the platform returns.
- 2026-07-13: route feed processing uses both per-monitor serialization and a
  durable per-monitor-run killmail marker committed with stats/ganker state.

## Completion log

- 2026-07-13: repository, current EVE-KILL REST/MCP surfaces, official ESI/SDE
  ownership, and OpenAI hosted-MCP contract audited; acceptance criteria frozen.
- 2026-07-13: legacy REST, zKill, and WebSocket/R2Z2 runtime paths removed; all
  consumers use the fixed EVE-KILL v1 REST/feed boundary.
- 2026-07-13: feed, route, OSINT, local analysis, heartbeat ownership, six local
  tools, and the four-tool deferred hosted MCP supplement implemented and
  documented.
- 2026-07-13: proof-loop verification passed `npm run check` (66 files / 414
  tests), production build, public-artifact audit, diff check, identity-free
  live REST smoke, and independent exact-tree review.

## Superseded decision

- 2026-07-14: the direct hosted MCP supplement was removed after review showed
  that response-time validation happens after remote argument egress. Current
  runtime access is local REST tooling with pre-egress validation; the four
  hosted-only analytics remain unavailable until a local public-only wrapper
  exists. The earlier entries above are retained as the historical decision
  record, not as current runtime documentation.
