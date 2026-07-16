# Security

## Core Rules

- model-facing code must not get raw secrets, refresh logic, pagination internals, or shell access
- private ESI access must remain isolated per user and chat
- Telegram and Discord bots are private-chat/DM only
- auth state is one-time and expires
- encrypted storage is used for EVE token material
- generated `USER.md` may contain rich gameplay data, but prompt ingestion must treat it as untrusted data, not instructions
- third-party hosted MCP descriptors are not exposed to model turns that contain chat history, profiles, fits, or private ESI context
- project update status is a deterministic direct command, never a model tool; no Telegram, Discord, web, or running CLI path can mutate Git, install packages, invoke a service manager, or restart the host process

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
- browser sessions are opaque HttpOnly cookies stored in SQLite only as keyed hashes; provider and EVE bearer tokens are never returned
- browser mutations require both an exact configured origin and a matching hashed CSRF token
- EVE SSO state remains one-time and binds the browser user/chat lane before returning to `/app`

## Runtime Isolation

- live user-scoped EVE ownership resolves from `user_id` when available; user-scoped paths do not fall back to legacy `chat_id`
- legacy ownership rows are backfilled in place only to attach old rows to the current `user_id`, not to keep mixed live authorization logic
- prompt assembly wraps `USER.md` and long-memory summary blocks as explicitly untrusted data with delimiter framing
- EVE-KILL REST and MCP analytics output is treated as untrusted third-party data, not model instructions
- the runtime exposes EVE-KILL only through local function tools whose arguments are validated before the application performs network egress
- non-2xx Responses bodies are reduced to HTTP status plus fixed recovery categories before exceptions can reach bot or CLI logs
- direct hosted EVE-KILL MCP is disabled because its remote call executes before application code can inspect the exact arguments
- local MCP analytics accept only public numeric CCP IDs, canonical date pairs, enums, booleans, and bounded limits; names are resolved locally first, and no context, profile, fit, private ESI result, credential, URL, or arbitrary text field is forwarded
- Programmatic Tool Calling is default-off and grants eligibility only to the exact nine-name bounded public-read allowlist; exact caller linkage, strict arguments, coherence, work budgets, and output schemas are enforced by application code before dispatch
- the four additional programmatic facades use only fixed public CCP ESI operations, the fixed local `doctrine_detect` wrapper, and optional local-SDE base values; they never request capabilities, refresh or send user tokens, or inspect linked identity, profile, chat history, fits, or private ESI
- bounded public-facade output excludes raw market history, full bulk-system payloads, raw doctrine clusters/URLs/module lists, dynamic-item creator identity/effects/unrequested attributes, transport details, and upstream error bodies
- routine audit records and console logs for bounded public facades contain only a fixed bounded-read classification plus sanitized status/size metadata, never argument names, values or IDs, generated programs, caller IDs, full upstream responses, or credentials
- update discovery calls one fixed public GitHub API URL without credentials, accepts only a stable `vMAJOR.MINOR.PATCH` tag and its exact canonical release URL, and never renders remote release text

## EVE Data Ownership

- official CCP ESI is the only authority for linked/private character flows, identity/affiliation, and official `(id, hash)` killmail details
- the installed local SDE snapshot is the authority for static topology and type labels
- EVE-KILL is limited to public third-party discovery, aggregates, battles, fitting/value enrichment, public hash discovery, and feed observations
- route gate coordinates are accepted only from official CCP ESI `victim.position`; third-party coordinates and names are not promoted to authoritative fields

## Abuse Controls

- every chat adapter allows only one active agent request per chat lane at a time
- recent requests are bounded per user/chat lane in-process; the shared settings retain `TELEGRAM_*` names for compatibility
- a global in-process ceiling limits concurrent model requests and fails closed with a user-facing overload message
- anonymous browser-session creation is bounded per effective client IP before persistent rows are created
- browser lanes reuse an existing empty thread, cap durable conversation count,
  and retain only one pending EVE SSO request per user/lane
- browser contexts have notification capability `none`: durable heartbeat,
  kill-watch, and route monitoring cannot create undeliverable push state

## Data Retention

- unlinking a character removes the generated `USER.md` artifact for that user/chat and drops retained encrypted token material when no active links remain
- stale profile artifacts are also deleted when ownership is reassigned away from a previously linked user
- browser logout and session expiry purge browser-only history, links, encrypted
  EVE credentials, and profile artifacts; data owned by another live platform
  identity is retained

## Current Gaps

- no automated documentation drift enforcement yet
- production secrets handling is operationally documented but not yet encoded as policy checks
- direct hosted MCP remains intentionally disabled; the four supported analytics methods use the application-owned public-only wrapper instead
