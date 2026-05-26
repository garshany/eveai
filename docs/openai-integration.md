# OpenAI Integration

This project uses the OpenAI Responses API for a tool-heavy EVE Online agent loop.

## Default Target

- Model: `gpt-5.5`
- Endpoint: `POST /v1/responses`
- Base URL: `https://api.openai.com/v1`
- Reasoning effort: `medium`
- Text verbosity: `low`
- State mode: `stateless`
- Storage: `store=false`

These defaults follow the current OpenAI latest-model guidance for GPT-5.5: use the Responses API for reasoning/tool-calling workflows, start with `medium` reasoning, tune verbosity intentionally, keep stable prompt content first for caching, and preserve assistant output item fields such as `phase` when manually replaying output items.

## Why Stateless By Default

`OPENAI_RESPONSE_STATE_MODE=stateless` is safest for self-hosted deployments and OpenAI-compatible providers because it does not assume provider-side `previous_response_id` retention. The app sends the previous `function_call` item back together with its `function_call_output`.

Use `OPENAI_RESPONSE_STATE_MODE=server` only when your provider supports stored Responses continuation reliably.

## Relevant Environment

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_API_MODE=native_responses
OPENAI_RESPONSE_STATE_MODE=stateless
OPENAI_REASONING_EFFORT=medium
OPENAI_TEXT_VERBOSITY=low
OPENAI_MAX_OUTPUT_TOKENS=0
OPENAI_COMPACT_THRESHOLD=0
OPENAI_MODEL_CONTEXT_WINDOW=200000
```

## Compatibility Notes

- The request uses streaming and function tools.
- `prompt_cache_key` is forwarded when available.
- `phase` is preserved on replayed function-call output items instead of being stripped.
- If an OpenAI-compatible gateway rejects `text.verbosity`, unset `OPENAI_TEXT_VERBOSITY` and rerun `npm run check` plus `npm run smoke` against that gateway.
- The model must not see tokens, refresh flow internals, pagination internals, retries, or secrets; those stay in backend code.

## Validation

Run:

```bash
npm run check
npm run smoke
npm run smoke:openai
```

`npm run check` validates type safety, unit/integration tests, linting, and Responses payload regressions. `npm run smoke` checks required environment variables, the model `/responses` endpoint, and app health.

The authenticated smoke script sends a minimal streaming `POST /responses` request using env vars and prints only sanitized response metadata.
