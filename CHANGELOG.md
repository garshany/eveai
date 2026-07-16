# Changelog

## [4.0.0] - 2026-07-16

### Agent orchestration

- Added dependency-aware root-turn planning, a completion goal ledger, effective
  deferred-tool discovery, bounded multi-iteration recovery, and explicit
  terminal failure categories.
- Added application-managed read subagents for parallel public research. Their
  capability surface is limited to nine bounded public-read facades; private ESI,
  chat history, credentials, and write tools never enter delegated prompts.
- Unified direct, parallel-batch, and programmatic tool execution behind shared
  schema validation, identity guards, deadlines, cancellation, and admission.

### Browser and multi-user service

- Added the production browser workspace with anonymous sessions, optional EVE
  SSO, multiple linked characters, active-character switching, bilingual
  least-privilege consent, pilot profile, chat history, and route scan views.
- Replaced synchronous browser turns with a durable SQLite `202` request queue,
  idempotency keys, authenticated SSE, polling recovery, explicit cancellation,
  restart handling, per-user lane serialization, bounded global workers, and
  request-scoped message cleanup.
- Added Turnstile verification, explicit trusted-proxy CIDRs, HTTPS/hostname
  production validation, rate/cost limits, queue health, retention, and safe
  public errors.

### Providers and tools

- Added the fixed CheapVibeCode Codex WebSocket provider while retaining the
  official OpenAI Responses API as the default and rollback path.
- Expanded Programmatic Tool Calling to nine public facades and added bounded
  client tool search, parallel read execution, market-history, system-metric,
  doctrine, and dynamic-item summaries.
- Added process-wide response, read/write tool, and ESI-leaf admission so nested
  fan-out remains bounded across concurrent users and stops on root cancellation.

### Release verification

- Full local gate passed: public artifact audit, strict backend/frontend
  TypeScript, 740 Vitest tests across 101 files, ESLint, and production build.
- Agent evaluation passed 18/18 scenarios. The durable coordinator load harness
  completed 100/100 users with zero stuck requests and eight peak workers.
- Rendered browser verification covered login, request recovery, stable SSE with
  polling fallback, cancellation cleanup, responsive layout, and a clean console.

## [3.3.1] - 2026-07-14

### Security and reliability

- Recoverable failed or incomplete Responses API envelopes now retry before status handling, without processing or dispatching any output from the rejected envelope.
- A later rejected programmatic batch can no longer waive terminal minimum-shape validation for a program that already has accepted calls; fully rejected zero-accepted programs may still report their structured rejection.

## [3.3.0] - 2026-07-14

### Added

- Default-off OpenAI Programmatic Tool Calling for exactly five bounded public-read tools: static geography counts, batched market prices, wormhole-type comparison, system scouting, and compact kill-activity summaries.
- Fixed output schemas, a shared 12,000-character schema-safe serializer, caller/program accounting, atomic batch validation, per-family work budgets, and terminal minimum-shape enforcement.
- Real public-source, OpenAI wire-schema, hosted-program, and negative dispatch-gate smoke matrices with sanitized evidence only.

### Changed

- Public market comparisons always use unauthenticated CCP ESI, even in a linked-character chat lane.
- EVE-Scout system search now uses the current upstream `query` contract and strict local class filtering; wormhole comparison uses a narrow bounded facade.
- Public EVE-KILL summaries expose deterministic aggregates and bounded evidence IDs without raw killmail rows, hashes, participants, fits, or transport internals.
- First-party User-Agent defaults and examples now identify `EVEAI/3.3`.

### Security and reliability

- Programmatic callers cannot reach private ESI, capabilities, SQL, writes, UI, web search, routes, broad Scout tools, raw EVE-KILL tools, or arbitrary unlisted functions.
- Unknown callers, malformed linkage, mixed families, duplicates, overlapping windows, undersized terminal shapes, oversized outputs, and over-budget batches fail closed before unsafe dispatch or final acceptance.
- Override Discord's transitive `undici` dependency to patched `6.27.0`, clearing the release audit without downgrading `discord.js`.

### Release verification

- Full local gate passed: public artifact audit, TypeScript strict check, 511 Vitest tests, ESLint, production build, npm package inspection, real bounded source/wire/program smokes, and independent review.

## [3.2.0] - 2026-07-14

### Added

