---
name: eve-esi
description: Use for live EVE ESI reads through the ocli wrapper. Covers all ESI categories via 10 profiles.
---

## When to use

Any time the user asks about live EVE data: market prices, character info, wallet, assets, industry, contracts, mail, corp data, universe info, route calculations, etc.

## Workflow

1. If the request may need private data, call `get_eve_capabilities` first.
2. Use `safe_exec_ocli` in this order:
   - `search` -- find the right command
   - `help` -- inspect parameters and requirements
   - `run` -- execute with correct args
3. Never invent command names or parameters.
4. Never use `run` before `help` for a newly discovered command.
5. Summarize results and note any missing scopes.

## Profile selection (10 profiles)

| Profile         | Use for                                              | Auth |
| --------------- | ---------------------------------------------------- | ---- |
| eve-public      | Universe, status, routes, dogma, alliances, wars, FW, public contracts/industry | No |
| eve-character   | Info, skills, location, clones, contacts, fittings, killmails, notifications, bookmarks, search | Yes |
| eve-wallet      | Wallet balance, journal, transactions                | Yes |
| eve-assets      | Assets list, locations, names                        | Yes |
| eve-market      | Regional orders/history, character orders, structure market | Yes |
| eve-industry    | Jobs, blueprints, mining, PI, public facilities      | Yes |
| eve-contracts   | Character contracts, bids/items, public contracts    | Yes |
| eve-mail        | Inbox, labels, mailing lists                         | Yes |
| eve-corp        | Members, roles, structures, wallets, assets, industry, blueprints | Yes |
| eve-ui          | Autopilot waypoints, open in-game windows            | Yes |

## Error handling

- If a scope is missing, tell the user which scope is needed and suggest `/eve_login`.
- If ESI returns an error, report the error clearly. Do not retry blindly.
- If a command is not found, try a broader search query before giving up.
- If ESI returns 420 (rate limited), wait and inform the user.
