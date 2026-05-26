# Self-Host Deployment Guide

This guide describes a generic deployment model for running your own EVE AI Agent instance. Keep real server addresses, SSH users, certificates, tokens, and operator runbooks outside this repository.

## Production Shape

Recommended baseline:

- one Node.js process running `dist/app.js`
- SQLite database on local disk
- Telegram grammY long polling, not webhooks
- Fastify bound to localhost or a private interface unless you intentionally expose the dashboard
- optional reverse proxy such as Caddy, nginx, or a platform load balancer for HTTPS
- no Redis, Postgres, background workers, or queue system

## Build

```bash
npm install
cp .env.example .env
npm run setup
npm run build
npm run db:migrate
npm start
```

## Required Environment

At minimum configure:

```env
TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=medium
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSE_STATE_MODE=stateless
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
AUTH_SECRET_KEY=...
EVE_CALLBACK_URL=https://your-domain.example/auth/eve/callback
WEB_BASE_URL=https://your-domain.example
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/2.1 (+https://github.com/your-org/eveai; contact=you@example.com)
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

The app talks to an OpenAI-compatible Responses API endpoint.

Use official OpenAI by default:

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=medium
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSE_STATE_MODE=stateless
```

The integration uses the Responses API with streaming, function tools, `store=false`, prompt cache keys, and stateless tool-call replay by default. The replay path preserves assistant output item fields such as `phase`, which GPT-5.5 guidance requires when manually passing output items back between turns.

For compatible gateways, keep `OPENAI_RESPONSE_STATE_MODE=stateless` unless the provider explicitly supports stored `previous_response_id` continuation. Stateless mode sends the previous `function_call` item together with `function_call_output`, which avoids provider-side response-state assumptions.

Use `server` mode only when the provider supports stored Responses state:

```env
OPENAI_RESPONSE_STATE_MODE=server
```

## Reverse Proxy

A reverse proxy is optional but recommended for HTTPS dashboard access and secure cookies.

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

`npm run smoke` checks required env vars, the configured model `/responses` endpoint, and the app health endpoint.

## Operations

- Keep `.env`, SQLite databases, SDE data, logs, and generated user profiles out of git.
- Back up `data/` if you need to preserve local users, sessions, EVE links, cache, and notes.
- Rotate `AUTH_SECRET_KEY` only with an explicit session/token migration plan; it derives storage keys for protected local secrets.
- Never publish tokens, SSH details, IP addresses, real domains, private reverse-proxy paths, or production runbooks in this repository.

## Open-Source Publishing Checklist

Before making a fork public:

1. Rotate any token, password, SSH key, or provider credential that ever appeared in chat logs, commits, CI logs, or local docs.
2. Publish from a clean sanitized export or rewrite history; do not expose a repo history that previously contained secrets or private infrastructure.
3. Run a current-tree secret scan and a history scan.
4. Confirm `.env`, `.env.*`, `data/`, `.agent/`, `.claude/`, local hooks, logs, and database files are ignored.
5. Confirm public docs describe self-hosting only.
