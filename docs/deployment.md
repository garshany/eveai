# Self-Host Deployment Guide

This guide describes a generic deployment model for running your own EVE AI Agent instance. Keep real server addresses, SSH users, certificates, tokens, and operator runbooks outside this repository.

## Production Shape

Recommended baseline:

- one Node.js process running `dist/app.js`
- a dedicated unprivileged OS account (the sample unit uses `eveai`)
- SQLite database on local disk
- Telegram grammY long polling, a Discord gateway bot, and/or the optional browser chat
- Fastify bound to localhost or a private interface; browser chat and EVE SSO need reverse-proxy reachability
- optional reverse proxy such as Caddy, nginx, or a platform load balancer for HTTPS on the SSO callback
- no Redis, Postgres, background workers, or external queue system

## Build

```bash
npm ci
cp .env.example .env
npm run setup
npm run build
npm run db:migrate
npm start
```

## Required Environment

At minimum configure:

```env
TELEGRAM_BOT_TOKEN=...        # and/or DISCORD_BOT_TOKEN — at least one is required
DISCORD_BOT_TOKEN=...
TELEGRAM_REQUEST_WINDOW_MS=60000
TELEGRAM_MAX_REQUESTS_PER_WINDOW=6
TELEGRAM_MAX_ACTIVE_REQUESTS_GLOBAL=24
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
OPENAI_REASONING_EFFORT=auto
OPENAI_REASONING_MODE=standard
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSES_TIMEOUT_MS=90000
OPENAI_RESPONSE_STATE_MODE=stateless
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
AUTH_SECRET_KEY=...
EVE_CALLBACK_URL=https://your-domain.example/auth/eve/callback
WEB_BASE_URL=https://your-domain.example
WEB_CHAT_ENABLED=true
WEB_TRUST_PROXY=true
WEB_SESSION_TTL_HOURS=720
WEB_SESSION_CREATION_WINDOW_SECONDS=600
WEB_MAX_SESSION_CREATIONS_PER_WINDOW=30
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/3.3 (+https://github.com/your-org/eveai; contact=you@example.com)
EVE_KILL_TIMEOUT_MS=8000
EVE_KILL_USER_AGENT=EVEAI/3.3 (+https://github.com/your-org/eveai; contact=you@example.com)
EVE_KILL_RETRY_MAX_ATTEMPTS=3
EVE_KILL_BACKOFF_MAX_MS=10000
```

Generate `AUTH_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

## EVE Developer Portal

Create an application at <https://developers.eveonline.com/> and configure the callback URL to match `EVE_CALLBACK_URL`.

By creating and using an EVE Developer application, each operator is responsible for accepting and complying with the EVE Online Developer License Agreement: <https://developers.eveonline.com/license-agreement>.

Keep the application non-commercial unless your use fits CCP's permitted monetization terms or you have separate written permission from CCP. Do not present this project or your deployment as affiliated with, endorsed by, or supported by CCP Games.

For local development:

```text
http://localhost:3000/auth/eve/callback
```

For a public deployment:

```text
https://your-domain.example/auth/eve/callback
```

## Model Provider

The app uses the Responses API and maps explicit provider IDs to fixed
transports/endpoints. It does not accept an arbitrary base URL:

```env
OPENAI_PROVIDER=openai
OPENAI_MODEL=gpt-5.6-sol
OPENAI_REASONING_EFFORT=auto
OPENAI_REASONING_MODE=standard
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSES_TIMEOUT_MS=90000
OPENAI_RESPONSE_STATE_MODE=stateless
OPENAI_STORE_RESPONSES=false
```

`OPENAI_PROVIDER=openai` targets `https://api.openai.com/v1`.
`OPENAI_PROVIDER=cheapvibecode` targets the one-shot WebSocket route
`wss://cheapvibecode.ru/backend-api/codex/responses` and requires stateless
response mode. The explicit allowlist prevents an accidental
base-URL typo from redirecting API credentials and chat/tool data. The
CheapVibeCode profile omits the optional `truncation:"auto"` field because live
tool-call probes showed that the gateway otherwise took the slow text-only path;
it also omits encrypted reasoning replay because that option likewise changed a
tool call into plain text on the gateway. Stateless continuation replays the
function calls and outputs while filtering provider reasoning items. The
application's bounded SQLite context and compaction remain active.

