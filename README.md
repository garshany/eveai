<p align="center">
  <img src="https://img.shields.io/badge/EVE%20Online-AI%20Assistant-1a1a2e?style=for-the-badge" alt="EVE AI" />
  <img src="https://img.shields.io/badge/Telegram-Long%20Polling-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
  <img src="https://img.shields.io/badge/Discord-Bot-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
</p>

# EVE AI Agent

> **Landing-page source:** [`index.html`](./index.html). GitHub Pages is optional and is not currently a deployed product endpoint.

Self-hosted, chat-first AI assistant for EVE Online. Run it through Telegram, Discord DMs, or the terminal CLI; it combines local EVE SDE data, live ESI data, killboard intelligence, route planning, and the official OpenAI Responses API model loop with tool calling.

This repository is designed for operators to run their own instance in a terminal. It does not require Redis, Postgres, queues, workers, webhooks, or a web frontend.

## v3.0.0 public release

v3 makes the public self-hosting contract explicit: one Node.js process, local SQLite state, the official OpenAI Responses API, and no hosted dashboard or provider proxy. Every pull request now runs a tracked-file public-artifact audit in addition to build, tests, and linting.

For a public SSO callback, use HTTPS, set the callback URL exactly in the EVE Developer Portal, generate a strong `AUTH_SECRET_KEY`, give ESI a reachable operator contact, and keep `.env` plus `data/` on the host only. The detailed production checklist is in [docs/deployment.md](./docs/deployment.md).

## Capabilities

- Natural-language Telegram and Discord assistant for EVE Online questions and workflows.
- EVE SSO linking for private character data, with scope-aware capability gating.
- Local SDE SQLite lookups for static game data such as systems, items, dogma, blueprints, and routes.
- Live ESI access for character, corporation, market, location, mail, skills, industry, assets, and related data when scopes are granted.
- Route planning with live danger analysis, killmail context, gate-camp signals, Thera/Turnur shortcut support, and monitor mode.
- D-scan, fleet, local, OSINT, EVE-KILL, EVE-Scout, zKillboard, and intel notes.
- Heartbeat notifications (mail, skills, wallet, industry, kills, and more) delivered to the chat where you talk to the bot.

## Architecture

```text
Telegram private chat ──> grammY long polling bot ─┐
                                                   ├─> shared agent runtime
Discord DM ───────────────> discord.js gateway bot ─┘        │
                                                             v
                                        OpenAI Responses API (/v1/responses)
                                                             │
                                                             v
                                          ESI / SDE / killboard tools ──> SQLite

Browser ──> Fastify ──> EVE SSO login redirect + callback + /health ──> same SQLite state
```

Hard constraints:

- Single-process Node.js app.
- SQLite only.
- Telegram long polling only; no webhooks. Discord standard gateway connection.
- Fastify is limited to the EVE SSO login redirect/callback and the health endpoint. There is no web frontend.
- Static game data comes from local SDE SQLite; live data comes from ESI.
- Private ESI access is isolated per user/chat and gated by `get_eve_capabilities`.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.

## Requirements

