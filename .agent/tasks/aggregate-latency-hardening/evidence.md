# Evidence Bundle: aggregate-latency-hardening

## Summary
- Overall status: PASS
- Last updated: 2026-03-28T00:46:36+03:00
- Verified local commit: `e24a991`
- Deployed production commit: `e24a991`

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - `src/agent/executor.ts` now detects simple static aggregate count goals, resolves current-location aliases, and routes deterministic geography counts before the generic model loop.
  - `src/agent/tools.ts` already exposes deterministic local-SDE counters for moons and generic universe objects across system, constellation, and region scopes.
  - `tests/unit/static-aggregate.test.ts` covers current-region counts, bare-name counts, asteroid belts, English phrasing, and moon-in-constellation routing.
  - `.agent/tasks/aggregate-latency-hardening/raw/runtime-repro.txt` shows executor-level fast-path answers for region systems, bare-name station counts, and current-constellation moon counts without exploratory tools.

### AC2
- Status: PASS
- Proof:
  - `src/agent/executor.ts` fetches live context only when the request actually needs current location or ship state.
  - `src/agent/executor.ts` finalizes deterministic static aggregate answers before `runNativeAgentLoop`, eliminating the extra model round-trip for those requests.
  - `src/agent/prompts.ts` adds a dedicated `static_aggregate` prompt mode that excludes long memory/profile payloads and steers the model to the reduced local toolset only.
  - `.agent/tasks/aggregate-latency-hardening/raw/test-unit.txt` and `.agent/tasks/aggregate-latency-hardening/raw/runtime-repro.txt` show the bounded fast-path completing directly with deterministic answers.
  - `.agent/tasks/aggregate-latency-hardening/raw/prod-runtime-repro.txt` confirms the same bounded behavior on the deployed production checkout.

### AC3
- Status: PASS
- Proof:
  - `src/agent/prompts.ts` now explicitly routes moon-in-constellation and current-location aliases (`мой регион`, `current region`, `here`) into the deterministic local path.
  - `tests/unit/prompts.test.ts` verifies the compact static-aggregate prompt mode excludes full-loop baggage and keeps the routing hints.
  - `tests/unit/tools.test.ts` verifies the reduced `static_aggregate` toolset contains only `count_moons`, `count_universe_objects`, and `sde_sql`.
  - `docs/RELIABILITY.md` and `docs/exec-plans/completed/aggregate-latency-hardening.md` document the supported static aggregate classes and reduced-path behavior.

### AC4
- Status: PASS
- Proof:
  - `.agent/tasks/aggregate-latency-hardening/raw/test-unit.txt` shows targeted unit/regression coverage passing.
  - `.agent/tasks/aggregate-latency-hardening/raw/typecheck.txt` shows strict TypeScript passes.
  - `.agent/tasks/aggregate-latency-hardening/raw/lint.txt` shows lint passes.
  - `.agent/tasks/aggregate-latency-hardening/raw/build.txt` shows full build passes.
  - `.agent/tasks/aggregate-latency-hardening/raw/prod-deploy.txt` shows the server fast-forwarded to `e24a991`, rebuilt, and restarted successfully under PM2.

## Commands run
- `npm run test -- tests/unit/static-aggregate.test.ts tests/unit/tools.test.ts tests/unit/prompts.test.ts tests/unit/warm-cold-path.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `git push origin master`
- `ssh root@144.31.223.134 'cd /opt/eveai && git pull --ff-only origin master && npm run build && pm2 restart eveai --update-env && git rev-parse --short HEAD && pm2 status eveai'`
- server-local runtime repro for:
  - `Сколько систем в моем регионе?`
  - `Сколько станций в Jita?`
  - `Сколько лун в моем созвездии?`

## Raw artifacts
- `.agent/tasks/aggregate-latency-hardening/raw/build.txt`
- `.agent/tasks/aggregate-latency-hardening/raw/lint.txt`
- `.agent/tasks/aggregate-latency-hardening/raw/prod-deploy.txt`
- `.agent/tasks/aggregate-latency-hardening/raw/prod-runtime-repro.txt`
- `.agent/tasks/aggregate-latency-hardening/raw/runtime-repro.txt`
- `.agent/tasks/aggregate-latency-hardening/raw/test-unit.txt`
- `.agent/tasks/aggregate-latency-hardening/raw/typecheck.txt`

## Residual risks
- Multi-target aggregate requests such as `в Jita и Perimeter` still fall back to the general loop; this task keeps intent detection conservative by design.
- The fix reduces avoidable loop/context overhead for deterministic static counts, but it does not eliminate model inference latency for unrelated multi-step questions.
