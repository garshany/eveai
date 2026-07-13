# Security

## Core Rules

- model-facing code must not get raw secrets, refresh logic, pagination internals, or shell access
- private ESI access must remain isolated per user and chat
- Telegram and Discord bots are private-chat/DM only
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

- a bot-issued `/auth/eve/login?state=...` link validates a one-time EVE SSO state before it redirects to CCP
- the EVE callback accepts only a live `auth_requests` state and marks it used before exchanging tokens
- EVE SSO access and refresh tokens are encrypted before local storage
- browser success/error pages do not create a dashboard session or expose bearer tokens

## Runtime Isolation

- live user-scoped EVE ownership resolves from `user_id` when available; user-scoped paths do not fall back to legacy `chat_id`
- legacy ownership rows are backfilled in place only to attach old rows to the current `user_id`, not to keep mixed live authorization logic
- prompt assembly wraps `USER.md` and long-memory summary blocks as explicitly untrusted data with delimiter framing

## Abuse Controls

- Telegram and Discord ingress allow only one active agent request per chat lane at a time
- recent Telegram and Discord request rate is bounded per user or chat lane in-process; the shared settings retain `TELEGRAM_*` names for compatibility
- a global in-process ceiling limits concurrent active Telegram and Discord requests and fails closed with a user-facing overload message

## Data Retention

- unlinking a character removes the generated `USER.md` artifact for that user/chat and drops retained encrypted token material when no active links remain
- stale profile artifacts are also deleted when ownership is reassigned away from a previously linked user

## Current Gaps

- no automated documentation drift enforcement yet
- production secrets handling is operationally documented but not yet encoded as policy checks
