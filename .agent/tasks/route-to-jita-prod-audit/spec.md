# Task Spec: route-to-jita-prod-audit

## Metadata
- Task ID: route-to-jita-prod-audit
- Created: 2026-03-30T19:24:00+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- CLAUDE.md

## Original task statement
Посмотреть пользовательский запрос про маршрут до Житы: понять логику, какие данные собираются, как запрос отрабатывает на проде, есть ли ошибки или лишние операции, и предложить решение. Сначала изучить production логи и выполнить живой запрос через прод. Также нужен стабильный формат ответа: системы жирным, таблицы там, где это возможно.

## Acceptance criteria
- AC1: The task artifacts must capture a production-first audit of a live route-to-Jita request. The audit must include concrete prod evidence for one real request or one prod-faithful repro of `handleAgentMessage`, including the user prompt, route tool call arguments, iteration count, token/latency signals available in logs, and the final rendered answer.
- AC2: The audit must explain the current route execution path end to end for a "route to Jita" request, starting from the Telegram or equivalent request entrypoint through `handleAgentMessage`, `plan_route`, and the final Telegram-facing formatting path. It must state what data is gathered at each step and which parts come from local SDE, cached/live ESI, zKill, and model output.
- AC3: The audit must identify any concrete correctness risks, unstable behavior, or unnecessary work in the current route flow. If such issues exist, they must be described with current-code and prod-backed evidence; if not, the artifacts must explicitly state that no issue was proven. This includes route origin resolution, danger-scan breadth, side effects such as autopilot behavior, and formatting stability.
- AC4: The task must produce a minimal, defensible fix proposal that is grounded in the audited behavior. The proposal must explain what should change, why that is the smallest safe fix, what tests or docs should move with it, and what risks remain.
- AC5: If the workflow proceeds to implementation later, the resulting route output must remain Telegram-safe and stable: system names emphasized consistently, route comparison presented in a stable table-like format supported by Telegram, and route responses covered by regression tests so formatting and data shape do not drift.

## Constraints
- Keep all workflow artifacts inside `.agent/tasks/route-to-jita-prod-audit/`.
- Audit production behavior before changing code. Prefer read-only log inspection and prod-faithful reproduction on a safe DB copy over mutating live user state.
- Do not expose tokens, refresh-flow internals, secrets, or raw production credentials in task artifacts.
- Preserve repo invariants: single-process Node runtime, grammY long polling, isolated per-user/chat private ESI access, and strict TypeScript.
- If behavior changes later, update the matching documentation under `docs/` in the same change.
- Formatting requirements must stay compatible with Telegram rendering. "Tables where possible" means Telegram-safe fixed-width or equivalent rendered structure, not GitHub-style pipe tables.

## Non-goals
- Fixing unrelated production issues such as Telegram `getUpdates` 409 conflicts or `setMyCommands` 429s unless they directly block route auditing or route verification.
- Redesigning the whole agent runtime, prompt system, or all route-related features beyond the smallest change justified by the route-to-Jita audit.
- Reworking unrelated market, fit, or non-route query handling.
- Performing credential rotation, auth repair, or unrelated secret-storage cleanup except where needed to explain observed route behavior.

## Verification plan
- Build: `npm run build` if implementation work happens.
- Unit tests: targeted route planner and executor/prompt regressions covering route origin resolution, tool args, and stable route formatting.
- Integration tests: only if the fix crosses Telegram handler or final formatting seams materially.
- Lint: `npm run lint` if code changes are made.
- Manual checks:
  - inspect prod logs for a live route-to-Jita request and record the observed tool/runtime path
  - run a safe prod-faithful repro on a DB copy through `handleAgentMessage` and capture the final answer and tool payloads
  - compare observed behavior against the intended route logic and formatting expectations
  - if a fix is implemented later, rerun the same repro path and local checks and confirm the identified issue no longer reproduces

## Assumptions
- The relevant user-facing request is a short natural-language route request such as "Построй маршрут до Житы", where the current location may determine the origin if the user does not name one explicitly.
- Stable formatting must be enforced at the route tool and/or final route response boundary, because current prompt policy already instructs the model to emit `formatted_summary` verbatim for direct route requests.
- "Предложить решение" means producing a root-cause-backed recommendation first; implementation is a later build-step concern if the workflow continues past audit and spec freeze.
