# EVE-KILL Integration

EVE-KILL (eve-kill.com) — PvP killboard, замена zKillboard. Модуль: `src/eve-kill/`.

## Architecture

```
eve_kill namespace (8 deferred tools)
├── kill_feed      — recent kills by system/entity/ship via /api/killlist
├── kill_query     — MongoDB-style search via /api/query (when deployed)
├── kill_stats     — entity stats, rankings, leaderboards via /api/stats
├── kill_battles   — battle reports via /api/battles
├── kill_entity    — entity details, history, members, coalition
├── kill_lookup    — killmail by ID, sibling, search, wars, factions
├── kill_spatial   — kills near celestial/coordinates
└── kill_prices    — build cost, market prices
```

Route planner danger scan uses `/api/killlist?system_id=X` per system (parallel, pre-enriched).

WebSocket client (`ws.ts`) connects to `wss://ws.eve-kill.com/killmails` — currently blocked by Cloudflare, reconnects every 5 min.

## Live API Status (2026-04-01)

Documented endpoints vs actually deployed:

| Endpoint | Status | Used by |
|---|---|---|
| `/api/killmail/{id}` | 200 | kill_lookup |
| `/api/killlist?system_id=&character_id=&...` | 200 | kill_feed, route planner |
| `/api/battles` | 200 | kill_battles |
| `/api/stats?dataType=...` | 200 | kill_stats |
| `/api/query` (POST, MongoDB-style) | **404** | kill_query (fallback) |
| `/api/characters/{id}` | **404** | — |
| `/api/characters/{id}/stats` | **404** | — |
| `/api/corporations/{id}` | **404** | — |
| `/api/alliances/{id}` | **404** | — |
| `/api/search/{term}` | **404** | — |
| `/api/prices/type_id/{id}` | **404** | — |
| `/api/wars/{id}` | **404** | — |
| `/api/factions/{id}` | **404** | — |
| `wss://ws.eve-kill.com/killmails` | **1006** (Cloudflare) | ws.ts |

Client functions for 404 endpoints exist in `client.ts` — they will work when EVE-KILL deploys them.

## Config

```env
EVE_KILL_BASE_URL=https://eve-kill.com/api/     # REST API
EVE_KILL_WS_URL=wss://ws.eve-kill.com/killmails # WebSocket
EVE_KILL_TIMEOUT_MS=8000
EVE_KILL_CACHE_TTL_SECONDS=300
EVE_KILL_MAX_QUERY_LIMIT=100
EVE_KILL_USER_AGENT=EVEAIBOT/1.0 ...
EVE_KILL_WS_ENABLED=true
EVE_KILL_WS_BUFFER_SIZE=200
```

## Testing Prompts

### kill_feed — recent kills
- `Какие киллы сейчас в Uedama?`
- `Покажи последние потери альянса Goonswarm`
- `На каких фитах теряют Ishtar?`

### kill_query — advanced search
- `Найди киллы дороже 10 миллиардов за неделю`
- `Покажи соло киллы титанов за месяц`

### kill_stats — statistics
- `Какая PvP статистика у CCP Rattati?`
- `Топ кораблей по потерям у Pandemic Horde`
- `Покажи серверные лидерборды — самые дорогие киллы`

### kill_battles — battles
- `Какие крупные битвы были за последнее время?`

### kill_entity — intelligence
- `В каких корпорациях был персонаж Vily?`
- `С кем в коалиции Goonswarm?`

### kill_lookup — lookup
- `Покажи детали килла 134392363`
- `Найди игрока Nicole en Divalone`

### kill_prices — prices
- `Сколько стоит построить Dominix?`

### plan_route — danger scan
- `Построй маршрут до Jita`

## Files

| File | Lines | Purpose |
|---|---|---|
| `types.ts` | 230 | TypeScript types |
| `client.ts` | 370 | HTTP client + cache |
| `query.ts` | 107 | MongoDB query builder |
| `feed.ts` | 210 | kill_feed handler |
| `kill-query.ts` | 140 | kill_query handler |
| `intel.ts` | 230 | kill_stats/battles/entity/lookup/spatial/prices handlers |
| `tools.ts` | 250 | 8 tool definitions in eve_kill namespace |
| `executor.ts` | 65 | Tool call router |
| `ws.ts` | 380 | WebSocket client |
