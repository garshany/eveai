# Task Spec: telegram-region-moons-debug

## Metadata
- Task ID: telegram-region-moons-debug
- Created: 2026-03-27T20:32:33+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- CLAUDE.md

## Original task statement
Investigate and fix the production/dev Telegram bot failure when a user asks in Russian 'Сколько лун в моем регионе'. Verify whether the app communicates correctly with Codex proxy 2/system prompts/API, identify the root cause across Telegram, agent, proxy, and EVE tool/capability flow, implement the minimal safe fix, and leave proof artifacts.

## Acceptance criteria
- AC1: For linked-character Telegram turns, live context passed into the developer prompt must include the current region name derived from the character's current solar system via local SDE, so "мой регион" questions do not require the model to ask the user for the region name first.
- AC2: Live context enrichment must preserve existing safety behavior: it may use private ESI only through the existing capability-gated path and must fail closed to `null` without leaking tokens or raw secret errors into model-facing prompt text.
- AC3: Regression coverage must prove the location-chain enrichment logic resolves `system -> constellation -> region` from SDE and preserves existing cold/warm executor behavior.
- AC4: Evidence must include the production-server investigation result distinguishing proxy/API behavior from app-side behavior, with concrete proof for the observed root causes.

## Constraints
- Keep the app single-process and within existing Telegram/Fastify/runtime boundaries.
- Do not expose tokens, refresh flow, secrets, or internal auth material to the model.
- Keep the fix minimal and localized; do not redesign proxy integration or introduce new services.
- If behavior changes, update the matching repo docs in the same change.

## Non-goals
- Rotating or re-encrypting broken production EVE tokens.
- Reworking Codex proxy implementation or transport protocol.
- Building a new dedicated moon-count tool or a large intent-router.
- Performing production deployment in this task artifact set.

## Verification plan
- Build: `npm run build`
- Unit tests: `npm run test -- tests/unit/warm-cold-path.test.ts`
- Integration tests: not planned unless the fix crosses Telegram/auth seams
- Lint: `npm run lint`
- Manual checks: reproduce the linked-character region-moons question path and inspect production logs/findings
