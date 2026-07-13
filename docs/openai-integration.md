# OpenAI Integration

This project uses the OpenAI Responses API for a tool-heavy EVE Online agent loop.

## Default Target

- Model: `gpt-5.6-sol`
- Endpoint: `POST /v1/responses`
- Base URL: `https://api.openai.com/v1`
- Reasoning effort: `auto` (local goal classifier, with `medium` for internal calls)
- Reasoning mode: `standard`
- Text verbosity: `low`
- State mode: `stateless`
- Storage: `store=false`
- Response timeout: 90 seconds

These defaults follow the current [GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model): use the Responses API for reasoning and tools, select a family tier by workload, set reasoning and verbosity intentionally, keep stable prompt content first for caching, and preserve output-item fields when replaying tool state.

## Model And Reasoning Choice

The self-hosting operator selects one process-wide model:

| Value | Role |
| --- | --- |
| `gpt-5.6-sol` | Default, strongest capability and quality-first work |
| `gpt-5.6-terra` | Strong capability with a lower-cost balance |
| `gpt-5.6-luna` | Efficient, latency-sensitive, high-volume work |
| `gpt-5.6` | Family alias that currently routes to Sol |

`OPENAI_REASONING_EFFORT=auto` is an EVE Agent policy, not an API value. It uses the existing goal classifier for top-level chat turns and resolves internal model calls to the balanced `medium` baseline. A fixed value (`none`, `low`, `medium`, `high`, `xhigh`, or `max`) overrides the classifier and reaches every normal chat turn unchanged.

`OPENAI_REASONING_MODE=pro` sends `reasoning.mode="pro"` on top-level agent turns. Pro uses the selected family model; there is no separate `gpt-5.6-pro` slug. It increases latency and token use, so evaluate it on representative difficult EVE tasks and raise `OPENAI_RESPONSES_TIMEOUT_MS` only when the measured workload needs more than 90 seconds. Internal summarization, OSINT, and advisor calls stay in standard mode.

`OPENAI_TEXT_VERBOSITY` accepts `low`, `medium`, or `high`. The developer prompt keeps task-specific chat requirements; this API control supplies the default amount of detail.

## Why Stateless By Default

`OPENAI_RESPONSE_STATE_MODE=stateless` is the supported mode. It does not
assume provider-side `previous_response_id` retention: the app sends the prior
`function_call` item back together with its `function_call_output` while keeping
`store=false`. `server` is rejected at startup because provider-side
continuation is incompatible with this project's no-provider-storage policy.

GPT-5.6 `reasoning.context=all_turns` is intentionally not exposed. With `store=false`, correct persisted reasoning requires requesting `reasoning.encrypted_content`, preserving every response output item, and replaying those opaque items in order. The current SQLite history stores user-visible messages and tool audit data, not complete encrypted reasoning items. Sending `all_turns` without that storage path would silently overstate continuity.

## Relevant Environment

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
OPENAI_RESPONSE_STATE_MODE=stateless
OPENAI_REASONING_EFFORT=auto
OPENAI_REASONING_MODE=standard
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSES_TIMEOUT_MS=90000
OPENAI_RESPONSE_LANGUAGE=Russian
OPENAI_MAX_OUTPUT_TOKENS=0
OPENAI_COMPACT_THRESHOLD=0
OPENAI_MODEL_CONTEXT_WINDOW=200000
```

## Compatibility Notes

- The request uses streaming and function tools.
- `prompt_cache_key` is forwarded when available.
- `phase` is preserved on replayed function-call output items instead of being stripped.
- Invalid response-state, reasoning-effort, reasoning-mode, verbosity, and timeout values fail fast at startup rather than becoming a delayed API 400.
- Usage telemetry records `cached_tokens`, `cache_write_tokens`, and reasoning tokens separately. GPT-5.6 implicit caching remains enabled; explicit cache breakpoints are not part of the baseline migration.
- When `AUTH_SECRET_KEY` is configured, top-level calls send a stable HMAC-derived `safety_identifier`. Raw Telegram, Discord, chat, and database user ids are not sent.
- `OPENAI_RESPONSE_LANGUAGE` is injected into the developer prompt as a dedicated response-language instruction. Use values like `ru`, `русский`, `en`, `English`, or a custom language name.
- The model must not see tokens, refresh flow internals, pagination internals, retries, or secrets; those stay in backend code.

`OPENAI_MODEL_CONTEXT_WINDOW=200000` is a conservative local compaction budget, not a claim about the selected model's advertised context window. The runtime compacts at 90% of this value and keeps it configurable because maximum input, reserved output, latency, and cost all matter.

## Validation

Run:

```bash
npm run check
npm run smoke
npm run smoke:openai
npm run smoke:eve-tool
```

`npm run check` validates type safety, unit/integration tests, linting, and Responses payload regressions. `npm run smoke` checks required environment variables, the model `/responses` endpoint, and app health.

The authenticated smoke script sends a minimal streaming `POST /responses` request using env vars and prints only sanitized response metadata.

`npm run smoke:eve-tool` runs the real agent loop on a copied SQLite database and requires the model to call an EVE SDE tool before returning a final answer. Use `EVE_TOOL_SMOKE_MODE=direct` to validate only the DB-backed tool path without a model call.
