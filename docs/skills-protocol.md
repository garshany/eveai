# Skills Protocol Notes

Status: active
Verified against code: 2026-07-13

This project can be extended by local development skills under `skills/`, but the production app does not require any private model gateway or shell tool access. Public runtime tools are ordinary Responses API function tools implemented by this Node.js process.

## Runtime Tool Loop

The model receives JSON-schema function tools. When it emits a `function_call`, the app executes the corresponding TypeScript handler and returns a `function_call_output`.

The app uses the official OpenAI Responses API. In the default stateless mode, the next request includes the prior `function_call` item and its matching `function_call_output`. This is controlled by:

```env
OPENAI_RESPONSE_STATE_MODE=stateless
```

Provider-side continuation is deliberately unsupported because this project
keeps `store=false` for Responses API requests.

## Local Development Skills

Repo-local files under `skills/` document workflows for maintainers and coding agents. They are not exposed to end users and should not contain secrets, host-specific paths, or production credentials.
