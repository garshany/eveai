# Contributing

Thanks for helping improve EVE Online AI.

This project is a self-hosted Telegram-first EVE Online assistant. Contributions should preserve the current operating model and avoid adding infrastructure that self-hosters do not need.

## Good First Areas

- Improve documentation, setup instructions, screenshots, and troubleshooting notes.
- Add or improve unit tests around EVE SDE lookups, prompt behavior, Telegram formatting, and ESI field filtering.
- Fix reproducible bugs with small, focused changes.
- Improve frontend/dashboard usability without changing the backend architecture.
- Add safe read-only EVE data workflows that respect the private ESI access rules.

## Local Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and fill local credentials.
3. Install dependencies with `npm ci`.
4. Load static EVE data with `npm run setup` when your change needs SDE-backed behavior.
5. Run `npm run dev` for local development.

## Validation

Run the strongest feasible check before opening a PR:

```bash
npm run check
npm run build
```

Optional runtime checks when env is available:

```bash
npm run smoke
npm run smoke:openai
EVE_TOOL_SMOKE_MODE=direct npm run smoke:eve-tool
npm run smoke:eve-tool
```

## Architecture Rules

- Keep the app single-process Node.js with SQLite.
- Do not add workers, queues, Redis, Postgres, or Telegram webhooks.
- Keep Fastify limited to auth callback, web auth, dashboard support, and health.
- Keep private ESI access isolated per Telegram user and chat.
- Private ESI access must be gated by `get_eve_capabilities` when access is not already fresh.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.
- Static game data comes from local SDE in SQLite. Live character and market data comes from ESI.
- TypeScript strict mode is required.

## Pull Requests

- Keep PRs small and behavior-focused.
- Update docs when behavior changes.
- Add or update tests for bug fixes and new behavior.
- Explain any manual verification you performed.
- Do not include local deployment details, logs, server IPs, real tokens, database files, or SDE dumps.

## Security

Do not report vulnerabilities in public issues if they expose tokens, sessions, private ESI data, or account takeover paths. Follow [SECURITY.md](./SECURITY.md).
