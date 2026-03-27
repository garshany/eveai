# Evidence Bundle: telegram-runtime-hardening

## Summary
- Overall status: PASS
- Last updated: 2026-03-28T00:10:47+03:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - Historical production log snapshot proves the failure mode existed: `.agent/tasks/telegram-runtime-hardening/raw/prod-pm2-log-snapshot.txt` contains raw `No tool call found for function call output with call_id ...` handler errors plus the later cold-recovery message.
  - `src/agent/executor.ts` now applies the same cold-recovery decision both for thrown proxy errors and for `response.error.message` payload errors.
  - `tests/unit/warm-cold-path.test.ts` now covers both `shouldRecoverFromToolStateMismatch` and the one-shot `shouldUseToolStateRecovery` gate; `raw/test-unit.txt` shows 26 passing tests.
- Gaps:
  - No production user turn after deploy naturally emitted a fresh proxy mismatch to reobserve the recovered path end-to-end.

### AC2
- Status: PASS
- Proof:
  - `src/eve/sso.ts` now catches `decryptStoredSecret` failures, logs character/chat/user context without secrets, and returns `null` instead of throwing through the Telegram handler.
  - `src/telegram/handlers.ts` now classifies decrypt/auth-state failures as EVE relink problems instead of blaming the LLM backend.
  - `tests/unit/sso.test.ts` adds the malformed encrypted-token regression; `raw/test-unit.txt` shows the expected warning log and a passing test run.
- Gaps:
  - No intentional corruption was performed against live production user secrets; proof is via targeted unit regression and code-path inspection.

### AC3
- Status: PASS
- Proof:
  - Historical production log snapshot shows the original moon request ballooned to 8 iterations with `get_universe_*`, 3 `web_search` attempts, 2 `sde_sql` calls, and `total_in=117389`.
  - `src/agent/tools.ts` adds a deterministic `count_moons` tool backed by local `sde_raw_records` / `mapPlanets`, and `src/agent/prompts.ts` routes current-region moon questions into it.
  - Post-fix production reproduction in `.agent/tasks/telegram-runtime-hardening/raw/prod-repro-post-fix.txt` shows the same prompt finishing with exactly one tool call (`count_moons`) and 2 model iterations, returning `Sinq Laison -> 4104 moons`.
  - Direct proxy probe in `.agent/tasks/telegram-runtime-hardening/raw/proxy-latency-post-fix.txt` shows a minimal `/responses` request returns in about 0.8s, separating transport latency from tool-loop overhead.
- Gaps:
  - The post-fix reproduction still took about 30.3s overall because it required two Responses round-trips with the full Telegram prompt context; this is slower than ideal but no longer due to `web_search` drift.

### AC4
- Status: PASS
- Proof:
  - The decrypt-failure fix in `src/eve/sso.ts` hardens every private ESI path that depends on `getAccessToken`, including live context, user profile refresh, agent ESI tools, and UI commands routed through `callEsiOperation`.
  - The proxy mismatch fix in `src/agent/executor.ts` hardens every warm continuation that sends `function_call_output` items with `previous_response_id`.
  - `src/agent/tools.ts` now exposes `sde_raw_records` / `mapPlanets` in the SDE schema text, which reduces recurrence for adjacent static celestial-count queries that previously lacked discoverability.
  - `docs/RELIABILITY.md` documents the hardened behavior for proxy recovery, relink-required auth degradation, and deterministic moon-count routing.
- Gaps:
  - Historical Telegram polling conflicts (`getUpdates` 409 / `setMyCommands` 429) remain visible in production logs and were intentionally left out of scope for this task.

### AC5
- Status: PASS
- Proof:
  - `.agent/tasks/telegram-runtime-hardening/raw/prod-pm2-log-snapshot.txt` distinguishes app/runtime failures (tool-state mismatch, decrypt/auth throws) from unrelated Telegram polling noise.
  - `.agent/tasks/telegram-runtime-hardening/raw/proxy-latency-post-fix.txt` isolates proxy behavior with a direct `/responses` probe.
  - `.agent/tasks/telegram-runtime-hardening/raw/prod-deploy.txt` proves production is running the deployed commit and PM2 process is online.
  - Local verification artifacts exist for unit tests, typecheck, lint, and build under `.agent/tasks/telegram-runtime-hardening/raw/`.
- Gaps:
  - Production evidence uses a server-local reproduction for the moon path after deploy instead of waiting for another organic Telegram user turn.

## Commands run
- `npm run test -- tests/unit/warm-cold-path.test.ts tests/unit/moon-count.test.ts tests/unit/sso.test.ts tests/unit/tools.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `git push origin master`
- `ssh root@144.31.223.134 'cd /opt/eveai && git pull --ff-only origin master && npm run build && pm2 restart eveai --update-env'`
- server-local reproduction of `Сколько лун в моем регионе?` against `/opt/eveai`
- direct proxy probe against `http://127.0.0.1:8080/v1/responses`

## Raw artifacts
- `.agent/tasks/telegram-runtime-hardening/raw/build.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/lint.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/prod-deploy.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/prod-pm2-log-snapshot.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/prod-repro-post-fix.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/proxy-latency-post-fix.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/test-integration.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/test-unit.txt`
- `.agent/tasks/telegram-runtime-hardening/raw/typecheck.txt`

## Known gaps
- No fresh organic Telegram user message after deploy was available to observe the fixed moon path through PM2 logs alone.
- PM2 log timestamps are coarse; the server-local reproduction was used to produce a deterministic post-fix proof.