The provider selection and `OPENAI_API_KEY` are process-wide operator
credentials shared by all enabled chat surfaces. The browser never receives
the key. Each browser visitor gets an isolated opaque session and chat lane,
while agent concurrency, provider admission, and actor rate limits remain
server-controlled.

Browser session creation is IP-admitted, each session has a hard conversation
cap, and only one pending browser SSO request is retained. Logout and expiry
remove browser-only durable data and encrypted EVE credentials transactionally;
identities shared with Telegram, Discord, or CLI keep their canonical account
and character links.

Choose `gpt-5.6-sol` for maximum capability, `gpt-5.6-terra` for a balanced deployment, or `gpt-5.6-luna` for efficient high-volume traffic. The integration uses streaming, function tools, prompt cache keys, and stateless tool-call replay. Stored Responses remain default-off; set `OPENAI_STORE_RESPONSES=true` only when the operator accepts provider retention of chat context and tool data and wants the requests visible at <https://platform.openai.com/logs?api=responses>. The replay path preserves assistant output item fields such as `phase` when passing output items between tool rounds.

Keep `OPENAI_RESPONSE_STATE_MODE=stateless` for the default and rollback path.
To evaluate provider continuation, set both
`OPENAI_RESPONSE_STATE_MODE=server` and `OPENAI_STORE_RESPONSES=true`, then
restart. Server mode reuses only a recent Response id atomically anchored to the
latest assistant message; any drift, compaction, missing provider state, or
unexpected history rebuilds from SQLite. The provider chain still counts toward
input usage, and top-level instructions are resent on every request.

## EVE-KILL

The public REST client is pinned to `https://api.eve-kill.com/`; there is no
deployment base-URL override. Configure a reachable operator contact in
`EVE_KILL_USER_AGENT`.
Timeout and backoff values must be positive and are hard-capped at 60 seconds;
retry attempts are hard-capped at five.

The first successful feed start stores the current upstream head and does not
replay historical notifications. Back up the SQLite database to preserve the
feed cursor, per-chat delivery dedup, watches, and active route monitors. A
restored database resumes from its stored cursor; delivery is at-least-once, so
a notification may repeat if the process crashes after network acceptance but
before the SQLite commit.

The app may run Telegram-only, Discord-only, or both. Watches and route monitors
for a platform whose bot token is absent remain stored but are suspended for
that run, so they cannot block the shared cursor; feed events missed during the
suspension are not replayed when the platform is enabled later.

The terminal CLI uses an explicit `cli_accounts` identity at `chat_id = 0`.
It does not create a Telegram account, and migrations never infer CLI ownership
from a positive numeric Telegram id. The CLI and bot service acquire the same
lock next to `DB_PATH`; start only one of them for a given database. CLI route
monitors and EVE-KILL watches deliver while the CLI is open and restore their
state on its next launch, without replaying events missed while it was closed.

Direct hosted EVE-KILL MCP is disabled. Full agent mode uses the local
`eve_kill` REST namespace plus the local `eve_kill_analytics` namespace for
`doctrine_detect`, `meta_pulse`, `killmail_forensics`, and `coalition_graph`.
The latter validates a narrow public-only argument object before calling the
fixed MCP endpoint; it needs no additional token or deployment setting. See
[`openai-integration.md`](./openai-integration.md) for the privacy boundary.

## Reverse Proxy

A reverse proxy is required for a public browser deployment and recommended for
serving the EVE SSO callback over HTTPS. Set `WEB_TRUST_PROXY=true` only when
Fastify is directly behind a proxy you control; otherwise an attacker could
forge the address used by anonymous-session admission limits.

Generic Caddy example:

```caddyfile
your-domain.example {
  reverse_proxy 127.0.0.1:3000
}
```

Generic nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.example;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## systemd Example

Copy and adapt the generic unit at `deploy/systemd/eveai.service` if you deploy on a Linux host with systemd.
Create the dedicated `eveai` account first, grant it read access to the release
and environment file, and grant write access only to the configured `data/`
directory. Do not run the service as root.

Install example:

```bash
sudo install -m 644 deploy/systemd/eveai.service /etc/systemd/system/eveai.service
sudo systemctl daemon-reload
sudo systemctl enable --now eveai
sudo systemctl status eveai --no-pager
```

