# EVE Agent

## Goal

Build a single-user EVE Online agent with:

- Telegram input via grammY (long polling)
- EVE SSO for private data access
- ESI access via ocli CLI wrapper (not hundreds of tools)
- Local SDE index from JSON Lines
- SQLite storage via better-sqlite3
- Fastify only for EVE SSO callback + health

## Hard rules

- No Redis
- No Postgres
- No image features
- No raw shell access from model-facing code
- No webhooks for Telegram (use long polling)
- No multi-user support
- All ESI access must go through the `safe_exec_ocli` wrapper
- All private ESI requests must check scopes via `get_eve_capabilities` first
- Model never sees tokens, refresh logic, rate-limit handling, or pagination internals
- Keep the codebase simple and single-process
- TypeScript strict mode everywhere

## Stack

| Component        | Library / Tool       | Purpose                              |
| ---------------- | -------------------- | ------------------------------------ |
| Runtime          | Node.js + TypeScript | Main platform                        |
| Telegram         | grammY               | Bot framework, long polling          |
| HTTP server      | Fastify              | EVE SSO callback + /health only      |
| Database         | better-sqlite3       | All persistence                      |
| ESI CLI          | openapi-to-cli       | Runtime CLI from EVE OpenAPI spec    |
| OpenAPI helpers  | kin-openapi          | Spec validation/patching if needed   |
| AI model         | GPT-5.4 via OpenAI   | Agent reasoning                      |

## Architecture overview

```
Telegram user
   |
grammy bot (long polling)
   |
Agent runtime (planner -> executor -> replanner -> finalizer)
   |
tools: safe_exec_ocli | query_sde | get_eve_capabilities | update_plan
   |
infra: EVE SSO service | ocli gateway | SQLite | SDE local index
```

Single process. No workers. No queues. No event bus.

## 4 tools the model sees

1. **safe_exec_ocli** -- search, help, run ESI commands through whitelisted ocli profiles
2. **query_sde** -- query local static data index (types, groups, regions, blueprints, etc.)
3. **get_eve_capabilities** -- check current character binding, scopes, allowed profiles
4. **update_plan** -- store/update execution plan for multi-step requests

## 10 ocli profiles

- `eve-public` -- universe, status, routes, dogma, alliances, wars, sovereignty, public contracts, FW, public industry
- `eve-character` -- info, skills, location, clones, contacts, standings, fittings, killmails, notifications, bookmarks, search
- `eve-wallet` -- balance, journal, transactions
- `eve-assets` -- assets, locations, names
- `eve-market` -- regional orders/history, character orders, structure market
- `eve-industry` -- jobs, blueprints, mining, PI, public facilities
- `eve-contracts` -- character contracts, bids/items, public contracts
- `eve-mail` -- inbox, labels, mailing lists
- `eve-corp` -- members, roles, structures, starbases, wallets, assets, contracts, industry, blueprints
- `eve-ui` -- autopilot waypoints, open in-game windows

## SQLite tables

- `telegram_sessions` -- chat_id, username, last_seen_at
- `agent_threads` -- thread_id, chat_id, created_at, updated_at
- `messages` -- id, thread_id, role, content, created_at
- `eve_accounts` -- character_id, character_name, access_token, refresh_token, expires_at, scopes_json
- `plans` -- request_id, goal, status, created_at, updated_at
- `plan_steps` -- request_id, step_id, title, kind, status, depends_on_json, notes
- `sde_meta` -- build_number, loaded_at

## HTTP routes (Fastify)

- `GET /auth/eve/start` -- redirect to EVE SSO
- `GET /auth/eve/callback` -- handle OAuth callback, store tokens
- `GET /health` -- liveness check

## Telegram commands

- `/start` -- greeting
- `/eve-login` -- returns EVE SSO login link
- `/whoami` -- shows bound character
- `/reset` -- clears session/thread

## Definition of done

- [ ] Telegram bot accepts text and replies via agent
- [ ] EVE SSO login works end-to-end
- [ ] Public ESI requests work through ocli
- [ ] Private ESI requests work after auth with scope checks
- [ ] SDE lookups work for types, groups, regions, blueprints
- [ ] No secrets leaked in logs or model output
- [ ] Tests pass (unit + integration)

## What we do NOT build

- Telegram webhooks
- Multi-user
- Admin panel
- Image features
- Market analytics pipeline
- Background jobs
- Caching worker
- Role/ACL system
- Separate frontend