- Node.js 20.19+.
- npm.
- At least one bot token:
  - Telegram bot token from [@BotFather](https://t.me/BotFather), and/or
  - Discord bot token from <https://discord.com/developers/applications> (no privileged intents needed; the bot works in DMs).
- EVE Developer application from <https://developers.eveonline.com/>.
- OpenAI API key (official Responses API).

## Quick Start

```bash
git clone <your-public-fork-url> eveai
cd eveai
cp .env.example .env       # fill in the tokens
npm ci
npm run setup              # download + load EVE static data (SDE)
npm run dev
```

Then open a private chat with your Telegram bot, or DM your Discord bot.

For local EVE SSO callbacks, set the callback URL in the EVE Developer Portal to:

```text
http://localhost:3000/auth/eve/callback
```

## Required Environment

Minimum local `.env` values (at least one bot token is required):

```env
TELEGRAM_BOT_TOKEN=...        # and/or DISCORD_BOT_TOKEN
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
OPENAI_REASONING_EFFORT=auto
OPENAI_REASONING_MODE=standard
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSES_TIMEOUT_MS=90000
OPENAI_RESPONSE_LANGUAGE=Russian
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
AUTH_SECRET_KEY=replace-with-random-secret
EVE_CALLBACK_URL=http://localhost:3000/auth/eve/callback
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/3.0 (+https://github.com/your-org/eveai; contact=you@example.com)
```

Generate `AUTH_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

Model defaults:

- `OPENAI_MODEL=gpt-5.6-sol` is the quality-first default. Use `gpt-5.6-terra` for a capability/cost balance or `gpt-5.6-luna` for latency-sensitive, high-volume deployments. The `gpt-5.6` alias routes to Sol.
- `OPENAI_REASONING_EFFORT=auto` preserves EVE Agent's goal-based `low|medium|high` routing. Set `none`, `low`, `medium`, `high`, `xhigh`, or `max` to override it globally.
- `OPENAI_REASONING_MODE=standard` is the normal path. Set `pro` only for difficult quality-first workloads that justify higher latency and token use; Pro is a mode, not a separate model name.
- `OPENAI_TEXT_VERBOSITY=low` keeps chat answers compact; set `medium` if your community wants longer explanations.
- `OPENAI_RESPONSES_TIMEOUT_MS=90000` controls the Responses transport deadline; raise it deliberately when evaluating Pro.
- `OPENAI_RESPONSE_LANGUAGE=Russian` sets the default final-answer language. Aliases like `ru`, `русский`, `en`, `English`, and custom language names are accepted; an explicit user request can override it per answer.

These are process-wide self-hosting controls shared by Telegram, Discord, and CLI. They are not per-chat preferences. See [OpenAI integration](./docs/openai-integration.md) and OpenAI's [GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model).

## EVE SSO Setup (private character data)

The current process configuration requires EVE Developer credentials at startup,
even if an operator initially uses only public data. Character linking itself is
optional: after credentials are configured, public SDE, market, route,
killboard, and OSINT workflows work without linking a character. To unlock
**private ESI** (skills, assets, wallet, location, mail, …), register a free
EVE Developer application (~5 minutes):

1. Open <https://developers.eveonline.com/applications/create> and sign in with
   your EVE account.
2. **Connection Type:** choose *Authentication & API Access*, then select the
   scopes you want to support (or all of them for full parity).
3. **Callback URL:** set it to *exactly* your `EVE_CALLBACK_URL`. For local use:

   ```text
   http://localhost:3000/auth/eve/callback
   ```

4. Copy the **Client ID** and **Secret Key** into `.env`:

   ```env
   EVE_CLIENT_ID=your_client_id
   EVE_CLIENT_SECRET=your_secret_key
   ```

5. Restart. `/login` in the CLI and `/eve_login` in Telegram or Discord now
   return a working SSO link.

## Terminal CLI (no bot token needed)

Talk to the agent directly in your terminal — a third platform adapter beside
Telegram and Discord, driving the same runtime. It needs the same local `.env`
configuration as the app, but no Telegram or Discord bot token:

```bash
npm run cli
```

```text
┌─ EVE AI Agent · CLI ───────────────────────────────┐
│ Talk to the agent in your terminal. Commands:      │
│   /login   link an EVE character (opens SSO)       │
│   /whoami  show the active character               │
│   /clear   wipe this conversation                  │
│   /exit    quit                                    │
└────────────────────────────────────────────────────┘
eve> route from Jita to Amarr, is it dangerous?
```

Public tools (SDE lookups, market, route planning with danger analysis,
killboards, OSINT) work without a linked character. Run `/login` to link an EVE
character via SSO and unlock private ESI (skills, assets, location, mail, …).
The full bots still need a Telegram or Discord token; the CLI does not.

While the agent works, the CLI shows a **live activity feed** — a brief
"thinking" note and one line per tool/skill as it runs (e.g. `🗄 SDE query`,
`💰 market prices`, `🛰 ESI · …`) — then renders the finished answer:

```text
eve> Сколько стоит Plex?
  💭 Checking PLEX price; resolve type_id, then market price
  🗄  SDE query · query
  💰 market prices · 1 item
PLEX: 4,621,543 ISK (global average — no regional order book).
```

This feed is CLI-only: the Telegram and Discord bots reply with one finished
message and are unaffected. The answer is rendered once from the finalized
(sanitized) text, not streamed token by token, so it is always clean and
complete.

## Scripts

```bash
npm run cli            # interactive terminal agent (no bot token required)
npm run dev            # tsx watch mode (recommended for running the bots)
npm run build          # compile server (tsc)
npm start              # run built app: node dist/app.js
npm run check          # typecheck + tests + lint
npm test               # vitest
npm run smoke          # env, model endpoint, app health checks
npm run smoke:openai   # authenticated /v1/responses probe
npm run smoke:eve-tool # authenticated model + EVE SDE tool probe
npm run db:migrate     # run SQLite migrations
npm run setup          # download and load SDE data
```

On startup the app prints a status banner with database, SDE, HTTP, platform,
OpenAI, and heartbeat state. Structured logger output is timestamped and redacts
recognizable credentials; request-level diagnostics can still contain short user
goals, tool arguments, reasoning summaries, or provider-error snippets. Treat
process logs as private operational data.

## Runtime Smoke Test

Authenticated OpenAI smoke test:

```bash
OPENAI_API_KEY=... npm run smoke:openai
```

EVE tool smoke test:

```bash
OPENAI_API_KEY=... npm run smoke:eve-tool
```

For a DB-only SDE tool check without calling the model:

```bash
EVE_TOOL_SMOKE_MODE=direct npm run smoke:eve-tool
```

The scripts print only sanitized endpoint/model/tool metadata and answer previews. They never log API keys.

## Self-Hosting

See [docs/deployment.md](./docs/deployment.md) for a generic production deployment guide. Before publishing a fork or a release, run `npm run audit:public`, `npm run check`, and `npm run build`. Keep operator-specific server addresses, credentials, logs, certificates, and runbooks outside this repository.

## Documentation

- [AGENTS.md](./AGENTS.md): concise repo map and invariants.
- [ARCHITECTURE.md](./ARCHITECTURE.md): runtime boundaries and request flows.
- [docs/index.md](./docs/index.md): documentation catalog.
- [docs/SECURITY.md](./docs/SECURITY.md): security rules and current gaps.
- [docs/RELIABILITY.md](./docs/RELIABILITY.md): reliability model.
- [docs/deployment.md](./docs/deployment.md): generic self-host guide.
- [docs/openai-integration.md](./docs/openai-integration.md): OpenAI Responses API configuration.
- [docs/generated/db-schema.md](./docs/generated/db-schema.md): SQLite schema reference.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), keep PRs focused, and run `npm run check` when feasible. Good first areas include documentation, reproducible bug fixes, prompt tests, EVE SDE lookups, chat formatting, and self-hosting troubleshooting.

Please do not include secrets, private deployment notes, server IPs, logs, database files, or SDE dumps in issues or pull requests.

## Legal Notice

EVE Online and all related logos, images, and trademarks are the property of CCP hf. This project is a third-party tool and is not affiliated with, endorsed by, or supported by CCP Games.

Use of EVE Online SSO, ESI, SDE, and related game data is subject to the [EVE Online Developer License Agreement](https://developers.eveonline.com/license-agreement). Each self-hosting operator is responsible for accepting and complying with that agreement when creating an EVE Developer application and running an instance.

## Community Showcase Readiness

The ready-to-copy Showcase page and evidence-backed eligibility matrix are in [docs/community-showcase.md](./docs/community-showcase.md). GitHub records the canonical `garshany/eveai` repository's initial public event on 2026-03-24, and its public CI history includes a `master` run on 2026-03-25. The three-month public-age requirement has therefore passed; re-check the current CCP requirements immediately before submitting.

## Open-Source Safety Notice

If you are publishing a fork that previously contained private deployment files or secrets, do not make that repository public as-is. Publish from a clean sanitized export or rewrite history, rotate exposed credentials, and run a secret scan before release.

## License

MIT. See [LICENSE](./LICENSE).
