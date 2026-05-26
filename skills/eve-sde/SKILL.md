---
name: eve-sde
description: Use for static EVE data such as types, groups, market groups, dogma, universe reference data, and blueprints.
---

## When to use

Any time the user asks about item names, groups, categories, market groups, dogma attributes/effects, regions, systems, stations, or blueprints. This is static reference data, not live API data.

## Workflow

1. Resolve the entity type first (type, group, category, market_group, dogma_attribute, dogma_effect, region, constellation, system, station, blueprint).
2. Use the minimum lookup needed (`by_id`, `by_name`, or `search`).
3. Return normalized IDs and names.
4. Set reasonable `limit` values (default 10, max 50).

## Do NOT use this skill for

- Live wallet data
- Live asset data
- Live market orders
- Any data that changes in real-time

## Entity types available

- `type` -- item types (Tritanium, Rifter, etc.)
- `group` -- item groups
- `category` -- item categories
- `market_group` -- market tree groups
- `dogma_attribute` -- ship/module attributes
- `dogma_effect` -- effects
- `region` -- regions (The Forge, etc.)
- `constellation` -- constellations
- `system` -- solar systems (Jita, etc.)
- `station` -- NPC stations
- `blueprint` -- blueprint data with materials and activities
