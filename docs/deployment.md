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
WEB_TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128
WEB_SESSION_TTL_HOURS=720
WEB_SESSION_CREATION_WINDOW_SECONDS=600
WEB_MAX_SESSION_CREATIONS_PER_WINDOW=30
WEB_MAX_CONCURRENT_AGENT_REQUESTS=8
WEB_MAX_QUEUED_AGENT_REQUESTS=64
WEB_MAX_QUEUED_AGENT_REQUESTS_PER_USER=1
WEB_REQUEST_WINDOW_SECONDS=60
WEB_MAX_REQUESTS_PER_USER_WINDOW=6
WEB_MAX_REQUESTS_GLOBAL_WINDOW=120
WEB_MAX_REQUESTS_GLOBAL_DAY=10000
WEB_MAX_COST_UNITS_PER_USER_WINDOW=24
WEB_MAX_COST_UNITS_GLOBAL_WINDOW=480
WEB_MAX_COST_UNITS_GLOBAL_DAY=40000
WEB_AGENT_DEADLINE_MS=180000
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
TURNSTILE_EXPECTED_HOSTNAME=your-domain.example
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/4.0 (+https://github.com/your-org/eveai; contact=you@example.com)
EVE_KILL_TIMEOUT_MS=8000
EVE_KILL_USER_AGENT=EVEAI/4.0 (+https://github.com/your-org/eveai; contact=you@example.com)
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
`OPENAI_PROVIDER=modelhub` targets the OpenAI-compatible HTTP/SSE route
`https://modelhub.my/v1/responses` and requires stateless response mode.
The explicit allowlist prevents an accidental
base-URL typo from redirecting API credentials and chat/tool data. The
ModelHub profile omits the optional `truncation:"auto"` field and encrypted
reasoning replay because neither is confirmed on the proxy. Stateless
continuation replays the
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

A reverse proxy is required for a public browser deployment. Configure
`WEB_TRUSTED_PROXY_CIDRS` with only the socket peers that can reach Fastify.
The application ignores forwarded client-address headers from every other
peer. Never use a trust-all proxy setting. Restrict origin ingress with the
Google Cloud firewall or a Cloudflare Tunnel; application header validation is
not a substitute for keeping the origin private.

Browser chat is asynchronous: `POST /api/web/chat` returns `202` immediately,
then the UI polls the durable SQLite request record. A proxy connection timeout
therefore cannot discard a long agent turn. Do not cache `/api/web/*`, SSO, or
Turnstile responses at Cloudflare.

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

## Cloudflare Zone Automation

When the app is fronted by Cloudflare Tunnel (`your-domain.example` →
`http://localhost:3000`), apply post-deploy zone hardening with the scripts in
`scripts/cloudflare/`. They call the Cloudflare API v4 with `curl` and `jq` and
are idempotent: managed rules are matched by a description marker and updated
in place, so re-running after a manual dashboard change converges the zone
instead of duplicating rules. Run them from a local operator shell, not from
the server process.

What `setup-zone.sh` applies:

- SSL/TLS mode `Full (strict)`, `Always Use HTTPS` on, security level `medium`
- Bot Fight Mode enabled via `PUT /zones/{id}/bot_management` (field
  `fight_mode`; available on the Free plan). If the token cannot read or
  change it, the script prints a warning — enable it manually under
  Security → Bots → Bot Fight Mode; this is not treated as a failure.
- Cache Rules: bypass cache for `/api/web/*` and `/auth/*` (see
  "Reverse Proxy" above — these responses must never be cached)
- Rate Limiting: 20 requests per 10 s per IP on `/auth/*`, action
  `managed_challenge` (override with `CF_RATE_LIMIT_ACTION=block`), mitigation
  timeout 10 s — the only timeout the Free plan is entitled to, so the
  challenge window is 10 s rather than the 60 s that would be preferable

Rule expressions use the `starts_with()` function, not the regex `matches`
operator: `matches` requires a Business or Enterprise plan and is rejected by
the API on Free ("not entitled"). Prefix matching with `starts_with()` has the
same semantics for the fixed path prefixes above and works on every plan.

Free plan limits are respected: 10 cache rules, 1 rate limiting rule, 5 custom
WAF rules. The script refuses to add a rule that would exceed a limit and
never touches unrelated existing rules.

### API token with minimal permissions

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.
2. Permissions, all zone-level:
   - Zone → Zone → Read (resolves the zone id from `CF_ZONE_NAME`)
   - Zone → Zone Settings → Edit (SSL mode, security level, Always Use HTTPS)
   - Zone → Cache Rules → Edit
   - Zone → Rate Limiting → Edit
   - Zone → Bot Management → Edit (Bot Fight Mode on/off)
3. Zone Resources → Include → Specific zone → your zone only.
4. Store the token in your local environment or a secret manager; never commit
   it. If a call still returns 403, add the permission group named in the API
   error and re-run.

### Run

```bash
export CF_API_TOKEN=...
export CF_ZONE_NAME=your-domain.example   # or: export CF_ZONE_ID=<zone id>

bash scripts/cloudflare/setup-zone.sh    # apply / converge the zone
bash scripts/cloudflare/verify-zone.sh   # read-only audit, exits 1 on drift
```

Requires `curl` and `jq` (`brew install jq` on macOS, `apt-get install jq` on
Debian/Ubuntu). `verify-zone.sh` prints the current value next to the expected
one for every managed setting and rule.

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

## Off-Host Backups to Cloudflare R2

`scripts/backup-data-r2.sh` creates a consistent backup of the `data/`
directory and uploads it to a Cloudflare R2 bucket over the S3 API. The app
keeps SQLite in WAL mode, so the script copies the database with the SQLite
online backup API (`sqlite3 .backup`) and verifies it with
`PRAGMA integrity_check` — the service keeps running and does not need a stop
window. The live DB, WAL, SHM, and runtime lock files are excluded from the
file-level copy; the SDE tree (~650 MB) is excluded by default because it can
be rebuilt with `npm run setup` (set `INCLUDE_SDE=true` to include it).
Uploads land under date prefixes, and old objects are pruned after
`RETENTION_DAYS` (default 14, `0` disables pruning).

### R2 setup

1. Cloudflare dashboard → R2 → Create bucket (for example `eveai-backups`).
   Note the account ID shown on the R2 overview page.
2. R2 → Manage R2 API Tokens → Create API token: permission **Object Read &
   Write**, scoped to that one bucket. Store the access key ID and secret in a
   password manager; the secret is shown once.
3. Optional (recommended even with script pruning): bucket Settings → Object
   lifecycle rules → delete objects after N days as a server-side safety net.

### VM packages

```bash
sudo apt-get install -y sqlite3
curl -fsSL https://rclone.org/install.sh | sudo bash   # or: sudo apt-get install -y rclone
```

The script talks to R2 through rclone configured purely from environment
variables — no rclone config file, no secrets in argv or logs.

### Credentials file

Keep the R2 credentials in a root-only environment file, never in the repo or
the app `.env`:

```bash
sudo install -d -m 0700 /etc/eveai
sudo tee /etc/eveai/r2-backup.env >/dev/null <<'EOF'
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET=eveai-backups
# RETENTION_DAYS=14
# INCLUDE_SDE=false
EOF
sudo chmod 0600 /etc/eveai/r2-backup.env
```

### Schedule with a systemd timer

The script only reads `data/`, so it can run as root; no write access to the
app directory is needed. Create two units:

```bash
sudo tee /etc/systemd/system/eveai-backup.service >/dev/null <<'EOF'
[Unit]
Description=eveai data backup to Cloudflare R2
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/eveai/r2-backup.env
Environment=DATA_DIR=/srv/eveai/data
ExecStart=/srv/eveai/scripts/backup-data-r2.sh
EOF

sudo tee /etc/systemd/system/eveai-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily eveai data backup to Cloudflare R2

[Timer]
OnCalendar=*-*-* 04:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now eveai-backup.timer
```

A cron entry works too (`0 4 * * * root set -a; . /etc/eveai/r2-backup.env; set +a; DATA_DIR=/srv/eveai/data /srv/eveai/scripts/backup-data-r2.sh`), but the timer gives you `journalctl -u eveai-backup.service` for history.

### Verify

```bash
sudo systemctl start eveai-backup.service        # run once by hand
sudo journalctl -u eveai-backup.service -n 30 --no-pager
systemctl list-timers eveai-backup.timer
```

The log must end with `done: r2:<bucket>/backups/<YYYY>/<MM>/eveai-data-<timestamp>.tar.gz`.

### Restore

```bash
# 1. List and download the archive (uses the same env-configured rclone remote):
set -a; . /etc/eveai/r2-backup.env; set +a
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY \
  RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
rclone lsf "r2:$R2_BUCKET/backups/" --recursive
rclone copyto "r2:$R2_BUCKET/backups/2026/07/eveai-data-<timestamp>.tar.gz" /tmp/eveai-restore.tar.gz

# 2. Stop the app, swap data, verify, start:
sudo systemctl stop eveai
sudo mv /srv/eveai/data /srv/eveai/data.old
sudo install -d -o eveai -g eveai -m 0700 /srv/eveai/data
sudo tar -xzf /tmp/eveai-restore.tar.gz -C /srv/eveai/data --strip-components=1 data
sudo chown -R eveai:eveai /srv/eveai/data
sqlite3 /srv/eveai/data/eve-agent.db 'PRAGMA integrity_check;'   # must print: ok
sudo systemctl start eveai
curl -fsS http://127.0.0.1:3000/health
```

If the archive was taken with the default `INCLUDE_SDE=false`, rebuild the SDE
after the restore (`sudo -u eveai npm run setup` in the release directory, or
copy `sde/` from `data.old` if it is still on disk). Keep `data.old` until the
restored instance has served real traffic. Note that restoring rolls users,
sessions, EVE links, and feed cursors back to the backup timestamp; the
EVE-KILL feed resumes from its stored cursor and does not replay events missed
after it.

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

## v4 Release Gate

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
