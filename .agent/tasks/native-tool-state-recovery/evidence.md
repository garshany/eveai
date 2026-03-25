# Evidence: native-tool-state-recovery

## Overall

- Status: PASS
- Basis: AC1-AC5 are satisfied by the current code and the captured verification outputs.

## AC1

- Status: PASS
- Criterion: If native responses loop loses proxy-side tool state (`No tool call found for function call output with call_id ...`), the agent should not fail immediately on the first occurrence.
- Proof:
  - [executor.ts](/home/antipedik/eveai/src/agent/executor.ts) now catches `createNativeResponse` failures inside `runNativeAgentLoop`.
  - [executor.ts](/home/antipedik/eveai/src/agent/executor.ts) detects the specific tool-state mismatch via `shouldRecoverFromToolStateMismatch(...)`.
  - On first hit, the loop clears warm continuation and retries instead of surfacing the raw error.

## AC2

- Status: PASS
- Criterion: Recovery must reset warm continuation and rebuild from SQLite-backed cold context without discarding already recorded tool results.
- Proof:
  - [executor.ts](/home/antipedik/eveai/src/agent/executor.ts) now uses `buildToolStateRecoveryContext(...)`.
  - Recovery context starts from `buildSmartContext(...)` and appends a summary built from recent `role='tool'` SQLite rows via `buildRecentToolSummaryMessage(...)`.
  - [executor.ts](/home/antipedik/eveai/src/agent/executor.ts) clears `last_response_id` with `saveLastResponseId(db, threadId, null)` before retrying.

## AC3

- Status: PASS
- Criterion: Unit-level regression coverage exists for recovery context / cold fallback behavior.
- Proof:
  - [warm-cold-path.test.ts](/home/antipedik/eveai/tests/unit/warm-cold-path.test.ts) now covers `buildToolStateRecoveryContext(...)`.
  - [warm-cold-path.test.ts](/home/antipedik/eveai/tests/unit/warm-cold-path.test.ts) now covers `shouldRecoverFromToolStateMismatch(...)`.
  - Raw test output is captured in [test-unit.txt](/home/antipedik/eveai/.agent/tasks/native-tool-state-recovery/raw/test-unit.txt).

## AC4

- Status: PASS
- Criterion: Reliability docs describe cold recovery on proxy-side tool-state loss.
- Proof:
  - [RELIABILITY.md](/home/antipedik/eveai/docs/RELIABILITY.md) now documents cold recovery when proxy-side tool-call state is lost during a warm turn.

## AC5

- Status: PASS
- Criterion: Relevant tests and build pass.
- Proof:
  - Unit tests: [test-unit.txt](/home/antipedik/eveai/.agent/tasks/native-tool-state-recovery/raw/test-unit.txt)
  - Build: [build.txt](/home/antipedik/eveai/.agent/tasks/native-tool-state-recovery/raw/build.txt)

## Commands Run

- `npm run test -- tests/unit/warm-cold-path.test.ts tests/unit/native-responses.test.ts`
- `npm run build:server`

## Raw Artifacts

- [test-unit.txt](/home/antipedik/eveai/.agent/tasks/native-tool-state-recovery/raw/test-unit.txt)
- [build.txt](/home/antipedik/eveai/.agent/tasks/native-tool-state-recovery/raw/build.txt)
