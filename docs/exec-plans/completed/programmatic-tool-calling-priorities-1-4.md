# Programmatic Tool Calling priorities 1-4

Status: completed
Task proof: `.agent/tasks/ptc-expansion-1-4/`

## Goal

Expand the default-off Programmatic Tool Calling surface from five to exactly
nine bounded public-read tools by adding `market_history_summary`,
`system_metric_snapshot`, `doctrine_summary`, and `dynamic_item_summary`.

## Runtime contract

- All nine tools remain directly callable with the feature disabled.
- Enabled programs use one exact tool name, two-to-four coherent calls except
  for the one-call wormhole comparison, and the existing four-call global
  ceilings.
- The four new facades call only fixed unauthenticated public ESI operations,
  the fixed local EVE-KILL analytics wrapper, and optional local SDE data.
- Application validation owns caller linkage, inputs, uniqueness, coherence,
  work budgets, output schemas, the 12,000-character limit, and sanitized
  failures. Routine logging excludes raw argument values and IDs.
- Rollback is `OPENAI_PROGRAMMATIC_TOOL_CALLING=false` plus process restart; no
  migration or remote cleanup is required.

## Completion evidence

The frozen acceptance contract and sanitized proof are in
`.agent/tasks/ptc-expansion-1-4/`. All AC1–AC15 passed after focused and full
checks, real direct-source and hosted PTC matrices, an independent review/fix/
re-review cycle, and a fresh verifier pass.
