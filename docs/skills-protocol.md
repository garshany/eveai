# Skills Protocol Notes

Status: active
Verified against code: 2026-05-25

This project can be extended by local development skills under `skills/`, but the production app does not require any private model gateway or shell tool access. Public runtime tools are ordinary Responses API function tools implemented by this Node.js process.

## Runtime Tool Loop

The model receives JSON-schema function tools. When it emits a `function_call`, the app executes the corresponding TypeScript handler and returns a `function_call_output`.

For OpenAI-compatible providers that do not retain server-side response state, the app uses stateless continuation: the next request includes the prior `function_call` item and its matching `function_call_output`. This is controlled by:

```env
OPENAI_RESPONSE_STATE_MODE=stateless
```

Use `server` mode only with providers that explicitly support stored `previous_response_id` continuation.

## Local Development Skills

Repo-local files under `skills/` document workflows for maintainers and coding agents. They are not exposed to end users and should not contain secrets, host-specific paths, or production credentials.