- Durable EVE-KILL watches and route-monitor alerts in the open terminal CLI, with restart-restorable zero-lane state, prompt-safe asynchronous output, and a shared process lock that prevents competing feed pollers.
- Read-only `/version` and `/update` checks in CLI, Telegram, and Discord plus `npm run update:check`, using strict canonical stable-release validation, bounded network input, and a shared cache.

### Changed

- CLI EVE SSO now preserves `chat_id = 0`, and restored route monitors resolve the real CLI owner for private ESI access.
- CLI activity and durable alerts now suspend the spinner while a next command is partially typed, print output above it, and restore the exact readline buffer/cursor.
- Project metadata now points at the canonical `garshany/eveai` repository.

### Security and reliability

- Update discovery is not a model tool and cannot mutate Git, install packages, invoke a service manager, or restart a running process.

### Release verification

- Full local gate passed: clean dependency install, public artifact audit,
  TypeScript strict check, 434 Vitest tests, ESLint, production build, npm
  package inspection, and independent review.

## [3.1.0] - 2026-07-14

### Added

- Four strict deferred EVE-KILL analytics tools: `doctrine_detect`, `meta_pulse`, `killmail_forensics`, and `coalition_graph`.
- A local public-only MCP wrapper with fixed-endpoint JSON-RPC/SSE transport, pre-egress argument validation, bounded response size/depth/node count, safe error projection, and a four-call per-turn analytics limit.
- Durable process-wide EVE-KILL feed polling with one SQLite cursor, recipient deduplication, restart-safe route-monitor handoff, and platform-aware delivery.
- Same-turn encrypted GPT-5.6 reasoning replay for stateless `store=false` tool loops without persisting provider reasoning in SQLite.

### Changed

- Cut public kill intelligence over to the current EVE-KILL v1 REST API at the fixed `https://api.eve-kill.com/` base; REST calls now converge on one validated client.
- Route planning, route monitoring, heartbeat, local pilot analysis, and OSINT now share normalized EVE-KILL observations and explicit ESI/SDE authority boundaries.
- Hardened prompt/tool routing and same-turn reasoning replay for the existing GPT-5.6 Sol/Terra/Luna model family.
- Updated first-party User-Agent defaults and examples to `EVEAI/3.1`.
- Kept direct third-party MCP descriptors out of OpenAI requests: the provider sees only application-owned local function schemas, and Fastify remains limited to EVE SSO and health.

### Removed

- Legacy zKill/RedisQ WebSocket transport and duplicate `query`, `kill-query`, `intel`, feed, and OSINT zKill request paths.

### Security and reliability

- MCP analytics accept only allowlisted public numeric CCP IDs, canonical date pairs, enums, booleans, and bounded limits; chat history, profiles, fits, private ESI results, credentials, URLs, and arbitrary text cannot cross the wrapper boundary.
- Oversized, malformed, excessively deep, or excessively wide MCP responses fail closed before downstream recursive processing.
- Feed replay, route baselines, tool-call budgets, audit persistence, and transient-chat notification boundaries are covered by regression tests.

### Release verification

- Full local gate passed: public artifact audit, TypeScript strict check, 417 Vitest tests, ESLint, production build, live EVE-KILL MCP smoke, and independent review.
- GitHub Actions CI passed on the migration commit before release preparation.

## [3.0.0] - 2026-07-13

### Changed

- Established the v3 public self-hosting release contract: Telegram, Discord DMs, and the terminal CLI share one Node.js and SQLite runtime; Fastify remains limited to EVE SSO and health; the model provider is the official OpenAI Responses API.
- Updated the default ESI, zKillboard, EVE-KILL, and EVE-Scout User-Agent examples to `EVEAI/3.0` so operators can identify the current release while retaining their own reachable contact.
- Rewrote the public quick-start and deployment path around deterministic `npm ci`, HTTPS SSO callbacks, local-only secret/data storage, and the v3 validation sequence.
- Updated the feature-request taxonomy to reflect the SSO callback and health surface rather than the removed web dashboard.

### Added

- `npm run audit:public`, enforced in CI, rejects tracked local runtime artifacts and common credential-like values before a public release.

### Release verification

- The release gate is `npm run audit:public`, `npm run check`, and `npm run build` on the exact release commit.

## [2.2.0] - 2026-07-06

### Added

