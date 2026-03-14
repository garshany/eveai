# Prompt Design

## System Prompt

Located in `src/agent/prompts.ts`. Written in Russian for consistency with the user.

Key rules enforced:
1. Never invent data
2. For ESI: search → help → run (strict order)
3. Check capabilities before private ESI calls
4. Report missing scopes clearly
5. Replan on failure instead of retrying

## Tool Schemas

Located in `src/agent/tools.ts`. All 4 tools use `strict: true` for guaranteed schema compliance.

### safe_exec_ocli
- 6 profiles as enum
- 3 modes: search, help, run
- Nullable query/command/args fields

### query_sde
- 11 entity types as enum
- 3 lookup modes
- Required value and limit

### get_eve_capabilities
- Single `intent` field for context

### update_plan
- Array of steps with id, title, status, depends_on, notes
