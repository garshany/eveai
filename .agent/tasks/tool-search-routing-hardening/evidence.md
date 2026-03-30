# Evidence Bundle: tool-search-routing-hardening

## Summary
- Overall status: PASS
- Last updated: 2026-03-30T21:56:18+03:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - Full-mode runtime still includes hosted `tool_search` in the top-level toolset at `src/agent/tools.ts:243`.
  - This task did not remove or flatten the deferred ESI catalog; the full toolset still appends `listEsiNamespaces()` after `tool_search` at `src/agent/tools.ts:243`.
  - Regression coverage keeps `tool_search` present in full mode in `tests/unit/tools.test.ts:21` and `tests/unit/tools.test.ts:74`.
- Gaps:
  - None in the evidence bundle; fresh verifier still pending.

### AC2
- Status: PASS
- Proof:
  - The main prompt now describes `tool_search` as a primary discovery tool with conditional usage instead of unconditional usage at `src/agent/prompts.ts:22`.
  - Grounding and routing guidance now tell the model to reuse already available endpoints and only call `tool_search` when the needed endpoint/namespace is not loaded or is unclear at `src/agent/prompts.ts:57`, `src/agent/prompts.ts:60`, `src/agent/prompts.ts:63`, and `src/agent/prompts.ts:87`.
  - Prompt regression coverage asserts the new conditional wording and the removal of the old mandatory phrasing in `tests/unit/prompts.test.ts:21` and `tests/unit/prompts.test.ts:37`.
- Gaps:
  - None in the evidence bundle; fresh verifier still pending.

### AC3
- Status: PASS
- Proof:
  - Hosted namespace metadata now separates public affiliation lookup, auth-bound character search, public regional market orders/history, and authenticated structure market orders at `src/eve/esi-catalog.ts:562`, `src/eve/esi-catalog.ts:598`, `src/eve/esi-catalog.ts:666`, `src/eve/esi-catalog.ts:830`, and `src/eve/esi-catalog.ts:842`.
  - Namespace descriptions are now aligned with the actual access boundary and use case; for example, `eve_public_market_orders` no longer claims to include structure markets, and `eve_authenticated_market_structures` carries the auth-specific description at `src/eve/esi-catalog.ts:832` and `src/eve/esi-catalog.ts:844`.
  - Tool-surface regression coverage asserts the new namespace names, the public/private split, and continued deferred-loading behavior in `tests/unit/tools.test.ts:36`, `tests/unit/tools.test.ts:53`, `tests/unit/tools.test.ts:57`, and `tests/unit/tools.test.ts:64`.
- Gaps:
  - None in the evidence bundle; fresh verifier still pending.

### AC4
- Status: PASS
- Proof:
  - Targeted unit coverage passed via `npm run test -- tests/unit/prompts.test.ts tests/unit/tools.test.ts tests/unit/native-responses.test.ts`; raw output captured in `.agent/tasks/tool-search-routing-hardening/raw/test-unit.txt`.
  - Build passed via `npm run build`; raw output captured in `.agent/tasks/tool-search-routing-hardening/raw/build.txt`.
  - Lint passed via `npm run lint`; raw output captured in `.agent/tasks/tool-search-routing-hardening/raw/lint.txt`.
- Gaps:
  - Integration tests were not needed because the diff stayed within prompt policy, namespace metadata, unit tests, and docs; rationale captured in `.agent/tasks/tool-search-routing-hardening/raw/test-integration.txt`.

### AC5
- Status: PASS
- Proof:
  - Architecture docs were updated to explain the use-case/access-boundary namespace grouping and the conditional reuse of already loaded tools at `ARCHITECTURE.md:44` and `ARCHITECTURE.md:105`.
  - Evidence references the exact updated doc path in this bundle and records the corresponding raw verification artifacts under `.agent/tasks/tool-search-routing-hardening/raw/`.
- Gaps:
  - None in the evidence bundle; fresh verifier still pending.

## Commands run
- `npm run test -- tests/unit/prompts.test.ts tests/unit/tools.test.ts tests/unit/native-responses.test.ts` (exit 0)
- `npm run build` (exit 0)
- `npm run lint` (exit 0)

## Raw artifacts
- .agent/tasks/tool-search-routing-hardening/raw/build.txt
- .agent/tasks/tool-search-routing-hardening/raw/test-unit.txt
- .agent/tasks/tool-search-routing-hardening/raw/test-integration.txt
- .agent/tasks/tool-search-routing-hardening/raw/lint.txt
- .agent/tasks/tool-search-routing-hardening/raw/screenshot-1.png

## Known gaps
- Fresh verifier has not run yet; `verdict.json` remains for the independent verification phase.
