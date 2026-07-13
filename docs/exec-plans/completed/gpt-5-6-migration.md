# GPT-5.6 Family Migration

## Problem statement

The active runtime defaulted to GPT-5.5, documented only three reasoning levels,
and advertised a reasoning-effort environment setting that the main agent loop
overrode unconditionally. The repository needed a verified GPT-5.6 family
cutover with real operator controls and prompt guidance aligned to the official
Responses API documentation.

## Scope

- Default to `gpt-5.6-sol` and document Sol/Terra/Luna selection.
- Add validated `auto|none|low|medium|high|xhigh|max` reasoning control.
- Add validated standard/Pro mode, text verbosity, and response timeout controls.
- Keep Pro scoped to the top-level agent loop.
- Add privacy-preserving safety identifiers and cache-write usage accounting.
- Tighten prompt authorization boundaries without rewriting the EVE domain prompt.
- Update tests, smoke checks, and operator documentation.

## Boundaries

- No per-chat preferences or model commands.
- No persisted reasoning or `all_turns` until encrypted reasoning items can be
  preserved and replayed correctly.
- No explicit cache breakpoints, Programmatic Tool Calling, or multi-agent API beta.
- No context-window increase without workload evidence.

## Implementation steps

1. Freeze `.agent/tasks/gpt-5-6-migration/spec.md`.
2. Add typed and validated OpenAI configuration options.
3. Wire top-level reasoning selection, Pro mode, safety identifiers, timeout, and
   cache-write usage through the native Responses path.
4. Apply the surgical prompt migration.
5. Update smoke tooling and current operator docs.
6. Run focused tests, full checks, authenticated smoke, independent review, and
   the repository proof-loop verifier.

## Completion log

- 2026-07-13: current runtime, prompts, docs, and official GPT-5.6 guidance audited.
- 2026-07-13: frozen scope and acceptance criteria created before implementation.
- 2026-07-13: migrated defaults and operator controls, fixed fixed-vs-auto effort
  selection, added Pro scoping, timeout validation, opaque identifiers, cache-write
  accounting, prompt boundaries, and strict smoke validation.
- 2026-07-13: authenticated official Sol smoke returned the exact expected marker.
- 2026-07-13: final `npm run check` passed TypeScript, ESLint, 57 test files, and
  327 tests; independent review was clean and AC1-AC7 received a fresh PASS.

## Decision log

- Self-hosting operator selection stays in `.env`; per-chat preferences are a
  separate product feature because settings affect shared cost and reliability.
- `auto` is a local selector preserving the existing goal classifier; it is never
  sent as an API reasoning effort.
- Stateless `store:false` remains the baseline. `all_turns` is not exposed until
  the runtime can preserve encrypted reasoning items end to end.
- The 200k local compaction window remains conservative during the model cutover.

## Follow-up work

- Evaluate Sol/Terra/Luna and adjacent effort levels on representative EVE tasks.
- Consider lane-scoped verbosity preferences only with a cross-platform product spec.
- Consider persisted reasoning only with a dedicated storage/privacy design.
