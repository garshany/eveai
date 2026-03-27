# Evidence Bundle: telegram-region-moons-debug

## Summary
- Overall status: PASS
- Last updated: 2026-03-27T23:47:00+03:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts) now resolves live location through local SDE with `system + constellation + region` via `resolveSystemLocationContext(...)`.
  - `fetchLiveContext(...)` now includes `Регион: <name>` in prompt-facing live context when current location is available.
  - [src/agent/prompts.ts](/home/antipedik/eveai/src/agent/prompts.ts) now explicitly tells the model to interpret "мой регион" and similar phrasing from current live context instead of asking the user to repeat the region name.
- Gaps:
  - Not deployed automatically as part of this evidence bundle.

### AC2
- Status: PASS
- Proof:
  - The fix stays inside the existing `fetchLiveContext(...)` path, which already calls `getEveCapabilities(...)` before private ESI location access.
  - Live-context failure still returns `null`; the new code only adds a warning log and does not expose tokens or raw secret material to the model.
  - No changes were made to token storage, refresh flow, or model-visible secret boundaries.
- Gaps:
  - Production token decrypt failures observed on the server remain an operational issue outside this code-only fix.

### AC3
- Status: PASS
- Proof:
  - [tests/unit/warm-cold-path.test.ts](/home/antipedik/eveai/tests/unit/warm-cold-path.test.ts) adds regression coverage proving `system -> constellation -> region` resolution from SDE for live context.
  - [tests/unit/prompts.test.ts](/home/antipedik/eveai/tests/unit/prompts.test.ts) proves the authenticated prompt carries live region context and the "мой регион" instruction.
  - `npm run test -- tests/unit/warm-cold-path.test.ts tests/unit/prompts.test.ts` passed; raw output: [.agent/tasks/telegram-region-moons-debug/raw/test-unit.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/test-unit.txt)
  - `npm run typecheck` passed; raw output: [.agent/tasks/telegram-region-moons-debug/raw/typecheck.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/typecheck.txt)
  - `npm run lint` passed; raw output: [.agent/tasks/telegram-region-moons-debug/raw/lint.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/lint.txt)
  - `npm run build` passed; raw output: [.agent/tasks/telegram-region-moons-debug/raw/build.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/build.txt)
- Gaps:
  - No separate integration test was added because the fix stays inside prompt/live-context shaping.

### AC4
- Status: PASS
- Proof:
  - Production server investigation captured in [.agent/tasks/telegram-region-moons-debug/raw/server-findings.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/server-findings.txt).
  - Server findings proved `/opt/eveai` was running checkout `3edf505...`, behind the latest pushed local repository state.
  - Server findings also separated two runtime issues:
    - recovered proxy tool-state mismatch (`No tool call found for function call output with call_id ...`)
    - private ESI decrypt failures (`Unsupported state or unable to authenticate data`)
  - Manual server reproductions showed Codex proxy `/responses` communication itself was functional for fresh turns and that the app-side prompt/live-context gap was a distinct problem.
- Gaps:
  - This artifact set records the production investigation but does not claim that every unrelated server-side operational issue is fixed.

## Commands run
- `npm run test -- tests/unit/warm-cold-path.test.ts tests/unit/prompts.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- Manual server checks over SSH:
  - `pm2 ls`
  - `pm2 logs --lines 120 --nostream`
  - `git rev-parse HEAD` in `/opt/eveai`
  - targeted `node --input-type=module` reproductions for `handleAgentMessage`, `getEveCapabilities`, and `callEsiOperation`

## Raw artifacts
- [.agent/tasks/telegram-region-moons-debug/raw/build.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/build.txt)
- [.agent/tasks/telegram-region-moons-debug/raw/test-unit.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/test-unit.txt)
- [.agent/tasks/telegram-region-moons-debug/raw/test-integration.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/test-integration.txt)
- [.agent/tasks/telegram-region-moons-debug/raw/lint.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/lint.txt)
- [.agent/tasks/telegram-region-moons-debug/raw/typecheck.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/typecheck.txt)
- [.agent/tasks/telegram-region-moons-debug/raw/server-findings.txt](/home/antipedik/eveai/.agent/tasks/telegram-region-moons-debug/raw/server-findings.txt)

## Known gaps
- Production deployment was not yet part of the evidence at the moment this bundle was written.
- Server PM2 logs show separate private-token decrypt failures that may require operational remediation if they recur after deployment.
