# GPT-5.5 Prompt Guidance Rewrite

## Objective

Apply the OpenAI GPT-5.5 prompt guidance to the active EVE Agent prompt stack, preserving existing product behavior while reducing process-heavy prompt scaffolding and improving cache/layout discipline.

## Acceptance Criteria

- AC1: Current OpenAI GPT-5.5 prompt guidance is consulted through the OpenAI Docs skill.
- AC2: The main developer prompt in `src/agent/prompts.ts` is outcome-first: it states the assistant mission, success criteria, constraints, and final-answer shape before detailed routing.
- AC3: The prompt keeps hard invariants but reduces unnecessary process-heavy wording and broad absolute rules.
- AC4: Static prompt content, including `SDE_SCHEMA`, is placed before dynamic user/profile/live context to improve prompt caching.
- AC5: Dynamic context remains explicitly framed as data, not instructions, and private ESI access remains capability-gated.
- AC6: Tool-specific guidance is kept close to tool descriptions where practical, without broad API or schema rewiring.
- AC7: Prompt tests cover the new structure, dynamic-data ordering, static aggregate mode, and important product invariants.
- AC8: Relevant local checks pass.
- AC9: Changes are committed, pushed, deployed to production, and production is verified.

## Constraints

- Preserve TypeScript strict mode.
- Do not change OpenAI API surface, tool schemas, auth, SDE/ESI behavior, or runtime orchestration unless required by the prompt layout.
- Do not revert unrelated dirty worktree changes.
- Keep the Telegram output contract and EVE data-source hierarchy intact.