## Health And Smoke Checks

Run the app and then verify:

```bash
curl -fsS http://127.0.0.1:3000/health
npm run smoke
```

`npm run smoke` checks the configured startup env subset, the official model
`/responses` endpoint, and app health. It is not a substitute for a production
startup check, which also requires `AUTH_SECRET_KEY`.

## Operations

- Keep `.env`, SQLite databases, SDE data, logs, and generated user profiles out of git.
- Back up `data/` if you need to preserve local users, sessions, EVE links, feed cursors/dedup, route monitors, cache, and notes.
- Rotate `AUTH_SECRET_KEY` only with an explicit session/token migration plan; it derives storage keys for protected local secrets.
- Never publish tokens, SSH details, IP addresses, real domains, private reverse-proxy paths, or production runbooks in this repository.

## Updating

All chat surfaces are read-only with respect to project updates. Check the
canonical latest stable release from CLI, Telegram, Discord, or an operator
shell:

```bash
npm run update:check
```

Do not run `git pull`, `npm ci`, or a service restart from a chat command or from
inside the live process. The current release tags are not a cryptographic trust
mechanism, package lifecycle scripts execute code, and an in-place failure can
leave a mixed installation. Use a local operator/supervisor workflow:

1. Read the validated release link and choose its exact `vMAJOR.MINOR.PATCH` tag.
2. Fetch that explicit tag from the fixed canonical repository into a
   namespaced ref. Do not trust `origin` (a self-hosted checkout may be a fork),
   and do not reuse a possibly conflicting local tag:

   ```bash
   git fetch --no-tags --force https://github.com/garshany/eveai.git \
     +refs/tags/vX.Y.Z:refs/eveai-releases/vX.Y.Z
   git rev-parse 'refs/eveai-releases/vX.Y.Z^{commit}'
   git show --no-patch --decorate refs/eveai-releases/vX.Y.Z
   ```

3. Stage outside the live directory and verify before activation:

   ```bash
   git worktree add --detach /srv/eveai-releases/vX.Y.Z \
     'refs/eveai-releases/vX.Y.Z^{commit}'
   cd /srv/eveai-releases/vX.Y.Z
   npm ci
   npm run audit:public
   npm run check
   npm run build
   ```

4. Stop the service through its supervisor, make a consistent SQLite/data
   backup, and keep `.env` plus writable `data/` outside the immutable release.
   Configure absolute `DB_PATH`, SDE, and profile paths when the working
   directory changes.
5. Point the supervisor at the staged `dist/app.js`, start it, and verify the
   exact version banner, `/health`, enabled bot connectivity, logs, and a real
   user command.
6. Retain the prior release for a forward rollback, but do not switch old code
   back blindly after migrations. Restore compatibility or data through an
   explicit migration-aware recovery plan.

The sample systemd unit uses `ProtectSystem=strict`: the checkout and built code
are read-only, and only `/srv/eveai/data` is writable for runtime state and its
DB-adjacent process lock. Before installing it, create that directory for the
dedicated account (for example, `install -d -o eveai -g eveai -m 0700
/srv/eveai/data`) while keeping `/srv/eveai`, `.env`, `dist/`, and
`package.json` non-writable by `eveai`. Adapt release-directory paths to your
own supervisor without committing host-specific values here.

## v3 Release Gate

Before publishing a public release or making a fork public, run these commands
against the exact commit that will be released:

```bash
npm ci
npm run audit:public
npm run check
npm run build
```

`npm run audit:public` rejects tracked credential-like values and private
artifacts such as nested `.env` files, runtime data, logs, database variants,
and local agent artifacts. It is a release guard, not a replacement for
rotating a credential that has ever been exposed or for reviewing reachable Git
history.

## Open-Source Publishing Checklist

Before making a fork public:

1. Rotate any token, password, SSH key, or provider credential that ever appeared in chat logs, commits, CI logs, or local docs.
2. Publish from a clean sanitized export or rewrite history; do not expose a repo history that previously contained secrets or private infrastructure.
3. Run `npm run audit:public`, then run a history secret scan.
4. Confirm `.env`, `.env.*`, `data/`, `.agent/`, `.claude/`, local hooks, logs, and database files are ignored.
5. Confirm public docs describe self-hosting only.