- Discord bot with full Telegram parity: DM conversations through the shared agent runtime, slash commands (`/start`, `/help`, `/eve_login`, `/whoami`, `/characters`, `/use`, `/market`, `/info`, `/clear`), character-switch buttons, EVE SSO linking, rate limiting, and 2000-char markdown chunking. Discord snowflakes are stored as TEXT; DM lanes map to negative internal chat keys.
- Platform-routing outbound dispatcher: heartbeat, route-monitor, and kill-watch alerts are delivered to Telegram or Discord based on the chat lane.
- Colored, timestamped, secret-redacting terminal logs and a startup status banner (database, SDE, HTTP, Telegram, Discord, OpenAI, heartbeat).
- Friendly startup errors for missing env vars instead of stack traces.
- Hermetic test suite: `tests/setup.ts` env defaults plus a checked-in ESI swagger fixture make `npm test` pass on a clean clone; CI now runs tests.

### Changed

- Model provider is the official OpenAI Responses API only; the runtime uses the fixed `https://api.openai.com/v1` endpoint and does not support provider overrides.
- Telegram message handling moved to a shared platform-neutral chat pipeline (`src/chat/shared.ts`).
- `TELEGRAM_BOT_TOKEN` is now optional; at least one of `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` is required.
- Heartbeat summaries are plain text (platform-agnostic).

### Removed

- Entire web frontend: React/Vite client, landing page, dashboard, dashboard API, Telegram Login Widget, web sessions, and the `/web` handoff flow. Fastify now serves only the EVE SSO login redirect/callback and `/health`. The `web_sessions` and `telegram_login_attempts` tables are dropped by migration.
- Legacy local-proxy (codex_proxy) support: proxy health checks in smoke/health, the `x-chat-id` request header, and the dead `OPENAI_API_MODE` / `OPENAI_STORE` config keys.

### Security & resource bounds

