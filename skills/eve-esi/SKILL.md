---
name: eve-esi
description: Use for live EVE ESI reads through generated endpoint tools, hosted tool_search, and scope-aware capabilities.
---

## When to use

Any time the user asks about live EVE data: market prices, character info, wallet, assets, industry, contracts, mail, corp data, universe info, route calculations, etc.

## Workflow

1. If the request may need private data, call `get_eve_capabilities` first unless access is already confirmed.
2. Use `tool_search` to load the smallest relevant deferred ESI endpoint-tools.
3. Prefer the narrowest endpoint-tool that exactly matches the task.
4. Never invent endpoint names, scopes, parameters, IDs, or API results.
5. Summarize results and note any missing scopes or missing data.

## Tooling model

- Always-on tools: `tool_search`, `get_eve_capabilities`, `web_search`, `update_plan`
- Deferred tools: one generated tool per ESI `operationId`
- Static data should go through deferred SDE lookup tools, not ESI

## Error handling

- If a scope is missing, tell the user which scope is needed and suggest `/eve_login`.
- If ESI returns an error, report the error clearly. Do not retry blindly.
- If the right endpoint-tool is not yet loaded, try a broader `tool_search` query before giving up.
- If ESI returns 420 (rate limited), wait and inform the user.
