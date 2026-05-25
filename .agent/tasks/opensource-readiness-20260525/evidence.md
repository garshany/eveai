# Evidence: opensource-readiness-20260525

## Summary

Prepared the current tree for a clean open-source release path: model runtime now supports stateless Responses tool continuation for Bothub/OpenAI-compatible providers, public docs no longer expose private production topology, self-host setup is documented, private deployment artifacts were removed or replaced with generic examples, and release safety guidance now requires clean export/history rewrite plus credential rotation before publication.

## Acceptance Criteria

### AC1: public release strategy

PASS. Added `docs/open-source-release.md`, root `SECURITY.md`, README notice, and deployment checklist stating that the existing git history must not be made public as-is and that exposed credentials must be rotated before publishing. Added `scripts/export-public.sh` for a clean no-history public export.

### AC2: model runtime stateless continuation

PASS. Added `OPENAI_RESPONSE_STATE_MODE` with `stateless` default. In stateless mode, the executor rebuilds context locally and sends prior `function_call` items together with matching `function_call_output` items instead of relying on `previous_response_id`. Live Bothub smoke succeeded with `pendingTypes=[function_call,function_call_output]` and a final message.

### AC3: public docs remove private production deployment surface

PASS. Replaced private server runbook content in `docs/deployment.md`, removed private production block from `AGENTS.md`/`CLAUDE.md`, sanitized historical completed plan notes, and removed old proxy/NaiveProxy deployment artifacts. Current-surface leak scan returned no matches for the private IP/domain/SSH/proxy patterns.

### AC4: self-host setup documented

PASS. README and `docs/deployment.md` now document ordinary self-host setup: env vars, Telegram BotFather, EVE Developer callback, SDE setup, local run, generic reverse proxy, generic systemd, and model provider modes.

### AC5: env/config/smoke/ignore public-safe

PASS. `.env.example` uses generic contacts/placeholders and quotes `DEFAULT_MARKET_REGION_NAME`; config defaults no longer contain personal email/domain; `npm run smoke` now checks configured `/responses`; `.gitignore` excludes `.env.*`, local agent state, hooks, data, and DB/log artifacts.

### AC6: private/unrelated deployment artifacts removed/replaced

PASS. Removed old backend/Codex proxy systemd units and untracked Caddy/nginx/NaiveProxy rollout files. Added generic `deploy/systemd/eveai.service`.

### AC7: verification artifacts

PASS. Raw artifacts saved under `raw/`:

- `raw/check.txt`: `npm run check` passed, 43 test files / 240 tests.
- `raw/bothub-stateless-live.txt`: live Bothub stateless function-call continuation passed.
- `raw/leak-export-scan.txt`: current-tree and exported-tree private pattern scans returned no matches; export helper produced `/tmp/eveai-public-export-check`.
- `raw/public-release-repo.txt`: clean export at `/tmp/eveai-public-release` includes `.env.example`, has no private leak-scan matches, and was initialized as a new git repository with an initial commit.
- `raw/export-script-syntax.txt`: `bash -n scripts/export-public.sh` passed.
- `raw/final-public-repo-audit.txt`: final clean repo audit passed: git status clean, `.env.example` present, `.env` and `.agent` absent, one initial commit, final private-marker scan no matches.

## Commands

```bash
npm run check
./node_modules/.bin/tsx -e '<live Bothub stateless continuation smoke>'
./scripts/export-public.sh /tmp/eveai-public-export-check
rg -n '<private deployment and secret patterns>' AGENTS.md CLAUDE.md README.md SECURITY.md CONTRIBUTING.md ARCHITECTURE.md docs deploy scripts src tests .env.example package.json -S
rg -n '<private deployment and secret patterns>' /tmp/eveai-public-export-check -S
```

## Residual Operational Requirement

Credential rotation cannot be performed from this repository. The release playbook explicitly requires rotating any credentials exposed in chat, old commits, local files, screenshots, or CI logs before publishing a public repo.
