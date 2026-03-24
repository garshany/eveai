# EVE Agent Architecture

## Overview

Single-process, multi-user EVE Online agent with Telegram as the primary input.

```text
Telegram (long polling) -> grammY bot -> Agent Runtime -> native /v1/responses
                                                     -> hosted tool_search
                                                     -> deferred ESI + SDE tools
                                                     -> SQLite + EVE SSO
```

## Runtime

- Native codex-proxy `POST /v1/responses`
- `gpt-5.4` with `reasoning.effort=medium`
- Hosted `tool_search` enabled at the provider layer
- Parallel function calls allowed for read-only tool batches
- Tool loop persists user, assistant, and tool audit messages in SQLite
- No separate shortcut router for route, item, or fit requests; those flows should resolve through the same hosted `tool_search` runtime as any other task

## Model-Facing Tools

Always-on:

- `tool_search`
- `get_eve_capabilities`
- `web_search`
- `update_plan`

Deferred:

- One function tool per ESI `operationId`, generated from the live ESI swagger catalog
- SDE namespace tools such as `sde_lookup_types`, `sde_lookup_universe`, `sde_lookup_dogma`, `sde_lookup_dataset`

## ESI Layer

- No `ocli`, no shell execution, no profile indirection
- Native fetch-based ESI client with:
  - `X-Compatibility-Date`
  - auth injection from local SSO storage
  - GET caching in `esi_cache`
  - `X-Pages` aggregation up to configured limits
- Operation catalog loaded from `https://esi.evetech.net/latest/swagger.json` and cached locally

## SSO

- OAuth 2.0 authorization code flow
- CSRF state in `telegram_sessions.oauth_state`
- SQLite token storage with automatic refresh
- Scope-aware access control via `get_eve_capabilities`

## SDE

- Local SQLite index loaded from CCP JSON Lines exports
- Typed entity tables plus raw dataset access
- Used both by backend features and by deferred model tools

## Feature Modules

- Pricing uses live regional orders through ESI operation tools
- Route planning uses route, kills, and UI waypoint operations directly
- Telegram `/market` and `/info` commands call UI endpoints via native ESI operations
- User profile refresh reads character, location, skills, wallet, corp, and alliance data without CLI wrappers
