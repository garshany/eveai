# EVE-KILL & Kill Tracking

## Data Sources

| Source | What | How | Delay |
|---|---|---|---|
| **zKillboard R2Z2** | Real-time kill stream (all EVE kills) | HTTP sequential polling | 2-5 min |
| **zKillboard REST** | Kills by system/entity/ship | GET `/kills/systemID/{id}/` | 1-3 min |
| **ESI** | Kill details, system stats, character location | Official CCP API | 30-60s |
| **EVE-KILL REST** | killmail/{id}, battles, stats | eve-kill.com/api/ | varies |

### zKillboard R2Z2 (primary kill stream)

Official zKB kill feed. WebSocket deprecated, RedisQ sunset May 2026.
Docs: https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)

```
GET https://r2z2.zkillboard.com/ephemeral/sequence.json → { sequence: 96724333 }
GET https://r2z2.zkillboard.com/ephemeral/96724334.json → full killmail (ESI + zkb)
On 200: sleep 100ms, seq++
On 404: sleep 6s (no new kills)
Rate: 20 req/s max, User-Agent required
```

Used by: `kill_watch` subscriptions (real-time Telegram alerts).
File: `src/eve-kill/zkb-ws.ts` (named for historical reasons, now R2Z2).

### zKillboard REST

```
GET https://zkillboard.com/api/kills/systemID/{id}/pastSeconds/3600/
```

Used by: route planner danger scan, route monitor kill scan.
Requires User-Agent header.

### EVE-KILL REST

`/api/killlist` — does NOT filter by system_id (returns global kills). Broken.
`/api/killmail/{id}` — works, returns enriched killmail.
`/api/battles`, `/api/stats?dataType=` — work.
Most other endpoints (query, characters, prices, search) — 404 on live.

## Architecture

### eve_kill namespace (9 deferred tools)

```
eve_kill namespace
├── kill_feed      — recent kills by system/entity/ship (zKB REST)
├── kill_query     — MongoDB-style search (EVE-KILL /api/query, pending deploy)
├── kill_stats     — stats, rankings, leaderboards (EVE-KILL /api/stats)
├── kill_battles   — battle reports (EVE-KILL /api/battles)
├── kill_entity    — entity details, history, members, coalition
├── kill_lookup    — killmail by ID, search, wars, factions
├── kill_spatial   — kills near celestial/coordinates
├── kill_prices    — build cost, market prices
└── kill_watch     — subscribe to real-time kill alerts
```

### Kill Watch System

User subscribes via prompt → `kill_watch` tool → saves to `kill_watches` DB.
R2Z2 poller processes global kill stream, matches against watches, sends Telegram.

```
User: "Следи за системой Uedama"
  → kill_watch(action=watch, topic_type=system, topic_id=30002768)
  → INSERT kill_watches (chat_id, topic='system.30002768', label='Uedama')

R2Z2 poll loop (every 100ms-6s):
  → GET /ephemeral/{seq}.json
  → kill has solar_system_id=30002768?
  → SELECT chat_id FROM kill_watches WHERE topic='system.30002768'
  → bot.sendMessage(chatId, "🔴 Kill in Uedama: Bestower (500M ISK)")
```

### Route Intelligence (eve-board)

```
src/eve-board/
├── monitor.ts    — 15s location, 60s hybrid route scan, 60s online check, 2m digest
├── analytics.ts  — jump spike detection, gate kill attribution, threat digest
├── threat.ts     — EHP calc, gank fleet detection, threat scoring
├── route-snapshot.ts — shared selected-route snapshot for one-shot route output
├── advisor.ts    — deterministic digest formatting, focused LLM route intel, pursuit detection
├── briefing.ts   — pre-route briefing + post-route report
└── types.ts      — RouteMonitor, SystemSnapshot, RouteThreatDigest, PursuitSignal

Auto-starts on autopilot. Current route flow:
  1. `plan_route` builds route variants and returns a compact, selected-route-first route summary instead of a merged danger dump.
  2. The selected-route top block and appended pre-flight briefing are derived from one shared selected-route threat snapshot, so `киллов/ч`, `zKB срез`, `Сейчас`, `Впереди`, `Анализ`, and `Последние киллы` agree on the same kill set.
  3. `generateBriefing()` formats that snapshot around `Маршрут`, `Корабль`, `Сейчас`, `Впереди`, `Действие`; direct briefing generation also uses the same `route-snapshot` scan path.
  4. `monitor.ts` starts only when autopilot is actually active, then tracks pilot location, scans the full selected route every cycle, and keeps route watches subscribed in R2Z2.
  5. Live kill scanning uses ESI `system_kills` as a prefilter, then zKB REST for the systems that matter.
  6. Newly observed killmail IDs are deduplicated per monitor session before they affect `killsSeen`, ganker cache updates, or digest deltas.
  7. Live monitor enriches recent killmail IDs with EVE-KILL batch lookups so real kill positions reach `analytics.ts`; gate attribution is based on actual coordinates instead of a dead placeholder path.
  8. Digest delta checks compare unique kill growth, threat changes, pilot movement, pursuit state, and the active ganker signature instead of raw repeated scans.
  9. Live digest data is built from jump spikes, gate attribution, kill velocity, and the ganker cache.
  10. Quiet route states stay deterministic; the LLM is used only when the route digest is actionable (for example fresh gate activity, high/critical threats, pursuit, or moving gankers).
  11. The periodic ESP digest shares the same action-oriented contract as pre-flight: `Сейчас`, `Впереди`, `Действие`, with deterministic quiet-state output and LLM reserved for actionable route situations.
  12. If the route is still actionable (`overallThreat != LOW`, active gankers, gate activity, jump spikes), the monitor re-sends an ESP heartbeat digest every ~6 minutes even when no new delta event fired, so Telegram does not degrade into raw kill alerts only.
  13. Alternative routes, traffic comparisons, and long kill details stay secondary layers; the primary UX is always the chosen route and the pilot's next action.
```

