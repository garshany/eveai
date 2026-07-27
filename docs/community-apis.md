# Community API integrations

Four agent tools built on community-run EVE services, wired through
`src/community/` (clients, tool schemas) and dispatched in the executor next to
every other tool. All of them are bounded public reads: they take the standard
read-admission permit, count against the per-turn read budget, and degrade to
`{ ok: false, error }` — a community site being down never fails a user turn.

| Tool | Upstream | What it answers |
| --- | --- | --- |
| `industry_cost` | `api.everef.net/v1/industry/cost` | Manufacturing cost breakdown: materials, time, totals ("what does it cost to build X", "build or buy"). |
| `appraise_items` | local SDE + market book; optional Janice | ISK value of a pasted item list (cargo scan, loot, inventory copy). |
| `pilot_intel` | `zkillboard.com/api/stats` | Combat profile aggregates: danger/gang ratios, favourite ships, active hours. |
| `abyssal_market` | `mutamarket.com/api` | Listings for mutated (abyssal) modules — items the regular market cannot price at all. |

## Client behaviour

- One shared budget: `COMMUNITY_API_TIMEOUT_MS` (12 s), `COMMUNITY_API_RETRY_MAX_ATTEMPTS` (3), `COMMUNITY_API_BACKOFF_MAX_MS` (8 s), all clamped in `config.ts`.
- Responses are size-capped at 2 MB and read through a streaming reader — a degraded upstream cannot balloon the process RSS.
- The cache stores **normalized** results only (never raw payloads), bounded to 300 entries; failures are negative-cached for 60 s so a dead upstream is not re-probed with the full retry budget per call.
- Every request carries the operator-identifying `ESI_USER_AGENT` — the same CCP contact rule ESI follows; zKillboard in particular silently rejects anonymous clients.

## Payload shape notes (verified against live responses, 2026-07-27)

- zKillboard `activity` is keyed by **day of week** (`"0".."6"` + `max`/`days`); the inner keys are hours of day. Active hours are summed across days. Favourite ships come from `topAllTime` (`type: 'ship'`), falling back to the recent-week `topLists` block.
- MutaMarket listing price lives in `contract.price` (`contract` is `null` for rows not for sale — those are dropped); `mutated_attributes` rows are flat (`name`/`display_name`, `value`, `base_value`). Listings return cheapest-first, capped at 25.
- EVE Ref's industry payload is passed through as data; EVE Ref versions its own schema.

## Appraisal specifics

The local path is the product: names resolve via the `(name COLLATE NOCASE)`
index on `sde_types` (published types preferred), prices come from the local
`market_orders` book (best sell/buy in the requested region, default The
Forge). Quantities are parsed conservatively — fractions like `1.5` are volume
columns, not quantities, and empty inventory columns never shift the volume
into the quantity slot.

Janice is an optional second opinion: it needs `JANICE_API_KEY`, is only
attached when the requested region is The Forge (Janice prices Jita), and is
called with `persist=false` — a pasted cargo list is the user's private data
and must not be stored on a third-party server.
