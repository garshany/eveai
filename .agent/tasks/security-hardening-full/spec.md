# Task Spec: security-hardening-full

## Metadata
- Task ID: security-hardening-full
- Created: 2026-03-27T20:05:31+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- CLAUDE.md
- eveai-threat-model.md
- ARCHITECTURE.md
- docs/SECURITY.md
- docs/RELIABILITY.md
- docs/product-specs/web-dashboard.md

## Original task statement
Implement a full remediation pass for the repository-grounded risks documented in eveai-threat-model.md. Fix the multi-user authorization drift between user_id and legacy chat_id ownership paths, harden public-bot resource controls, prevent prompt-context injection from USER.md and similar untrusted profile data, harden Telegram-to-web handoff/session flow, and reduce blast radius of stored sensitive data. Update matching docs, produce proof-loop artifacts, and drive the loop to PASS.

## Acceptance criteria
- AC1: Multi-user authorization for EVE linking, character selection, thread ownership, and callback state is anchored to `user_id` on live paths. Legacy `telegram_sessions.oauth_state` is no longer accepted by the EVE callback, and user-scoped code paths no longer fall back to `chat_id` when a real `user_id` is available.
- AC2: Telegram request handling has explicit in-process abuse controls for public multi-user use: one active agent request per chat, bounded recent request rate per Telegram user/chat, and a global active-request ceiling with user-facing overload errors plus regression coverage.
- AC3: Telegram-to-web handoff no longer sends the one-time bearer token in a server-observed query string. The browser completes handoff through a fragment-driven flow and a POST exchange endpoint, with updated route coverage and docs.
- AC4: Model-facing profile context is hardened against prompt injection without stripping gameplay detail from `USER.md`. Generated `USER.md` keeps full in-game information, while prompt ingestion treats that content as untrusted data with explicit delimiting and prompt-safety handling.
- AC5: Unlinking a character reduces retained sensitive state. When a character no longer has active links, encrypted token material and generated profile artifacts for that user/chat are removed, with regression coverage and updated security docs.

## Constraints
- Preserve the repository hard invariants from `AGENTS.md`.
- Keep the app single-process Node.js with SQLite only. No Redis, queues, workers, or background services.
- Do not expose raw secrets, refresh logic, pagination internals, or shell access to model-facing code.
- Keep private ESI access gated by `get_eve_capabilities`.
- Maintain TypeScript strict-mode compatibility and existing product boundaries: Telegram remains the primary interface, web remains support/auth infrastructure.
- Update matching docs in `docs/` in the same change when runtime behavior changes.
- Keep all repo-task-proof-loop artifacts under `.agent/tasks/security-hardening-full/`.

## Non-goals
- Re-architecting the app into multiple services or changing the single-process deployment model.
- Replacing Telegram long polling with webhooks.
- Changing external provider behavior for Telegram, EVE SSO, ESI, OpenAI-compatible backends, or zKillboard.
- Solving host-level hardening beyond what can be expressed in repo docs and runtime behavior.

## Verification plan
- Build: `npm run build`
- Unit tests: `npm test -- --runInBand` or repository-equivalent `npm test`
- Integration tests: covered via `npm test` plus targeted auth/Telegram assertions in Vitest integration suites
- Lint: `npm run lint`
- Manual checks:
  - confirm handoff link no longer embeds token in server-observed query params
  - confirm callback path rejects legacy `oauth_state` fallback
  - confirm unlink removes retained profile/token state when the link set becomes empty
