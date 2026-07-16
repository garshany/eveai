# Browser Chat And EVE SSO

Status: active

The optional browser app is a same-origin adapter over the same SQLite-backed
agent runtime used by Telegram, Discord, and the CLI. It does not call OpenAI,
CheapVibeCode, ESI, or any tool directly from the browser.

## Product Flow

1. `GET /app` serves the built React client when `WEB_CHAT_ENABLED=true`.
2. A user can create an anonymous browser session or connect an EVE character.
3. Every EVE login link first opens the bilingual consent form. The user may
   authorize identity only or select any subset of the allowlisted private ESI
   groups; write/action scopes are off by default.
4. The browser loads and creates conversations owned by that session.
5. `POST /api/web/chat` applies the shared in-flight, actor rate, and global
   concurrency guards before invoking the shared agent loop.
6. The configured process-wide provider (`openai` or `cheapvibecode`) handles
   the model turn. The browser receives only the final answer and a bounded
   activity summary.
7. The same browser identity may repeat EVE SSO for multiple characters. The
   sidebar switches the active character and shows only its conversations.
   EVE SSO exposes a character, not a stable game-account identifier, so
   characters from different EVE accounts use the same per-character flow.

The browser lane is request/response only. Background heartbeat, kill-watch,
and route-monitor tools are not exposed and `plan_route` never auto-starts a
monitor for a browser context; use Telegram, Discord, or the interactive CLI
for durable push delivery.

The provider token is the operator's server-side credential. It is never sent
to users, stored in browser storage, included in HTML, or returned by an API.

## Routes

- `GET /health`
- `GET /app` and `GET /app/*`
- `GET|POST|DELETE /api/web/session`
- `POST /api/web/eve/login`
- `POST /auth/eve/consent`
- `GET|POST /api/web/conversations`
- `GET /api/web/conversations/:threadId/messages`
- `DELETE /api/web/conversations/:threadId`
- `GET /api/web/characters`
- `POST /api/web/characters/:characterId/activate`
- `POST /api/web/chat`
- `GET /auth/eve/login?state=...`
- `GET /auth/eve/callback`
- `GET /callback` compatibility redirect

## Session And Isolation Boundary

- the session cookie is random, opaque, `HttpOnly`, `SameSite=Lax`, and stored
  server-side only as a keyed hash;
- the separate CSRF cookie is validated with an exact same-origin `Origin`
  header and keyed server-side hash on every mutation;
- HTTPS deployments set both cookies `Secure`;
- browser chat IDs occupy a negative range disjoint from Telegram, Discord,
  and CLI lanes;
- every conversation read, mutation, and character activation checks both the
  internal user and browser chat lane;
- conversation lists and new threads are additionally bound to the active
  `character_id`, preventing a thread from one character from continuing under
  another;
- anonymous-session creation is bounded per effective client IP before new
  rows reach SQLite;
- each browser lane is capped at 40 conversations, repeated new-chat requests
  reuse the same empty thread, and only one pending SSO request is retained;
- logout and expiry transactionally purge the browser lane, its conversations,
  user-only links, and encrypted EVE credentials; a canonical Telegram,
  Discord, or CLI identity and its shared character ownership are retained;
- when a browser authenticates a character already owned by another channel,
  the browser lane joins that canonical internal user instead of transferring
  the character away from the existing channel.
- the one-time SSO request stores the consent version/language and the exact
  server-generated scope set; the callback rejects unacknowledged requests and
  any token that contains a scope outside that set.

`WEB_TRUSTED_PROXY_CIDRS` is an explicit allowlist of proxy socket peers.
Forwarded client-address headers from any other peer remain untrusted. A public
deployment must also prevent direct origin access at the network boundary.

## Provider Boundary

`OPENAI_PROVIDER=openai` preserves the official OpenAI HTTP/SSE path.
`OPENAI_PROVIDER=cheapvibecode` selects the fixed CheapVibeCode Codex Responses
WebSocket transport, client-side tool search, and bounded local parallel read
batches. Both modes enter through the same application-controlled tool
executor, private-data checks, persistence, and rate limits. Provider selection
is not a per-user browser option.

The consent screen names the configured provider because relevant private tool
results may be included in a model turn. EVE access/refresh tokens and provider
credentials never enter model input. See [eve-sso-consent.md](../eve-sso-consent.md).
