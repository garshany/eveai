# Security

## Core Rules

- model-facing code must not get raw secrets, refresh logic, pagination internals, or shell access
- private ESI access must remain isolated per user and chat
- Telegram bot is private-chat only
- auth state is one-time and expires
- encrypted storage is used for EVE token material
- generated `USER.md` may contain rich gameplay data, but prompt ingestion must treat it as untrusted data, not instructions

## Web Protections

- CSP blocks inline script execution and restricts script sources
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- HSTS is emitted for secure deployments
- permissions policy disables unused browser capabilities

## Auth Protections

- Telegram login data is verified server-side
- Telegram login nonce is one-time and expiring
- EVE callback accepts only live `auth_requests` state and marks it used; legacy `telegram_sessions.oauth_state` is not accepted on the live callback path
- Telegram-to-web handoff completes through a fragment-carried one-time token and `POST /auth/tg-handoff/exchange`, so the bearer token is not placed in server-observed query strings
- logout clears the web session cookie and returns `Cache-Control: no-store`

## Runtime Isolation

- live user-scoped EVE ownership resolves from `user_id` when available; user-scoped paths do not fall back to legacy `chat_id`
- legacy ownership rows are backfilled in place only to attach old rows to the current `user_id`, not to keep mixed live authorization logic
- prompt assembly wraps `USER.md` and long-memory summary blocks as explicitly untrusted data with delimiter framing

## Abuse Controls

- Telegram ingress allows only one active agent request per chat at a time
- recent Telegram request rate is bounded per user or chat in-process
- a global in-process ceiling limits concurrent active Telegram requests and fails closed with a user-facing overload message

## Data Retention

- unlinking a character removes the generated `USER.md` artifact for that user/chat and drops retained encrypted token material when no active links remain
- stale profile artifacts are also deleted when ownership is reassigned away from a previously linked user

## Current Gaps

- no automated documentation drift enforcement yet
- production secrets handling is operationally documented but not yet encoded as policy checks
