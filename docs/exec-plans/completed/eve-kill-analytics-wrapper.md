# EVE-KILL Analytics Local Wrapper

## Goal

Restore four useful EVE-KILL MCP analytics methods without exposing a remote
MCP descriptor to a model turn that may contain private context.

## Delivered

- Added the deferred local `eve_kill_analytics` namespace with
  `doctrine_detect`, `meta_pulse`, `killmail_forensics`, and `coalition_graph`.
- Restricted outbound identifiers to positive numeric CCP IDs; names resolve
  locally through `eve_universe_reference` first.
- Added fixed-endpoint JSON-RPC transport with exact argument reconstruction,
  canonical time-window validation, bounded retry/timeout/response parsing,
  Streamable HTTP SSE support, safe error projection, and depth/node limits.
- Kept direct hosted MCP absent from OpenAI Responses requests.
- Added read-only routing, a shared EVE-KILL budget, a four-call analytics cap,
  privacy-safe audit metadata, prompts, tests, and synchronized documentation.

## Verification

- 67 test files / 417 tests passed.
- TypeScript, ESLint, build, public artifact audit, and diff check passed.
- Current compiled `meta_pulse` live smoke passed against the fixed public MCP
  endpoint without credentials.
- Final independent review: clean, no actionable P0-P2.

## Decisions

- 2026-07-14: use local application-owned function tools rather than a provider-
  hosted MCP descriptor, so application validation is the pre-egress boundary.
- 2026-07-14: accept only numeric CCP entity/alliance IDs.
- 2026-07-14: support JSON and bounded SSE responses, and reject JSON exceeding
  32 levels or 50,000 nodes before downstream recursive handling.
