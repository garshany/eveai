# CLI Durable Notifications And Safe Updates

Status: completed
Started: 2026-07-14
Completed: 2026-07-14

## Problem

The terminal CLI shared the conversational agent but disabled the durable
producers used by route monitoring and EVE-KILL watches in Telegram and
Discord. Operators also lacked a consistent way to see whether their
self-hosted checkout was behind and a safe, explicit handoff for staging a
canonical release locally.

## Delivered scope

- the open CLI process is a real third outbound platform at `chat_id = 0` for
  feed-backed route/watch notifications;
- app and CLI enforce one process per SQLite runtime so the global feed cursor
  has one owner;
- asynchronous terminal alerts preserve the spinner, readline prompt, input,
  sanitization, and durable delivery contract;
- CLI, Telegram, Discord, and `npm run update:check` expose deterministic
  read-only stable-release status;
- local update staging uses a fixed canonical repository, namespaced ref,
  detached verification, immutable systemd source boundary, backup, activation
  proof, and migration-aware rollback guidance;
- runtime, product, reliability, security, deployment, and threat-model docs
  describe the implemented boundaries.

## Safety boundaries

- no model-facing shell or update tool;
- no checkout/package mutation or restart from any running chat process;
- no force/reset/rebase/stash/merge fallback;
- no notification delivery after the CLI exits;
- heartbeat remains bot-service-only;
- no transport change from the current EVE-KILL HTTP feed poller.

## Decision log

- `chat_id = 0` is an explicit CLI platform, not a Telegram fallback.
- durable CLI means restart-restorable state while the CLI is open, not a
  hidden daemon; events missed while it is closed are not replayed.
- update checks are direct application commands; the model never receives
  process execution capability.
- all chat surfaces are status-only. Installation remains an
  operator/supervisor workflow because lifecycle scripts, migrations,
  activation, and rollback require a host trust boundary.
- CLI exposes feed-backed route/watch tools only; heartbeat remains hidden and
  fails closed.

## Verification

- focused verifier suite: 15 files / 100 tests passed;
- `npm run check`: 72 files / 434 tests, strict TypeScript and ESLint passed;
- `npm run build`, `npm run audit:public`, and `git diff --check` passed;
- a real temporary-DB CLI smoke proved `/version`, clean `/exit`, zero-lane
  identity creation, and process-lock release;
- independent architecture review findings were fixed and rechecked;
- final exact-tree Sol review found no actionable issue;
- fresh proof-loop verdict marked AC1–AC7 `PASS` with zero unresolved problems.
- follow-up review fixed active-turn alerts overwriting partially typed readline
  input; the renderer now suspends its spinner and redraws the exact buffer and
  cursor around alert, activity, and final-answer output.
- the follow-up proof verifier passed AC1–AC4 and confirmed the real Node
  readline buffer `/next` retained cursor index 3 across those output paths.

Local proof artifacts are under `.agent/tasks/cli-durable-updates/` and remain
ignored by Git.
