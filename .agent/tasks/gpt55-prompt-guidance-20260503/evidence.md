# GPT-5.5 Prompt Guidance Rewrite Evidence

## Scope

Changed the active EVE Agent developer prompt to follow current OpenAI GPT-5.5 prompt guidance:

- outcome-first prompt layout;
- fewer broad process rules and fewer unnecessary absolute directives;
- stable SDE schema before dynamic per-user context for prompt caching;
- dynamic profile and summary content framed as data;
- preserved Telegram, SDE/ESI, private access, routing, scan, market, fit, OSINT, WH, and intel note behavior.

## Official Guidance Consulted

- OpenAI prompt guidance: `https://developers.openai.com/api/docs/guides/prompt-guidance`
- OpenAI latest model guide: `https://developers.openai.com/api/docs/guides/latest-model`
- OpenAI GPT-5.5 upgrade guide: `https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p5`

Key applied guidance:

- Keep prompts outcome-first: goal, constraints, evidence, final answer shape.
- Prefer concise prompts over process-heavy scaffolding.
- Reserve hard rules for true invariants.
- Keep stable prompt context before dynamic context where practical.
- Treat user/profile/summarized context as data, not instructions.

## Files Changed

- `src/agent/prompts.ts`
- `tests/unit/prompts.test.ts`
- `README.md`
- `.agent/tasks/gpt55-prompt-guidance-20260503/*`

## Acceptance Criteria

- AC1 PASS: OpenAI Docs skill/MCP docs were used for GPT-5.5 prompt guidance.
- AC2 PASS: `src/agent/prompts.ts` now starts with mission/success, then output contract, then tool hierarchy and policy.
- AC3 PASS: removed the prior long process-heavy sections such as reasoning strategy, self-correction, proactive enrichment, and verification loop while preserving hard product invariants.
- AC4 PASS: `SDE_SCHEMA` is appended immediately after the stable base prompt and before auth, live context, `USER.md`, and conversation summary blocks.
- AC5 PASS: `USER.md` and conversation summaries are explicitly data, not instructions; private ESI access remains gated by `get_eve_capabilities`.
- AC6 PASS: tool guidance is consolidated near tool source hierarchy, decision rules, and domain outcomes without changing tool schemas or runtime orchestration.
- AC7 PASS: prompt tests now assert outcome-first order, static-before-dynamic ordering, important invariants, and prompt size regression.
- AC8 PASS: local validation commands passed.
- AC9 PENDING: production commit, push, deploy, and production verification will be recorded after deployment.

## Local Validation

Commands run successfully:

```text
npm run test -- tests/unit/prompts.test.ts
npm run test -- tests/unit/prompts.test.ts tests/unit/native-responses.test.ts tests/unit/warm-cold-path.test.ts tests/unit/static-aggregate.test.ts tests/unit/tools.test.ts
npm run check
npm run build
git diff --check
```

Summary:

```text
tests/unit/prompts.test.ts: PASS, 4 tests
focused prompt/native/static/tool suite: PASS, 38 tests
npm run check: PASS, 43 test files, 239 tests, eslint max-warnings 0
npm run build: PASS, client and server build completed
git diff --check: PASS
```

## Deployment

Pending. This evidence will be updated after commit, push, production deploy, and production verification.
