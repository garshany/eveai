# Tech Debt Tracker

## Open Items

- Add mechanical checks for docs freshness, cross-links, and coverage.
- Reduce remaining legacy auth compatibility paths once user-based ownership is fully stable.
- Split dense model prompt policy into smaller, source-backed docs plus generated prompt assembly.
- Align package metadata and docs wording where single-user remnants still exist.

## Perimeter: historical gate-camp statistics (researched 2026-07-28, not built)

Perimeter detects camps only inside the live kill index's retention window
(default 3 hours). "This gate is camped every weekday around 19:00" needs a
durable aggregate that does not exist yet. Sources were verified live:

- `POST api.eve-kill.com/killmails/search` — full ESI killmails with
  `victim.position` and attacker corp/alliance; depth confirmed to 13 months.
  Already wrapped by `searchKillmails` (`src/eve-kill/client.ts`).
- `GET api.eve-kill.com/history/:date` — `{killmail_id: hash}` for a whole day,
  back to 2010.
- `data.everef.net/killmails/` — daily `tar.bz2` of the entire cluster, 2007 to
  today−2 days, ~3 MB/day, every record carrying `victim.position`.
- `zkillboard.com/api/history/YYYYMMDD.json.gz` — **dead**: HTTP 200 with a
  93-byte empty body. Do not use.
- **No public per-gate traffic data exists anywhere.** ESI
  `/universe/system_jumps/` is per system, hourly. Kills-per-jump per system is
  the closest honest normalization; the split between gates in a system is not
  recoverable from public data.

Three options, cheapest first: (1) keep what already flows through the feed —
widen the schema and stop sweeping gate kills, costs no extra requests but the
history only starts accruing from switch-on; (2) targeted backfill via
`searchKillmails` — The Forge for 30 days is roughly 150 requests; (3) bulk
backfill from everef archives — every region at once, no API limits, ~2-day
freshness lag and bzip2 work to chunk. Owner picks.

Also missing for this: no long-lived aggregate tables, no persisted hourly
`system_jumps` snapshots, and no `sde_structures`, so camps on citadels cannot
be classified locally.
