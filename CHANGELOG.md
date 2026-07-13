# Changelog

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
