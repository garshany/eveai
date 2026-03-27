# Evidence Bundle: security-hardening-full

## Summary
- Overall status: PASS
- Last updated: 2026-03-27T23:25:21+03:00
- Scope: multi-user auth isolation, Telegram ingress abuse controls, fragment-based handoff exchange, prompt-safe `USER.md` ingestion, and retained-state cleanup

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - [src/auth/auth-request.ts](/home/antipedik/eveai/src/auth/auth-request.ts) keeps live callback state in `auth_requests`; legacy `protectLegacyOauthState` helpers were removed.
  - [src/web/auth-routes.ts](/home/antipedik/eveai/src/web/auth-routes.ts) accepts only pending `auth_requests` state on `GET /auth/eve/callback`; there is no live fallback to `telegram_sessions.oauth_state`.
  - [src/eve/sso.ts](/home/antipedik/eveai/src/eve/sso.ts) anchors live user-scoped character listing, activation, active-character resolution, and unlinking to `user_id` when it exists; `chat_id` fallback remains only for contexts that truly lack a resolved `user_id`.
  - [src/db/migrations.ts](/home/antipedik/eveai/src/db/migrations.ts) clears retained legacy `telegram_sessions.oauth_state` values during migration.
  - [tests/unit/auth-routes.test.ts](/home/antipedik/eveai/tests/unit/auth-routes.test.ts) and [tests/unit/sso.test.ts](/home/antipedik/eveai/tests/unit/sso.test.ts) cover callback-state and user-owned character behavior.
- Gaps:
  - None for the current single-process deployment model.

### AC2
- Status: PASS
- Proof:
  - [src/telegram/request-guard.ts](/home/antipedik/eveai/src/telegram/request-guard.ts) enforces one active request per chat, bounded recent request rate per actor, and a global active-request ceiling.
  - [src/config.ts](/home/antipedik/eveai/src/config.ts) exposes the request-window, per-window limit, and global active-request ceiling as runtime config.
  - [src/telegram/handlers.ts](/home/antipedik/eveai/src/telegram/handlers.ts) applies the guard before agent execution and returns user-facing overload/retry messages.
  - [tests/unit/telegram-request-guard.test.ts](/home/antipedik/eveai/tests/unit/telegram-request-guard.test.ts) proves overlap rejection, global overload rejection, rolling-window throttling, and window expiry.
- Gaps:
  - Controls are intentionally in-memory and do not coordinate across multiple app instances.

### AC3
- Status: PASS
- Proof:
  - [src/telegram/handlers.ts](/home/antipedik/eveai/src/telegram/handlers.ts) now opens `/auth/tg-handoff#token=...` instead of a query-bearing URL.
  - [src/web/frontend.ts](/home/antipedik/eveai/src/web/frontend.ts) serves the dedicated handoff shell, and [client/src/app.tsx](/home/antipedik/eveai/client/src/app.tsx) reads the fragment locally, clears it from the address bar, and completes session creation with `POST /auth/tg-handoff/exchange`.
  - [src/web/auth-routes.ts](/home/antipedik/eveai/src/web/auth-routes.ts) implements the POST exchange endpoint and returns `Cache-Control: no-store`.
  - [tests/unit/frontend-handoff.test.ts](/home/antipedik/eveai/tests/unit/frontend-handoff.test.ts) and [tests/unit/auth-routes.test.ts](/home/antipedik/eveai/tests/unit/auth-routes.test.ts) cover the new handoff route and exchange flow.
- Gaps:
  - None identified in the current browser-assisted handoff path.

### AC4
- Status: PASS
- Proof:
  - [src/eve/user-profile.ts](/home/antipedik/eveai/src/eve/user-profile.ts) still generates a full `USER.md` with character identity, status, skills, attributes, queue, implants, clones, fittings, and wallet data.
  - [src/agent/prompts.ts](/home/antipedik/eveai/src/agent/prompts.ts) frames `USER.md` and memory summary as untrusted data blocks, explicitly not instructions, and prefixes each line as quoted data.
  - [tests/unit/user-profile.test.ts](/home/antipedik/eveai/tests/unit/user-profile.test.ts) asserts that rich gameplay sections remain present and dangerous markup is sanitized.
  - [tests/unit/prompts.test.ts](/home/antipedik/eveai/tests/unit/prompts.test.ts) verifies the untrusted-data framing in the developer prompt.
- Gaps:
  - Rich profile content still consumes prompt budget by design; this task hardens trust boundaries rather than reducing profile size.

### AC5
- Status: PASS
- Proof:
  - [src/eve/user-profile-storage.ts](/home/antipedik/eveai/src/eve/user-profile-storage.ts) centralizes profile artifact resolution and deletion.
  - [src/eve/sso.ts](/home/antipedik/eveai/src/eve/sso.ts) deletes the generated profile artifact on unlink and drops retained `eve_accounts` token material when no links remain.
  - [src/web/auth-routes.ts](/home/antipedik/eveai/src/web/auth-routes.ts) clears stale active-character state and deletes stale profile artifacts when character ownership is reassigned.
  - [tests/unit/sso.test.ts](/home/antipedik/eveai/tests/unit/sso.test.ts) covers unlink cleanup for detached characters and profile artifacts.
- Gaps:
  - None for character-level retained state inside this repository boundary.

## Commands run
- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm test -- tests/unit/auth-routes.test.ts tests/unit/telegram-request-guard.test.ts tests/unit/frontend-handoff.test.ts tests/unit/prompts.test.ts tests/unit/sso.test.ts tests/unit/user-profile.test.ts`
- `python3 .agents/skills/repo-task-proof-loop/scripts/task_loop.py validate --task-id security-hardening-full`

## Raw artifacts
- .agent/tasks/security-hardening-full/raw/build.txt
- .agent/tasks/security-hardening-full/raw/test-unit.txt
- .agent/tasks/security-hardening-full/raw/test-integration.txt
- .agent/tasks/security-hardening-full/raw/lint.txt
- .agent/tasks/security-hardening-full/raw/typecheck.txt
- .agent/tasks/security-hardening-full/raw/screenshot-1.png

## Known gaps
- Telegram abuse controls are in-memory because the application is explicitly single-process.
