# Database Schema

Generated from `src/db/schema.ts` on 2026-07-27. Runtime migrations in
`src/db/migrations.ts` may add operational tables to an existing database.

## Identity, chat lanes, and SSO

- `users`
- `telegram_accounts`
- `discord_accounts`
- `discord_sessions`
- `cli_accounts`: explicit singleton owner for the collision-free local CLI lane (`chat_id = 0`)
- `auth_requests`: one-time login state plus versioned consent language, time,
  and the exact requested ESI scope set
- `telegram_sessions`

## Agent Memory

- `agent_threads`: canonical lane state plus an optional stored Response id and
  the exact assistant-message id that anchors it
- `messages`
- `thread_summaries`
- `thread_artifacts`
- `plans`
- `plan_steps`

## Scheduled and user intelligence

- `heartbeat_config`
- `intel_notes`

## EVE-KILL feed and route operations

- `eve_kill_feed_state`: one global durable sequence cursor plus dedup-prune timestamp
- `eve_kill_notification_dedup`: accepted `(chat_id, killmail_id)` deliveries
- `eve_kill_migrations`: one-time integration cleanup markers
- `kill_watches`: system, region, victim, and attacker subscriptions
- `route_monitors`: restart-restorable route monitor state
- `route_monitor_kill_dedup`: `(chat_id, monitor_started_at, killmail_id)` feed idempotency for one monitor run across concurrent callbacks and process restart
- `route_ganker_cache`: recent public attacker observations

## EVE and Cache

- `eve_accounts`: encrypted EVE tokens, granted scopes, and the durable consent
  version/language/time for the active authorization
- `eve_character_links`
- `esi_cache`

## Market

- `market_price_history`: local daily price history per `(region_id, type_id, date)`
  accumulated from ESI; rows are never deleted, so the series outlives ESI's own
  ~365-day window
- `market_history_sync`: per-pair backfill state (`next_due_at`, status, error)
  driving the market history worker
- `market_watchlist`: per-user watched types; `region_id` is always stored as a
  concrete value (writers substitute the user's default region when it is
  omitted) because the primary key treats NULL as distinct and would let
  duplicates through
- `market_price_alerts`: one-shot price alerts evaluated against the local
  `market_orders` snapshot; firing flips `status` to `triggered`
- `market_alert_events`: append-only alert firing log; `delivered_at` flips once
  the outbound lane pushed the notification

## Static Data

- `sde_meta`
- `sde_raw_records`
- `sde_types`
- `sde_groups`
- `sde_categories`
- `sde_market_groups`
- `sde_meta_groups`
- `sde_dogma_attributes`
- `sde_dogma_units`
- `sde_dogma_effects`
- `sde_type_dogma`
- `sde_type_bonus`
- `sde_type_materials`
- `sde_certificates`
- `sde_masteries`
- `sde_factions`
- `sde_races`
- `sde_regions`
- `sde_constellations`
- `sde_systems`
- `sde_stations`
- `sde_npc_corporations`
- `sde_stargates`
- `sde_blueprints`

## Source

Canonical schema definition: [`src/db/schema.ts`](../../src/db/schema.ts).
