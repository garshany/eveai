# Task Spec: codex-proxy-v2-audit

## Metadata
- Task ID: codex-proxy-v2-audit
- Created: 2026-03-25T17:49:38+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- ARCHITECTURE.md
- docs/repo-map.md
- docs/RELIABILITY.md
- deploy/systemd/eveai-codex-proxy.service
- src/agent/native-responses.ts
- src/agent/executor.ts
- src/agent/compact.ts
- src/smoke.ts
- tests/unit/native-responses.test.ts
- tests/unit/warm-cold-path.test.ts
- tests/unit/compact.test.ts
- OpenAI API changelog:
  - https://developers.openai.com/api/docs/changelog
- OpenAI Responses API docs for conversation state and compaction:
  - https://platform.openai.com/docs/guides/conversation-state?api-mode=responses
  - https://platform.openai.com/docs/guides/text?api-mode=responses#context-window

## Original task statement
Проверить систему и работу codex proxy v2 из корня: корректность общения, использование previous_id для истории и метода compact.

## Acceptance criteria
- AC1: The audit proves how this repository talks to the OpenAI-compatible proxy today: which endpoint is called, which request fields are sent for native responses, which local health/model probes are used from the repo root, and whether that transport matches the current documented Responses API shape for conversation continuation and compaction.
- AC2: The audit proves whether `previous_id` / `previous_response_id` is used correctly for history continuation in the current implementation: within a single tool loop, across separate user turns, and at the persistence boundary (`agent_threads.last_response_id`). If the implementation is inconsistent with the intended model or with current OpenAI documentation, the code and docs are corrected minimally.
- AC3: The audit proves whether compaction is used correctly in both places the code supports it: server-managed Responses API compaction via `context_management` / `compact_threshold`, and local SQLite thread summarization via `compactThreadIfNeeded`. The final state must make the interaction between these mechanisms explicit and internally consistent.
- AC4: The repository includes focused regression coverage and evidence for the proxy-v2 path from the repo root, covering request payload construction, continuation behavior, and compaction-related behavior without exposing secrets or depending on undocumented proxy internals.
- AC5: The repository documentation and task artifacts state one consistent conclusion about proxy-v2 communication, `previous_id` history handling, and compaction, so a fresh verifier can judge the current codebase without relying on chat history.

## Constraints
- Keep all workflow artifacts under `.agent/tasks/codex-proxy-v2-audit/`.
- Preserve the existing single-process Node.js architecture and Telegram long-polling model.
- Do not introduce workers, queues, Redis, Postgres, or webhooks.
- Do not expose API keys, auth files, tokens, proxy credentials, refresh flow internals, or other secrets in code, logs, docs, or evidence artifacts.
- Treat current official OpenAI documentation as the source of truth for Responses API conversation continuation and compaction behavior.
- Treat the deployed local proxy as an OpenAI-compatible boundary: verify behavior through the repository code, tests, smoke checks, and documented local endpoints before assuming proxy internals.
- Keep changes minimal and limited to the audit scope: proxy transport, `previous_id` continuity, compaction, tests, and matching docs.

## Non-goals
- Rewriting the entire agent runtime or replacing the proxy.
- Auditing unrelated EVE/ESI transport, Telegram bot policy, or frontend behavior beyond what is necessary to validate the proxy-v2 path.
- Depending on undocumented implementation details inside `codex_proxy_v2` unless they are directly observable from the configured local deployment boundary.
- Expanding the feature set beyond what is needed to prove or fix communication, history continuation, and compaction behavior.

## Verification plan
- Build: run `npm run build` to confirm the repo still compiles after any audit fixes.
- Unit tests: run focused tests for native responses payloads, warm/cold path history handling, compaction, and any new proxy-continuation regressions.
- Integration tests: run relevant Telegram or runtime seam coverage if the audit changes request flow or thread persistence semantics.
- Lint: run `npm run lint` and `npm run typecheck`.
- Manual checks: inspect the current runtime path in `src/agent/native-responses.ts`, `src/agent/executor.ts`, `src/agent/compact.ts`, and `src/smoke.ts`; confirm the configured proxy root via `deploy/systemd/eveai-codex-proxy.service`; compare the code against current OpenAI docs for `previous_response_id` and compaction; when possible, probe the local proxy boundary from the repo root using health/models-compatible checks.

## Assumptions
- The intended proxy under audit is the local service configured by [deploy/systemd/eveai-codex-proxy.service](/home/antipedik/eveai/deploy/systemd/eveai-codex-proxy.service), which points at `/home/antipedik/codex_proxy_v2` and serves an OpenAI-compatible API on port `8088`.
- The user wants an audit-first result: prove current behavior, then apply only the smallest fixes required to make proxy communication, `previous_id` handling, and compaction behavior correct and documented.
- `previous_id` in the user request refers to Responses API continuation via `previous_response_id` and to any repo-local persistence intended to support that continuity between turns.
- The verifier may rely on code inspection, rerun checks, and local proxy health/model probes, but should not require live external OpenAI credentials beyond the repository's normal development setup.
