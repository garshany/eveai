# Task Spec: aggregate-latency-hardening

## Metadata
- Task ID: aggregate-latency-hardening
- Created: 2026-03-27T21:20:14+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- CLAUDE.md

## Original task statement
Completely address runtime item (2) long-turn latency/context overhead after deterministic tools and item (3) analogous static aggregate queries that should not drift into tool_search/web_search. Use repo-task-proof-loop artifacts, implement deterministic/static routing where warranted, optimize executor/prompt behavior for faster completion, verify with tests and production-oriented evidence.

## Acceptance criteria
- AC1: Simple static aggregate count questions (for example moons, planets, systems, constellations, stations, stargates in a system/constellation/region, including current-location phrasing) must have a deterministic local-SDE path and must not require `tool_search`/`web_search` or live ESI when local data is sufficient.
- AC2: For those deterministic static aggregate count questions, the executor must materially reduce avoidable turn latency and context overhead versus the prior generic loop. The fixed path must be visibly bounded in tools/iterations and have production-oriented evidence.
- AC3: Prompt and runtime routing must cover the analogous count-question classes precisely enough that the model is steered into the deterministic path instead of exploratory SDE/web loops, with regression tests for routing/formatting/helpers.
- AC4: The change must preserve current moon-count behavior, keep strict TypeScript/build/lint/test health, and produce a PASS repo-task-proof-loop evidence bundle with explicit current-code proofs.

## Constraints
- Keep all artifacts inside `.agent/tasks/aggregate-latency-hardening/`.
- Preserve the single-process Node/Telegram long-polling architecture.
- Prefer the smallest defensible diff that fully addresses static aggregate count drift and long-turn overhead; avoid broad redesign of unrelated prompt/tool systems.
- Do not expose secrets, auth internals, or live-token details to the model.
- If runtime behavior changes, update the matching docs in `docs/`.

## Non-goals
- Fixing unrelated Telegram polling conflicts (`getUpdates` 409 / `setMyCommands` 429).
- Redesigning all tool registration for every request type.
- Eliminating all model latency for arbitrary multi-step questions outside deterministic static aggregate count paths.

## Verification plan
- Build: `npm run build`
- Unit tests: targeted executor/tool/prompt tests plus new regressions for generic static aggregate counts and fast-finalize logic
- Integration tests: only if the implementation crosses Telegram seams materially
- Lint: `npm run lint`
- Manual checks:
  - reproduce at least one current-region/static aggregate question on production-oriented runtime and confirm bounded tool/iteration path
  - compare current payload/iteration behavior against prior moon evidence
  - inspect direct `/responses` latency separately from app-side loop latency
