# Repository Guidelines

## Project Structure & Module Organization

Runtime code lives in `src/`. `src/app.ts` starts SQLite, the Fastify health/SSO server, and Telegram/Discord clients. Domains are grouped under `src/agent/`, `src/auth/`, `src/chat/`, `src/db/`, `src/eve/`, `src/telegram/`, and `src/discord/`. Tests live in `tests/unit/` and `tests/integration/`; fixtures are in `tests/fixtures/`. Keep operational scripts in `scripts/`, service files in `deploy/`, and durable behavior documentation in `docs/`. See `docs/repo-map.md` for the full map.

## Build, Test, and Development Commands

- `npm run dev` — run the app from TypeScript with file watching.
- `npm run cli` — start the local terminal chat client.
- `npm run build` — compile strict TypeScript into `dist/`.
- `npm test` — run the complete Vitest suite once.
- `npm run lint` — lint `src/` with zero warnings allowed.
- `npm run check` — run type-checking, tests, and linting together.
- `npm run setup` — download and load the local EVE SDE.

Use Node.js 20.19 or newer. Copy `.env.example` to `.env`; never commit `.env`.

## Coding Style & Naming Conventions

Write ESM TypeScript in strict mode with two-space indentation and semicolons. Use `camelCase` for functions and variables, `PascalCase` for types/classes, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames such as `market-history-summary.ts`. Prefer small domain modules and explicit validation at external boundaries.

## Testing Guidelines

Vitest files use the `*.test.ts` suffix and mirror the affected behavior. Test success and failure paths, especially around auth, persistence, retries, tool schemas, and external payload validation. There is no numeric coverage gate; changed behavior must be directly exercised. Run the narrow test first, then `npm run check`.

## Commit & Pull Request Guidelines

Use concise imperative subjects with the established prefixes: `feat:`, `fix:`, `docs:`, or `release:`. Keep commits scoped; exclude local data, credentials, and unrelated changes. Pull requests should explain behavior and risk, link relevant issues, list verification commands, and update matching `docs/` files. Include screenshots only for visible output changes.

## Architecture & Security Boundaries

Keep the app single-process and SQLite-backed; do not introduce queues, Redis, or Postgres. Use only the official OpenAI Responses API or the fixed CheapVibeCode Codex Responses provider implemented by this repository; arbitrary provider URLs remain unsupported. Static game data comes from local SDE; live/private data comes from ESI and remains isolated per user/chat lane. Never expose tokens, refresh logic, raw credentials, or private ESI data to model prompts or logs. For substantial features and fixes, keep acceptance criteria and verification evidence under `.agent/tasks/<task-id>/`.
