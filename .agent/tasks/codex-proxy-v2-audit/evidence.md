# Evidence Bundle: codex-proxy-v2-audit

## Summary
- Overall status: PASS
- Last updated: 2026-03-25T18:00:00+00:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - [src/agent/native-responses.ts](/home/antipedik/eveai/src/agent/native-responses.ts#L81) sends native requests to `POST {OPENAI_BASE_URL}/responses`, includes `previous_response_id` when present, and forwards `context_management` when configured.
  - [src/smoke.ts](/home/antipedik/eveai/src/smoke.ts#L22) verifies the local proxy boundary from the repo root via `/health` and `/v1/models`, and [deploy/systemd/eveai-codex-proxy.service](/home/antipedik/eveai/deploy/systemd/eveai-codex-proxy.service#L8) points that boundary at `/home/antipedik/codex_proxy_v2` on port `8088`.
  - [/home/antipedik/codex_proxy_v2/src/main.rs](/home/antipedik/codex_proxy_v2/src/main.rs#L303) resolves `previous_response_id` locally and strips it before forwarding upstream, while [/home/antipedik/codex_proxy_v2/src/main.rs](/home/antipedik/codex_proxy_v2/src/main.rs#L339) auto-injects `context_management` if the client omits it.
  - The official OpenAI changelog states that `v1/responses` added context management using compaction and that `v1/responses/compact` was released on December 11, 2025; this supports the transport surface our client and proxy now target. Source: https://developers.openai.com/api/docs/changelog
  - `.agent/tasks/codex-proxy-v2-audit/raw/smoke.txt` contains successful live probes for `http://127.0.0.1:8088/health` and `http://127.0.0.1:8088/v1/models`.
- Gaps:
  - `npm run smoke` still failed its `app_health` leg because `http://localhost:8000/health` was not serving during evidence capture; this did not block verification of the proxy boundary itself.

### AC2
- Status: PASS
- Proof:
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L337) now chooses a conversation continuation plan before each turn instead of always replaying full history.
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L909) uses a fresh `agent_threads.last_response_id` plus the latest user message for the warm path, and [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L935) falls back to SQLite-backed cold history when the stored response id is stale or absent.
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L414) persists the final response id on success, while [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L382) and [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L497) clear it on error, fallback, or timeout so later turns do not trust a broken continuation chain.
  - [tests/unit/warm-cold-path.test.ts](/home/antipedik/eveai/tests/unit/warm-cold-path.test.ts#L91) proves warm continuation uses `previous_response_id` for fresh turns, and [tests/unit/warm-cold-path.test.ts](/home/antipedik/eveai/tests/unit/warm-cold-path.test.ts#L112) proves stale continuations fall back to cold history.
  - `.agent/tasks/codex-proxy-v2-audit/raw/test-unit.txt` shows the focused unit suite passed.
- Gaps:
  - None.

### AC3
- Status: PASS
- Proof:
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L347) sends server-managed compaction via `context_management` when `OPENAI_COMPACT_THRESHOLD > 0`.
  - [src/agent/compact.ts](/home/antipedik/eveai/src/agent/compact.ts#L43) still provides local SQLite summarization and pruning through `compactThreadIfNeeded`, so warm proxy continuation and cold local summarization now have separate, explicit roles.
  - [tests/unit/native-responses.test.ts](/home/antipedik/eveai/tests/unit/native-responses.test.ts#L118) verifies the native request body forwards both `previous_response_id` and `context_management`.
  - [tests/unit/compact.test.ts](/home/antipedik/eveai/tests/unit/compact.test.ts#L27) verifies local thread summarization still triggers and prunes old messages correctly.
  - [/home/antipedik/codex_proxy_v2/src/main.rs](/home/antipedik/codex_proxy_v2/src/main.rs#L612) confirms proxy-v2 also exposes `POST /v1/responses/compact`, but the application currently relies on automatic `context_management` plus local summary fallback instead of calling that endpoint directly.
- Gaps:
  - None.

### AC4
- Status: PASS
- Proof:
  - `.agent/tasks/codex-proxy-v2-audit/raw/test-unit.txt` shows `15` focused unit tests passed, including request-body coverage for `previous_response_id` and warm/cold continuation selection.
  - `.agent/tasks/codex-proxy-v2-audit/raw/test-integration.txt` shows `tests/integration/telegram-handler.test.ts` passed against the current codebase.
  - `.agent/tasks/codex-proxy-v2-audit/raw/build.txt` and `.agent/tasks/codex-proxy-v2-audit/raw/lint.txt` show build, lint, and typecheck passed after the audit change set.
  - `.agent/tasks/codex-proxy-v2-audit/raw/smoke.txt` captures the live proxy-v2 root checks from this repository.
- Gaps:
  - None.

### AC5
- Status: PASS
- Proof:
  - [ARCHITECTURE.md](/home/antipedik/eveai/ARCHITECTURE.md#L99) now states the warm/cold continuation model explicitly in the Telegram request flow.
  - [docs/RELIABILITY.md](/home/antipedik/eveai/docs/RELIABILITY.md#L5) now documents warm `previous_response_id` continuation, cold SQLite fallback, and failure behavior when the continuation chain is stale.
  - [.agent/tasks/codex-proxy-v2-audit/spec.md](/home/antipedik/eveai/.agent/tasks/codex-proxy-v2-audit/spec.md#L23) and this evidence bundle judge the same runtime model: proxy-compatible native responses, fresh-only warm continuation, cold fallback, and distinct compaction layers.
- Gaps:
  - None.

## Commands run
- `npm run build`
- `npm run test -- tests/unit/warm-cold-path.test.ts tests/unit/native-responses.test.ts tests/unit/compact.test.ts`
- `npm run test -- tests/integration/telegram-handler.test.ts`
- `npm run lint`
- `npm run typecheck`
- `curl -sS http://127.0.0.1:8088/health`
- `curl -sS http://127.0.0.1:8088/v1/models`
- `npm run smoke`

## Raw artifacts
- .agent/tasks/codex-proxy-v2-audit/raw/build.txt
- .agent/tasks/codex-proxy-v2-audit/raw/test-unit.txt
- .agent/tasks/codex-proxy-v2-audit/raw/test-integration.txt
- .agent/tasks/codex-proxy-v2-audit/raw/lint.txt
- .agent/tasks/codex-proxy-v2-audit/raw/smoke.txt
- .agent/tasks/codex-proxy-v2-audit/raw/screenshot-1.png

## Known gaps
- `npm run smoke` could not verify `app_health` because the app was not serving on `http://localhost:8000` during evidence capture; proxy health and proxy models checks still passed.
