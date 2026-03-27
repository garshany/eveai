# Security Hardening Full

Status: completed
Started: 2026-03-27
Completed: 2026-03-27

## Goal

Implement the full remediation pass from [eveai-threat-model.md](../../eveai-threat-model.md) for the highest-priority repository-grounded risks:

- multi-user authorization drift between `user_id` and legacy `chat_id`
- public-bot resource exhaustion
- prompt-context injection through generated profile context
- Telegram-to-web handoff token exposure
- excessive retention of sensitive local state

## Workstreams

1. Remove live auth reliance on legacy `oauth_state` and make user ownership authoritative.
2. Add explicit Telegram ingress abuse controls suitable for public multi-user mode.
3. Move handoff completion from query-bearer flow to fragment plus POST exchange.
4. Keep `USER.md` rich while hardening how profile context is ingested by the prompt/runtime.
5. Delete retained token/profile artifacts when a character is fully unlinked.
6. Update tests and security/reliability/product docs in the same change.

## Outcome

- live EVE callback now accepts only `auth_requests` state and no longer trusts legacy `telegram_sessions.oauth_state`
- user-scoped live paths anchor ownership to `user_id`, with migration/backfill used only to attach legacy rows
- Telegram ingress now has overlap rejection, recent-rate limiting, and a global active-request ceiling
- bot-to-web handoff now uses a fragment token plus `POST /auth/tg-handoff/exchange`
- `USER.md` keeps full gameplay detail, but prompt assembly now treats it as untrusted data
- unlink and ownership reassignment remove retained profile artifacts, and fully detached characters lose retained account token material

## Exit Criteria

- `.agent/tasks/security-hardening-full/spec.md` acceptance criteria are all `PASS`
- code, docs, and tests reflect the hardened behavior
- fresh verification under the repo-task-proof-loop returns `PASS`