## Config

```env
# EVE-KILL REST
EVE_KILL_BASE_URL=https://eve-kill.com/api/
EVE_KILL_TIMEOUT_MS=8000
EVE_KILL_CACHE_TTL_SECONDS=300

# zKillboard (REST + R2Z2)
ZKILL_BASE_URL=https://zkillboard.com/api/
ZKILL_TIMEOUT_MS=8000
ZKILL_USER_AGENT=EVEAIBOT/1.0 (garshany80@gmail.com)
```

## DB Tables

| Table | Purpose |
|---|---|
| `kill_watches` | Per-user topic subscriptions (system/character/region) |
| `kill_watch_state` | Last seen killmail_id per topic |
| `route_monitors` | Active route monitor state |
| `route_ganker_cache` | Known active gankers from kill scans |

## Testing Prompts

### Kill Watch
- `Следи за системой Uedama` → subscribe system kills
- `Следи за системой Jita` → subscribe
- `Какие у меня подписки?` → list watches
- `Убери подписку на Jita` → unsubscribe
- `Убери все подписки` → clear all

### Kill Feed
- `Какие киллы сейчас в Uedama?`
- `Покажи последние потери Goonswarm`
- `На каких фитах теряют Ishtar?`

### Route Intelligence
- `Построй маршрут до Jita и включи автопилот` → route + briefing + monitor
- `Статус мониторинга маршрута` → monitor status
- `Останови мониторинг` → stop monitor

Pre-flight briefing for `plan_route` should stay operational:
- selected-route summary should show a compact `zKB срез` for the chosen route, or explicitly say that fresh killmails were not found
- selected-route summary and appended briefing must come from one shared snapshot, not two independent rescans
- top block: `Сейчас`, `Впереди`, `Действие`
- support block: `Активность`, short `Анализ`, and several `Последние киллы` from the selected route
- only killmails whose actual `killmail_time` is still inside the briefing window should influence this snapshot; stale zKB rows must be dropped
- destination-local activity should be treated as arrival intel, not as the nearest transit threat ahead
- live monitor keeps ESP/digest updates separate from the one-time pre-flight snapshot
- live gate-camp output must depend on real killmail coordinates reaching `attributeKillsToGates()`, not on LLM wording alone

### Other kill tools
- `Найди киллы дороже 10 миллиардов` → kill_query
- `Покажи серверные лидерборды` → kill_stats
- `Какие крупные битвы были?` → kill_battles
- `Покажи детали килла 134392363` → kill_lookup
- `Сколько стоит построить Dominix?` → kill_prices

## Files

### src/eve-kill/

| File | Purpose |
|---|---|
| `zkb-ws.ts` | R2Z2 kill stream poller (primary real-time source) |
| `watch.ts` | Kill watch CRUD (DB operations) |
| `client.ts` | EVE-KILL HTTP client + cache |
| `tools.ts` | 9 tool definitions in eve_kill namespace |
| `executor.ts` | Tool call router |
| `feed.ts` | kill_feed handler (zKB REST) |
| `kill-query.ts` | kill_query handler |
| `intel.ts` | kill_stats/battles/entity/lookup/spatial/prices |
| `query.ts` | MongoDB filter builder |
| `types.ts` | TypeScript types |
### src/eve-board/

| File | Purpose |
|---|---|
| `monitor.ts` | Route monitor: full-route hybrid scan, kill dedupe, jumps, ganker cache, R2Z2 auto-watch |
| `analytics.ts` | Jump spike detection, gate kill attribution, kill velocity, threat digest |
| `threat.ts` | Threat assessment (EHP, gank detection, scoring) |
| `route-snapshot.ts` | Shared selected-route scan used by one-shot route summary and briefing |
| `advisor.ts` | Deterministic digest formatter, focused LLM intel, pursuit detection, stop/wait/go recommendations |
| `briefing.ts` | Pre-route briefing with route analysis and recent kills + post-route report |
| `types.ts` | Route intelligence types (SystemSnapshot, RouteThreatDigest, PursuitSignal) |
