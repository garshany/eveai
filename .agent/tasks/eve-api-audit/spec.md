# Task Spec: eve-api-audit

## Metadata
- Task ID: eve-api-audit
- Created: 2026-03-25T00:09:38+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- docs/SECURITY.md
- docs/RELIABILITY.md
- docs/references/eve-platform-reference-llms.txt
- Official EVE Developer Documentation:
  - https://developers.eveonline.com/docs/services/esi/best-practices/
  - https://developers.eveonline.com/docs/services/esi/pagination/x-pages/
  - https://developers.eveonline.com/docs/services/esi/rate-limiting/
  - https://developers.eveonline.com/docs/services/sso/

## Original task statement
Изучи документацию API EVE Online и проверь, что мы работаем с ней правильно

## Acceptance criteria
- AC1: The EVE SSO flow matches the documented authorization-code behavior: the app redirects users to the official authorization endpoint with `response_type=code`, `client_id`, `redirect_uri`, `scope`, and `state`; the callback validates state before exchanging the code; token validation checks the documented issuer, audience, and character-subject shape.
- AC2: ESI requests follow the documented transport rules: all ESI calls send a descriptive `User-Agent` and `X-Compatibility-Date`, private calls stay scoped to the linked character, and the implementation does not expose raw secrets, refresh logic, or pagination internals to model-facing code.
- AC3: ESI caching, retry, and pagination behavior matches the documented expectations: GET requests use cache revalidation, error retries are bounded for `420`, `429`, and transient `5xx`, and `X-Pages` collection fails closed instead of silently truncating data when the configured page limit would be exceeded or the page snapshot changes mid-collection.
- AC4: Private ESI access remains gated by a fresh `get_eve_capabilities` check and by granted scopes for the active Telegram user/chat before any private ESI operation is executed.
- AC5: The repository documentation and runtime checks agree on the EVE integration behavior, so the codebase presents one consistent model for SSO, ESI transport, and private-access boundaries.

## Constraints
- Preserve the existing single-process Node.js architecture.
- Do not introduce workers, queues, Redis, Postgres, or webhooks.
- Keep Telegram on grammY long polling.
- Keep private ESI access isolated per Telegram user and chat.
- Keep the model-facing surface free of tokens, refresh details, pagination internals, retry mechanics, and other secrets.
- Treat the official EVE Developer Documentation as the primary source when checking API behavior.

## Non-goals
- Rewriting the auth flow into a different OAuth pattern.
- Expanding the set of supported ESI operations.
- Changing the product surface beyond what is necessary to align with the documented EVE integration behavior.
- Reworking unrelated SDE or Telegram functionality.

## Verification plan
- Build: run the standard repo build/typecheck path and targeted EVE-related checks if needed.
- Unit tests: run focused tests around SSO JWT validation, ESI client transport, capability gating, and scope checks.
- Integration tests: run auth and ESI seam coverage that exercises the callback flow and private-access boundaries.
- Lint: run the repository lint check.
- Manual checks: compare the live code paths against the official EVE docs for SSO, best practices, rate limiting, and `X-Pages` pagination.

## Assumptions
- The current official EVE Developer Documentation pages are the source of truth for runtime behavior.
- This task is an audit of the repository's EVE integration, not a redesign of EVE auth or ESI modeling.
- Any mismatch discovered during implementation should be fixed minimally and documented in the matching repo docs if behavior changes.
