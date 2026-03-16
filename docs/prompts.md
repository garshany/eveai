# Prompt Design

## Developer Prompt

Located in [src/agent/prompts.ts](/home/antipedik/eveai/src/agent/prompts.ts).

Key rules:

1. Never invent endpoints, scopes, ids, prices, wallet values, routes, or API results.
2. Use ESI endpoint-tools for live game state, SDE tools for static ids and metadata, and `web_search` only for non-ESI background information.
3. Prefer hosted `tool_search` before reaching for deferred ESI or SDE tools.
4. Check `get_eve_capabilities` before private ESI calls when access is not obvious.
5. Do not manage auth, pagination, retries, rate limits, or compatibility headers in-model.
6. Build a short plan with `update_plan` only when the task is genuinely multi-step.
7. Synthesize the final answer strictly from tool outputs and say explicitly when access or data is missing.

There is no separate model-visible shortcut routing layer for pricing, route planning, or fit parsing. The agent is expected to stay inside the native hosted `tool_search` runtime and load the narrowest deferred tools it needs.

## Tool Catalog

Located in [src/agent/tools.ts](/home/antipedik/eveai/src/agent/tools.ts).

Always-on tools:

- `tool_search`
- `get_eve_capabilities`
- `web_search`
- `update_plan`

Deferred tools:

- Generated ESI endpoint tools from the live swagger catalog
- Deferred SDE namespace tools: `sde_lookup_types`, `sde_lookup_universe`, `sde_lookup_dogma`, `sde_lookup_dataset`
