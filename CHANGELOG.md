# Changelog

## [Unreleased]

## [2.1.0] - 2026-04-09

### Agent Intelligence & Autonomy

#### 1. Dynamic Reasoning Effort

**Before**: Fixed `medium` reasoning effort for all requests — greetings cost the same as complex D-Scan analysis.

**After**: Automatic effort classification per message:
- `low` — greetings, help, static counts (60-80% reasoning token savings)
- `medium` — standard queries (unchanged)
- `high` — scan analysis, OSINT, market comparison, fitting builds (better quality)

#### 2. Reasoning Summary Logging

**Before**: No visibility into model's reasoning process.

**After**: `reasoning.summary: 'concise'` enabled — model reasoning summaries logged to console for debugging agent decisions.

#### 3. Prompt Strategy Improvements

**Before**: Prompt described *what* to do but not *how* to think.

**After**: Three new prompt sections:
- `<reasoning_strategy>` — goal decomposition, data planning, dependency ordering before first tool call
- `<self_correction>` — validate tool results for logic errors, completeness, contradictions
- `<proactive_enrichment>` — auto-enrich answers with security status, Jita price comparison, intel notes

#### 4. API Enhancements

- `user: tg-{chatId}` — per-user tracking for OpenAI abuse detection
- `prompt_cache_retention: '24h'` — better cache hits for returning users
- `max_output_tokens` — configurable guard via `OPENAI_MAX_OUTPUT_TOKENS`

### Async I/O Migration

#### 5. Non-blocking File Operations

**Before**: `readFileSync`/`writeFileSync` blocked the event loop on every message (user profile read, fitting persistence, ESI swagger cache).

**After**: All hot-path file I/O uses `fs/promises`:
- `readUserProfile` / `refreshUserProfile` — async
- `persistActiveFitting` / `writeManualFitting` — async
- `deleteUserProfileArtifact` — async
- `loadSwaggerSpec` / `writeCache` — async
- `unlinkCharacter` — async (cascade)

### EVE-Scout Integration

#### 6. Full EVE-Scout API

Five tools for WH navigation:
- `scout_route` — WH-aware routing (Thera/Turnur shortcuts, nearest highsec, Jove observatories)
- `scout_signatures` — active WH connections from Thera/Turnur
- `scout_observations` — metaliminal storms and space oddities
- `scout_wormhole_types` — WH encyclopedia (mass, lifetime, classes)
- `scout_systems` — WH system search by J-code or class

#### 7. Thera Shortcut in Route Planner

**Before**: `plan_route` only supported secure/shortest/insecure.

**After**: `prefer=thera_shortcut` — routes via Thera/Turnur wormholes with 3 waypoints (WH entry -> WH exit -> destination). Visible in route comparison table.

### Intel & Analysis Tools

#### 8. D-Scan / Fleet / Local Universal Parser

`analyze_scan` — auto-detects scan type and returns structured intel:
- D-Scan: ship class breakdown, fleet profile, capitals, doctrine detection
- Fleet: pilot list, doctrine analysis, logi/DPS ratio, weaknesses
- Local: delegates to `analyze_local` for full intel

#### 9. Intel Notebook

`intel_note` — persistent personal notes (save/search/list/delete) with tags: hostile, friendly, structure, wormhole, route, market, bookmark.

#### 10. OSINT Home Detection

`osint_infer_home` — 8-layer profiling to detect residence/staging systems for characters, corps, alliances. NPC ratting, solo losses, return hubs, weekly stability analysis.

#### 11. Ship-Aware Tactical Context

Live ship data (EHP, align time, warp speed, HIGH_VALUE_TARGET flag) injected into prompt for tactical assessments. Active fitting from ESI or manual override.

### Reliability

#### 12. Gate Camp Detection

`plan_route` danger scan now detects gate camps (kills on gates, smart bombs, bubbles) and includes them in route assessment.

#### 13. Retry with Backoff

All external API clients (ESI, EVE-KILL, EVE-Scout, zKillboard) now have bounded retry with exponential backoff for transient errors.

#### 14. Stream Parsing Resilience

Reconstructs function calls from SSE stream events when both primary extractors fail — prevents dropped tool calls.

## [2.0.0] - 2026-03-15

Initial multi-user release with Telegram bot, EVE SSO, native ESI tools, and local SDE.
