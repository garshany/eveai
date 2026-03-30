# Task Spec: tool-search-routing-hardening

## Metadata
- Task ID: tool-search-routing-hardening
- Created: 2026-03-30T18:43:48+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- CLAUDE.md
- docs/ARCHITECTURE.md
- docs/RELIABILITY.md
- OpenAI docs: https://developers.openai.com/api/docs/guides/tools-tool-search
- OpenAI docs: https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces

## Original task statement
Не убирать tool_search как основной механизм. Смягчить промпт в src/agent/prompts.ts:22 с обязательного вызова tool_search на условный (если endpoint не загружен/неочевиден). Дополнительно скорректировать группировку и контуры tool search (namespaces/deferred loading/описания) по актуальным рекомендациям OpenAI docs так, чтобы контуры были смысловыми и корректными.

## Acceptance criteria
- AC1: `tool_search` remains enabled in the full runtime toolset as the primary discovery mechanism for the deferred ESI surface; the change must not remove `tool_search` or flatten the full ESI catalog into always-on function tools.
- AC2: Prompt policy in `src/agent/prompts.ts` is softened from mandatory `tool_search` usage to conditional usage: call `tool_search` when endpoint/namespace availability is unknown, not yet loaded, or discovery is needed; avoid unnecessary `tool_search` hops when a suitable tool is already available.
- AC3: Tool-search contours remain semantically grouped and aligned with OpenAI guidance: namespaces stay meaningful and use-case oriented, deferred-loading semantics are preserved for deferred ESI tools, and namespace descriptions remain clear and concise.
- AC4: Coverage is added/updated to prevent regression for the new conditional prompt-routing behavior and for the intended tool-surface shape (including that `tool_search` stays present in full mode).
- AC5: If runtime behavior or operator-facing guidance changes, matching repository docs are updated in the same change and evidence references the exact updated doc paths.

## Constraints
- Keep all task artifacts inside `.agent/tasks/tool-search-routing-hardening/`.
- Preserve architecture invariants from AGENTS.md: single-process Node app, Telegram long polling, and private ESI gating rules (including `get_eve_capabilities` requirements).
- Do not remove `tool_search` from the full-mode toolset.
- Do not redesign the entire executor or globally re-architect all ESI tools.
- Preserve strict TypeScript, existing auth boundaries, and secret-handling constraints.
- Keep diffs minimal and scoped to prompt/tool-search routing and namespace/deferred metadata quality.

## Non-goals
- Migrating all ~200 ESI operations into always-on non-deferred tools.
- Replacing hosted `tool_search` with client-executed search.
- Broad refactors of unrelated tool families, Telegram runtime loops, or web/dashboard surfaces.
- Changes to token/refresh internals, auth callback flow, pagination internals, retry internals, or security model.

## Verification plan
- Build: `npm run build`
- Unit tests: `npm run test -- tests/unit/prompts.test.ts tests/unit/tools.test.ts tests/unit/native-responses.test.ts`
- Integration tests: run only if touched seams require it; otherwise record as not needed with rationale in evidence
- Lint: `npm run lint`
- Manual checks:
  - Confirm full toolset still includes `tool_search`.
  - Confirm prompt text no longer forces unconditional `tool_search` and explicitly describes conditional usage.
  - Confirm ESI namespaces remain meaningful and deferred-loading semantics remain intact for deferred ESI tools.
  - Capture command outputs and file proofs in `.agent/tasks/tool-search-routing-hardening/evidence.md` and `evidence.json`.
