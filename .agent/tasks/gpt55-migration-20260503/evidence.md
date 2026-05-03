# Evidence

## Official OpenAI Docs

- `latest-model.md` reports `latestModelInfo.model: gpt-5.5`, migration guide `/api/docs/guides/upgrading-to-gpt-5p5.md`, and prompting guide `/api/docs/guides/prompt-guidance.md`.
- The GPT-5.5 guide says to update the model slug to `gpt-5.5`, keep Responses API for reasoning/tool-calling/multi-turn use cases, tune reasoning effort, and verify `phase`, preambles, and assistant-item replay for tool-heavy flows.
- The upgrade guide says to keep the narrowest safe change set, preserve existing reasoning effort first, and avoid API/tool/schema rewrites unless required.

## Code and Docs Inventory

- Runtime default: `src/config.ts` defaults `OPENAI_MODEL` to `gpt-5.5`.
- Env example: `.env.example` sets `OPENAI_MODEL=gpt-5.5`.
- Active docs: `README.md` now describes GPT-5.5 in the badge, tech stack, OpenAI Responses API row, prompt guide wording, and status line.
- Runtime reliability docs: `docs/RELIABILITY.md` and `docs/skills-protocol.md` describe the active GPT-5.x function-tool skills path and include `gpt-5.5` in the compatibility matrix.
- Historical compatibility rows for `gpt-5.4` remain in `docs/skills-protocol.md` as older-model compatibility, not as the current default.

## Compatibility Review

- Responses API: current runtime calls `/responses` in `src/agent/native-responses.ts`.
- Reasoning effort: current default remains `medium`; this matches GPT-5.5 guidance and was not changed.
- Tool-heavy flow: runtime uses `previous_response_id` for warm continuation and sends `function_call_output` items after tool calls.
- Assistant item replay / phase: runtime does not manually replay completed assistant output items as conversation history during warm continuation; it relies on `previous_response_id`, so no phase-retrofit code change is in scope.
- Prompt surface: `src/agent/prompts.ts` already has outcome, source hierarchy, dependency checks, stopping/completeness, and verification rules. No broad prompt rewrite was needed.

## Validation

- `npm run test -- tests/unit/prompts.test.ts tests/unit/native-responses.test.ts tests/unit/warm-cold-path.test.ts tests/unit/smoke.test.ts`: PASS, 4 files / 29 tests.
- Initial `npm run check`: failed only because `tests/unit/osint-inference.test.ts` used fixed March 2026 fixture dates outside the current 30-day window on 2026-05-03.
- Test-only fix: OSINT fixture dates now use `Date.now()` relative dates.
- Final `npm run check`: PASS, `tsc --noEmit`, 43 test files / 239 tests, and `eslint src/ --max-warnings 0`.
- `npm run build`: PASS, Vite client build and server `tsc`.
- `git diff --check`: PASS.

## Deployment Status

- Commit `055516b` was pushed to `origin/master` via HTTPS after SSH port 22 to GitHub timed out.
- Production `/opt/eveai` is not a git checkout, so deployment used `git archive HEAD` to build `/tmp/eveai-gpt55-055516b.tar`, copied it to the server, and extracted it over `/opt/eveai` without deleting `.env` or data.
- Production deploy commands completed: `npm ci`, `npm run build`, and `pm2 restart eveai --update-env`.
- PM2 verification: `eveai` is online, version `2.1.1`, pid `3030719` after restart.
- Production `.env` verification: `OPENAI_MODEL=gpt-5.5`.
- Production source verification: `/opt/eveai/src/config.ts` defaults `OPENAI_MODEL` to `gpt-5.5`.
- Production health: `curl -fsS http://127.0.0.1:3000/health` returned `status:"ok"` with database, client assets, Telegram bot, and OpenAI proxy OK.
- Production smoke: `npm run smoke` passed env, proxy health, proxy models, and public app health.
- Production model ping: direct proxy `/v1/responses` request with `"model":"gpt-5.5"` returned SSE events with `model:"gpt-5.5"`, `reasoning.effort:"medium"`, and output text `pong`.
