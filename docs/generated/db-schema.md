# Database Schema

Generated from `src/db/schema.ts` on 2026-07-13. Runtime migrations in
`src/db/migrations.ts` may add operational tables to an existing database.

## Identity, chat lanes, and SSO

- `users`
- `telegram_accounts`
- `discord_accounts`
- `discord_sessions`
- `auth_requests`
- `telegram_sessions`

## Agent Memory

- `agent_threads`
- `messages`
- `thread_summaries`
- `thread_artifacts`
- `plans`
- `plan_steps`

## Scheduled and user intelligence

- `heartbeat_config`
- `intel_notes`

## EVE and Cache

- `eve_accounts`
- `eve_character_links`
- `esi_cache`

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
