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

Provider-side continuation is optional:

```env
OPENAI_STORE_RESPONSES=true
OPENAI_RESPONSE_STATE_MODE=server
```

SQLite remains canonical. The runtime reuses only a recent Response id anchored
to the exact latest assistant message and cold-replays the active turn when that
provider state is unavailable. Setting `OPENAI_STORE_RESPONSES=true` alone only
enables Dashboard Logs; it does not change the state mode.

## Local Development Skills

Repo-local files under `skills/` document workflows for maintainers and coding agents. They are not exposed to end users and should not contain secrets, host-specific paths, or production credentials.
