# GPT-5.6 Prompt Revalidation

## Outcome

The existing GPT-5.6 Sol/Terra/Luna migration was correct, but revalidation
found one same-turn state defect and several prompt-density/routing issues.
The runtime now preserves opaque GPT-5.6 reasoning across every stateless tool
continuation path without persisting it, while the prompts are smaller and more
explicit about dynamic data and local-versus-hosted EVE-KILL routing.

## Implemented

- Request `reasoning.encrypted_content` for the top-level stateless tool loop.
- Replay reasoning in provider order for local calls, MCP-only continuation, and
  MCP approval denial; keep it in memory for the active turn only.
- Keep cross-turn `reasoning.context=all_turns` disabled.
- Give static aggregate mode a geography-only SDE schema/tool description and
  omit linked identity and scopes.
- Put all policies before runtime/profile/summary data and make runtime data
  factual only.
- Make local EVE-KILL the default for ordinary operations and reserve hosted MCP
  for four allowlisted analytical operations.
- Clarify compound-request and in-game mutation authorization wording.

## Deliberately not added

- No separate Pro model slug, provider storage, or cross-turn persisted reasoning.
- No explicit prompt cache breakpoints: live continuation demonstrated useful
  implicit reads, and cache-write telemetry already exposes the cost.
- No Programmatic Tool Calling without a representative bounded aggregation
  workload and the required program-item runtime protocol.

## Verification

- Focused: 4 files, 67 tests passed.
- Full: 66 files, 418 tests, TypeScript, ESLint, build, public audit, and diff
  check passed.
- Authenticated official `gpt-5.6-sol` smoke returned the exact marker.
- Authenticated EVE tool-loop smoke completed a real `sde_sql` continuation with
  cached input and correct Raven facts.
- Independent API and prompt reviews were clean after fixes.
- Proof artifacts: `.agent/tasks/gpt-5-6-prompt-revalidation/`.

## Superseded decision

- 2026-07-14: hosted MCP continuation and approval paths were removed from the
  runtime because they could not enforce pre-egress inspection of generated
  arguments. Opaque reasoning replay remains limited to local function-tool
  continuations. Local EVE-KILL REST tools remain the only model-facing path.
