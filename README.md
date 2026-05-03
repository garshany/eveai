<p align="center">
  <img src="https://img.shields.io/badge/EVE%20Online-AI%20Assistant-1a1a2e?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2ZmZmZmZiI+PHBhdGggZD0iTTEyIDJMMyA3djEwbDkgNSA5LTVIN0wzLTVWN2w5LTV6Ii8+PC9zdmc+&logoColor=white" alt="EVE AI" />
  <img src="https://img.shields.io/badge/Telegram-Bot-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
  <img src="https://img.shields.io/badge/GPT--5.5-Responses%20API-412991?style=for-the-badge&logo=openai&logoColor=white" alt="GPT-5.5" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/github/v/tag/garshany/eveai?style=for-the-badge&label=release&color=green" alt="Release" />
</p>

# EVE AI Agent

Telegram-first AI assistant for EVE Online. Ask questions in natural language, get answers backed by live ESI data, local SDE, zKillboard, and market feeds. Multi-user, multi-character, with background monitoring.

**[@Eveagentai_bot](https://t.me/Eveagentai_bot)** | **[eveonline-ai.ru](https://eveonline-ai.ru)**

---

## What It Can Do

### Character & Account (via EVE SSO)
- Skills, training queue, attributes, implants
- Wallet balance, journal, transactions
- Assets: search across stations, hangars, ships
- Mail: read, send, manage
- Market orders & contracts
- Industry: manufacturing, research, jobs
- Planetary Interaction: extractor & factory status
- Location, current ship, online status
- Fittings, calendar, contacts, notifications
- Killmails: kills & losses with zKillboard links

### Universe (public, no auth needed)
- System, region, constellation info with security status
- Route planning with real-time danger analysis (kills, gate camps, ISK lost)
- Thera/Turnur wormhole shortcut routes via EVE-Scout
- Market prices across regions, buy/sell spread, volume
- Ship & module stats via dogma attributes (DPS, tank, speed, cap, fitting)
- Blueprint materials, manufacturing time, invention
- Incursions, Faction Warfare, sovereignty, wars

### PvP Intel & Analysis
- **EVE-KILL**: kill feed, PvP stats, entity stats, battle reports
- **D-Scan / Fleet / Local parser**: paste any scan, get AI tactical intel (doctrine detection, threat assessment, counter-strategies)
- **OSINT home detection**: 8-layer profiling to detect residence/staging systems
- **Intel notebook**: persistent personal notes with tags (hostile, friendly, structure, wormhole, route, market)
- Fit research from kill data (observed fits, not theorycrafting)

### Wormhole Navigation (EVE-Scout)
- WH-aware routing through Thera/Turnur shortcuts
- Active WH connections (signatures) from Thera/Turnur
- Metaliminal storms and space oddities
- WH type encyclopedia (mass, lifetime, source/target classes)
- WH system search by J-code or class
- Nearest highsec from any null/low/WH system

### Corporation (with roles)
- Members, roles, titles
- Corporate wallet & assets
- Structures and their status
- Corporation contracts & industry

### Background Monitoring (Heartbeat)
- New mail, contracts, killmails
- Skill queue completion
- Wallet changes > 10M ISK
- Market orders filled/expired
- War & structure alert notifications
- PI extractor stalls
- Configurable intervals per user (5 min to 7 days)

### General Knowledge
- EVE mechanics from built-in knowledge + web search
- Fit building and analysis with real dogma stats
- Ship-aware tactical context (live EHP, align time, active fitting)
- Route planning with autopilot integration and gate camp detection
- Any question — EVE or not

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI Model | GPT-5.5 via OpenAI Responses API (WebSocket transport) |
| Bot Framework | grammY (Telegram long polling) |
| Web Server | Fastify (auth, dashboard, health) |
| Database | SQLite (better-sqlite3) — single file, zero ops |
| Static Data | EVE SDE — 51K items, 8.5K systems, 2.8K dogma attributes |
| Live Data | ESI (OAuth2, ETag caching, bounded retries) |
| PvP Data | zKillboard API with ESI killmail enrichment |
| Frontend | React + Vite (landing, dashboard) |
| Auth | EVE SSO (JWT), Telegram Web Auth |
| Language | TypeScript strict mode, ES modules |
| Runtime | Node.js 20+ single process |

---

## Connected APIs & Data Sources

| API | Usage | Transport |
|-----|-------|-----------|
| **EVE ESI** | 100+ endpoints — character, corp, market, universe, industry, fleet | REST, OAuth2, ETag cache |
| **EVE SSO** | Character auth, JWT validation, token refresh | OAuth2 PKCE |
| **EVE-KILL** | Kill feed, PvP stats, entity stats, battle reports | REST, WebSocket |
| **EVE-Scout** | WH navigation — Thera/Turnur routes, signatures, storms, WH types | REST |
| **zKillboard** | Kill feed, PvP stats, fit research | REST, ESI enrichment |
| **OpenAI Responses API** | GPT-5.5 model, tool calling, prompt caching | WebSocket (sticky routing, prewarm) |
| **EVE SDE** | Static game data — items, ships, systems, blueprints, dogma | Local SQLite |
| **Telegram Bot API** | User interaction, message delivery, heartbeat notifications | Long polling |

---

## Architecture

```
Telegram Chat                          Browser
     |                                    |
  grammY bot                        Fastify server
     |                                    |
  Agent Runtime ---- SQLite DB ---- Auth / Dashboard
     |
  +--+--+--+--+--+--+--+
  |  |  |  |  |  |  |  |
 SDE ESI EKL SCT MKT RT OSINT WEB
```

- **SDE** — local SQLite with 51K items, dogma, blueprints, systems
- **ESI** — live EVE API with OAuth2, caching, retries
- **EKL** — EVE-KILL kill feed, entity stats, battle reports
- **SCT** — EVE-Scout WH navigation (Thera/Turnur routes, signatures, storms)
- **MKT** — market orders & prices (batch up to 30 items)
- **RT** — route planner with danger scan and gate camp detection
- **OSINT** — home system inference (8-layer profiling)
- **WEB** — web search fallback

### Hard Constraints

- Single-process Node.js — no workers, queues, Redis, or Postgres
- SQLite only — zero operational overhead
- Telegram long polling only — no webhooks
- Model never sees tokens, refresh flow, pagination internals, or secrets
- Private ESI access gated by `get_eve_capabilities`
- Static data from SDE, live data from ESI — never mixed

---

## Agent Tools (14 active + 176 deferred)

The model sees **14 full tools** with complete schemas. 176 ESI/EVE-KILL/EVE-Scout functions are hidden behind namespace stubs and loaded on demand via `tool_search`.

**Always available (full schema):**
`sde_sql` `count_universe_objects` `plan_route` `batch_market_prices` `web_search` `update_plan` `get_eve_capabilities` `heartbeat_config` `analyze_scan` `analyze_local` `osint_infer_home` `intel_note` `set_active_fit` `route_monitor`

**Deferred namespaces (resolved via `tool_search`):**

| Category | Namespaces | Endpoints |
|----------|-----------|-----------|
| Character | `eve_character_profile` `skills` `assets` `wallet` `mail` `messaging` `industry` `orders_contracts` `location` `killmails` `contacts` `calendar` `fittings` `notifications` `planets` `research_activity` `search` | 54 |
| Corporation | `eve_corporation_profile` `membership` `wallet` `assets` `industry_contracts` `killmails` `structures` `contacts_standings` `roles_titles` `authenticated_market_structures` | 38 |
| Universe & Public | `eve_universe_types` `celestials` `reference` `eve_public_market_orders` `market_reference` `contracts` `killmails` `wars` `incursions` `sovereignty` `faction_warfare` `dogma` | 62 |
| PvP & Fleet | `eve_kill` `fleet_roster` `fleet_structure` `eve_ui` | 22 |
| Wormholes | `eve_scout` (scout_route, scout_signatures, scout_observations, scout_wormhole_types, scout_systems) | 5 |

---

## Prompt Engineering

Developer prompt optimized per [GPT-5.5 prompting guide](https://developers.openai.com/api/docs/guides/prompt-guidance):

- **Section order**: output_contract first, personality last (primacy/recency)
- **Tool source hierarchy**: SDE > count > market > route > ESI > zKill > web_search
- **Anti-laziness rules**: always verify stats, prices, skills via tools — never from memory
- **Dogma query pattern**: ready-to-use SQL JOIN for ship/module attribute lookup
- **Reasoning strategy**: goal decomposition, data planning, dependency ordering before first tool call
- **Self-correction**: validate tool results for logic errors, completeness, contradictions
- **Proactive enrichment**: auto-enrich with security status, Jita comparison, intel notes
- **Verification loop**: correctness, grounding, format check before every response
- **Dynamic reasoning effort**: low for greetings, medium default, high for complex analysis
- **Prompt size**: ~5K tokens

---

## WebSocket Proxy

Custom Rust proxy for routing through ChatGPT Plus credentials:

- **WS connection pool** per conversation thread (prompt cache key)
- **Prewarm**: `generate=false` request to cache prompt prefix on GPU node
- **Sticky routing**: `x-codex-turn-state` header for same-node affinity
- **Keepalive**: `select!` between requests — answers server pings, detects close
- **Codex-style retry**: on WS error, invalidate + reconnect (not HTTP fallback)
- **Session store**: SQLite chain replay for HTTP fallback when WS exhausted
- **Idle timeout**: 300s (matching Codex), max session age 600s

---

## Quick Start

```bash
git clone https://github.com/garshany/eveai.git
cd eveai
cp .env.example .env   # fill in your tokens
npm install
npm run setup           # download + load SDE data
npm run dev             # watch mode
```

Production:
```bash
npm run build
npm start
```

### Required Environment

```
TELEGRAM_BOT_TOKEN      # from @BotFather
OPENAI_API_KEY          # OpenAI API key or proxy token
EVE_CLIENT_ID           # EVE Developer Portal
EVE_CLIENT_SECRET       # EVE Developer Portal
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME=The Forge
```

### Commands

```bash
npm run build       # client (Vite) + server (tsc)
npm run dev         # concurrent watch mode
npm run check       # typecheck + test + lint
npm test            # vitest
npm run smoke       # env, proxy, app health checks
npm run db:migrate  # run SQLite migrations
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [`AGENTS.md`](./AGENTS.md) | Repo map & hard invariants |
| [`docs/DESIGN.md`](./docs/DESIGN.md) | Documentation structure rules |
| [`docs/PRODUCT_SENSE.md`](./docs/PRODUCT_SENSE.md) | Product intent & non-goals |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Security contracts |
| [`docs/RELIABILITY.md`](./docs/RELIABILITY.md) | Operational reliability |
| [`docs/deployment.md`](./docs/deployment.md) | Production runbook |
| [`docs/heartbeat.md`](./docs/heartbeat.md) | Background monitoring system |
| [`docs/generated/db-schema.md`](./docs/generated/db-schema.md) | SQLite schema reference |

---

## Status

**v2.1.0** — current release. Telegram-first, single-process, GPT-5.5 powered. EVE-KILL + EVE-Scout + OSINT + scan analysis + intel notebook. Dynamic reasoning effort, async I/O, gate camp detection, Thera wormhole shortcuts. [Full changelog](./CHANGELOG.md).
