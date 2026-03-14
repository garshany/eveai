# EVE Agent Architecture

## Overview

Single-process, single-user EVE Online agent with Telegram as the only input.

```
Telegram (long polling) → grammY bot → Agent Runtime → Tools → ESI/SDE
                                                        ↕
                                                     SQLite
```

## Components

### 1. Telegram Bot Layer (`src/telegram/`)
- grammY with long polling
- Single-user guard via `ALLOWED_TELEGRAM_USER_ID`
- Commands: /start, /eve_login, /whoami, /reset
- Text messages routed to agent runtime

### 2. Agent Runtime (`src/agent/`)
- OpenAI GPT-5.4 with function calling
- Loop: model → tool calls → execute → replanner on failure → feed back → repeat
- Max 10 iterations per request, last 20 messages as context
- 4 tools: safe_exec_ocli, query_sde, get_eve_capabilities, update_plan

### 3. EVE SSO (`src/eve/sso.ts`, `src/web/auth-routes.ts`)
- OAuth 2.0 authorization code flow (confidential client)
- CSRF state stored in `telegram_sessions.oauth_state`, validated on callback
- JWT claims validated: iss, exp, sub format
- Token storage in SQLite, auto-refresh with 60s buffer
- 55 scopes requested covering all 10 profiles

### 4. ESI CLI Layer (`src/eve/ocli.ts`, `src/eve/ocli-setup.ts`)
- Wraps openapi-to-cli v0.1.8 binary
- 10 whitelisted profiles covering ~180 of ~195 ESI endpoints
- Never uses shell (spawn with argv array)
- Adds User-Agent + X-Compatibility-Date headers
- Redacts Bearer tokens and secrets from output
- --api-bearer-token for authenticated profiles

### 5. SDE Layer (`src/eve/sde.ts`, `src/eve/sde-loader.ts`)
- Static data in SQLite tables (11 entity types)
- Downloaded from CCP as JSONL zip (`npm run sde:download`)
- Loaded via streaming JSONL parser (`npm run sde:load`)
- Handles post-Sep-2025 localized name format: `{en: "Tritanium", ru: "..."}`
- by_id, by_name, search lookups with NOCASE indexes

### 6. HTTP Server (`src/web/`)
- Fastify, minimal
- 3 routes: /auth/eve/start, /auth/eve/callback, /health

## 10 ESI Profiles

| Profile | Auth | Endpoints | Coverage |
|---------|------|-----------|----------|
| eve-public | No | ~55 | universe, status, routes, dogma, alliances, wars, FW, public contracts/industry |
| eve-character | Yes | ~29 | info, skills, location, clones, contacts, fittings, killmails, notifications, bookmarks, search |
| eve-wallet | Yes | 3 | balance, journal, transactions |
| eve-assets | Yes | 3 | list, locations, names |
| eve-market | Yes | 9 | regional orders/history, character orders, structure market |
| eve-industry | Yes | 7 | jobs, blueprints, mining, PI, public facilities |
| eve-contracts | Yes | 6 | character contracts, bids/items, public contracts |
| eve-mail | Yes | 9 | inbox CRUD, labels, mailing lists |
| eve-corp | Yes | ~40 | full corp read-only: members, roles, structures, wallets, assets, industry, blueprints |
| eve-ui | Yes | 5 | autopilot waypoints, open in-game windows |

**Total: ~180 of ~195 ESI endpoints covered**

## Data Flow

1. User sends text in Telegram
2. Bot stores message, gets/creates thread
3. Agent runtime loads last 20 messages as conversation history
4. GPT-5.4 decides which tools to call
5. Tool results fed back to model; failures trigger replanner
6. Final text response sanitized (tokens redacted, 4096 char limit)
7. Response sent via Telegram and stored in messages table

## Security

- No shell access from model (spawn with argv, never shell=true)
- Token refresh hidden from model
- Bearer tokens redacted in all output (ocli + finalizer)
- Single-user enforcement at bot middleware level
- CSRF state parameter for OAuth flow
- JWT issuer/expiration validation
