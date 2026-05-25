# Task Spec: opensource-readiness-20260525

## Goal

Prepare the repository for a safe open-source release while preserving the product's self-hosted EVE assistant behavior.

## Acceptance Criteria

- AC1: Public release strategy is documented clearly: current repository history contains production/secrets exposure and must not be opened as-is; maintainers should publish from a clean sanitized export or rewritten history after rotating exposed secrets.
- AC2: The model runtime supports OpenAI-compatible providers that do not retain Responses API server state, including Bothub `gpt-5.5`, by using stateless function-call continuation when configured.
- AC3: Public-facing docs and repo maps no longer expose private production server SSH/IP/user/path, Codex proxy, NaiveProxy, Remnawave, or domain-specific deployment instructions.
- AC4: Self-host setup is documented for ordinary users: required env vars, EVE SSO setup, SDE loading, local run, optional production deployment shape, and model provider options.
- AC5: `.env.example`, config defaults, smoke checks, and ignore rules are safe for public release and do not embed personal email, private domains, or provider secrets.
- AC6: Private/unrelated deployment artifacts are removed or replaced with generic examples that fit the open-source app.
- AC7: Verification artifacts include targeted model-runtime tests, full repo checks where feasible, and secret/deployment leak scans over the current public surface.

## Constraints

- Do not commit or print real provider tokens.
- Do not rely on private production infrastructure for public setup.
- Preserve single-process Node.js, SQLite, Telegram long polling, and private ESI isolation invariants.
- Do not destroy user work without making it explicit in the diff; remove only private deployment artifacts that are out of scope for public release.

## Verification Plan

1. Run targeted tests for `native-responses`, warm/cold continuation, smoke, and config behavior.
2. Run `npm run typecheck`, `npm run lint`, and `npm run check` if feasible.
3. Run current-surface leak scans for server IPs, SSH snippets, old password fragments, private domains, NaiveProxy/Remnawave/Codex proxy deployment references, and concrete secrets.
4. Record command results and final PASS/FAIL in `.agent/tasks/opensource-readiness-20260525/evidence.md`, `.agent/tasks/opensource-readiness-20260525/evidence.json`, and `verdict.json`.