- Discord `/eve_login` works again: the full EVE SSO URL (~2.1 KB, 58 scopes) exceeds Discord's 2000-char message and 512-char button limits, so the bots now send a short link to a new `GET /auth/eve/login` endpoint that 302-redirects the browser to EVE.
- `src/eve/sde-loader.ts` no longer runs `main()` (a full SDE load + `process.exit`) on import — importing it for `loadJsonlFile` in tests previously crashed the run when `./data/sde` was absent (red CI).
- `/clear` no longer deletes manual kill-watch subscriptions (only the active route monitor's own watches are cleaned); USER.md atomic writes use a per-write unique temp path (no clobber when a background refresh overlaps a foreground write); `killmail_batch` chunks >100 ids into multiple requests instead of silently truncating; heartbeat mail/notification checks seed an empty first poll to 0 so the next real event is reported; the Discord HTML→markdown converter keeps `<TICKER>`-style text instead of stripping all angle brackets.
- Migrations survive a genuine pre-2.2 production DB: `ensureSchema` no longer crashes when `SCHEMA_SQL`'s inline `CREATE INDEX` references a column a later migration adds (it applies statements individually, skipping only those index creations), and `backfillUsers` no longer fabricates a bogus `telegram_accounts` row for Discord DM lanes (negative chat keys) on every boot.
- ESI catalog: fixed header params (`If-None-Match`/`Accept-Language`) leaking into 141/175 tool schemas, optional enum params contradicting strict mode (null missing from the enum), a valid-but-empty swagger response overwriting the good cache and stripping every ESI tool, non-atomic cache writes, and a memoized rejected catalog promise wedging every later tool call.
- SDE loader: a record with an object-valued id or extra column no longer crashes the whole load (leaving the table wiped) — it is skipped/coerced; batch flushes are guarded; zip extraction is time-bounded and reports corrupt-vs-missing-tool distinctly.
- Responses runtime: the 90s deadline now covers the streamed SSE body read (previously headers-only — a stalled stream hung the turn forever), and a truncated stream with no terminal event is surfaced as a retriable error instead of a silent empty answer.
- EVE SSO hardening: JWT verification pins the signing algorithm (RS256); the token refresh path verifies the refreshed token still belongs to the same character before storing it; SSO discovery metadata must be https on login.eveonline.com or the pinned defaults are used; legacy plaintext token comparison is now constant-time.
- OSINT determinism/correctness: a malformed `killmail_time` no longer poisons scores with NaN or produces implementation-defined sort order, and weekly-stability buckets are computed in UTC (previously timezone-dependent). Fleet-comp parsing picks the pilot column correctly when the ship column is not first.
- Output/log redaction broadened to cover base64 bearer tokens and JSON-form `"…_token":"…"` values; `OPENAI_MODEL_CONTEXT_WINDOW` is floored so a misconfigured 0 can't trigger compaction every turn.
- `sde_sql` can no longer freeze the process: results are read lazily with an early cap (no full materialization of huge/cartesian result sets) and query plans with ≥2 full table scans (cartesian products) are rejected.
- Mutating tools (`intel_note`, `set_active_fit`, `heartbeat_config`, `route_monitor`) are now classified `write` so they run sequentially instead of in the parallel read path — closes lost-update/TOCTOU races on USER.md and local tables. USER.md is written atomically (temp + rename), and fitting text can no longer inject false Markdown headings.
- Killboard responses are read with an 8 MB byte cap (no OOM on an oversized payload); `killmail_batch` ids are capped at 100.
- Unbounded growth closed: the shared `esi_cache` table is swept of expired rows hourly (previously grew forever), `intel_notes` is capped at 500 per user, and `plans`/`plan_steps` older than 7 days are pruned.
- Kill watches are removed and the route monitor stopped on `/clear`; auto-created route watches no longer consume the user's 20-watch budget.
- ESI: non-idempotent POSTs are no longer retried on 5xx/network errors (prevents duplicate mail/fitting side effects); a 304 without an `Expires` header returns the cached body instead of a spurious 502; ESI's error-limit reset window is honored (up to 60s) instead of being clamped to the 10s backoff cap.

### Fixed

- Notification producers hardened: the zKB R2Z2 poller re-syncs its sequence after persistent 404s instead of dying silently; route monitors stop (with a message) after ~10 min of failed location polls or 30 min offline, no longer stack overlapping poll cycles, and one corrupt DB row no longer aborts app startup; the heartbeat cron cannot overlap itself, seeds first-run state silently (no historical mail/killmail/contract dump), fixes the always-failing sender-name lookup, and stops re-notifying an empty skill queue every interval.
- Discord `/characters` shows switch buttons for up to 25 characters (rows of 5) instead of silently dropping past the 5th; code fences split across message chunks are closed and reopened; forwarded messages are readable.
- A failed Telegram "thinking" placeholder no longer wedges the chat until restart; outbound Telegram alerts are chunked to 4096 and retried without parse mode on markup errors.
- Startup guards: fail-fast in production without `AUTH_SECRET_KEY` (systemd unit now sets `NODE_ENV=production`), warnings for open bot access and placeholder `ESI_USER_AGENT`.
- Compaction no longer deletes messages that did not fit into the summarizer input budget; oversized backlogs drain across multiple passes.
- Mid-turn compaction re-injects recent tool results so data collected during the current turn survives the context rebuild.
- Stale tool audit rows are pruned even when there is nothing to summarize.
- The EVE SSO callback no longer leaks internal error details in HTTP 500 responses.

### Verified

- Full local check passed: TypeScript strict, 264 Vitest tests, ESLint, production build.
- Startup verified in a real terminal run: banner, colored logs, friendly env errors, graceful shutdown on bot auth failure.
- Live smoke against the official OpenAI API (real key): `smoke:openai` returned the exact expected output on gpt-5.5, and `smoke:eve-tool` completed the full agent loop end-to-end (66 tools loaded, `sde_sql` called, Raven resolved from local SDE, prompt-cache hit) after the sde_sql hardening.

## [2.1.5] - 2026-05-26

### Changed

- Rewrote the main developer prompt in English using documented prompt-structure guidance.
- Added `OPENAI_RESPONSE_LANGUAGE` to control the default final-answer language from env.

### Verified

- Prompt unit tests cover language alias normalization and response-language prompt injection.
- Full local check passed: TypeScript, Vitest, and ESLint.

## [2.1.4] - 2026-05-26

### Added

- Added `npm run smoke:eve-tool` for EVE SDE tool smoke checks.
- Added `EVE_TOOL_SMOKE_MODE=direct` for DB-only tool validation without a model call.

### Verified

- Local direct tool smoke resolved Raven from the SQLite SDE through `sde_sql`.
- Full local check and production build passed after adding the smoke command.

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
