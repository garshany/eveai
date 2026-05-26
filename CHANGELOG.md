# Changelog

## [2.1.3] - 2026-05-26

### Added

- Added `npm run smoke:openai` for authenticated `/v1/responses` runtime checks without logging API keys.

## [2.1.2] - 2026-05-26

### Changed

- Prepared the repository for public self-hosted use with sanitized deployment documentation and package metadata.
- Updated the OpenAI integration defaults for GPT-5.5 on the Responses API.
- Added `OPENAI_TEXT_VERBOSITY` so operators can tune answer length without code changes.
- Documented the recommended OpenAI configuration: `gpt-5.5`, official `/v1/responses`, `reasoning.effort=medium`, concise Telegram output, `store=false`, prompt cache keys, and stateless continuation.

### Verified

- Full local check: TypeScript, Vitest, and ESLint.
- Public artifact audit: no private SSH, server IP, deployment runbook, model proxy endpoint, or high-signal secret markers.
- Responses payload tests cover model, reasoning effort, text verbosity, streaming, `store=false`, prompt cache key, and `phase` preservation for stateless replay.

## [2.1.1] - 2026-04-09

### Fixed

- Hardened Responses API request payload compatibility by sending optional model parameters only when configured.
- Improved SSE stream parsing so function calls can be recovered from stream events if terminal output is incomplete.
- Expanded project documentation for EVE-KILL, EVE-Scout, OSINT, scan analysis, and intel workflows.

## [2.1.0] - 2026-04-09

### Added

- Dynamic reasoning effort selection for simple, standard, and complex EVE tasks.
- EVE-Scout tools for wormhole navigation, Thera/Turnur routes, storm observations, and wormhole type lookups.
- `analyze_scan` for D-scan, fleet, and local parsing.
- `intel_note` for persistent personal intel notes.
- `osint_infer_home` for probabilistic residence, staging, and hunting-system inference.
- Ship-aware tactical context from active ESI ship/fitting data.

### Improved

- Route danger analysis with gate-camp signals and recent killmail context.
- Bounded retry/backoff for external API clients.
- Async hot-path file I/O for user profiles, fitting persistence, and cached metadata.

## [2.0.0] - 2026-03-15

### Added

- Initial multi-user release with Telegram bot, EVE SSO, native ESI tools, local SDE SQLite, and the Responses API agent loop.
