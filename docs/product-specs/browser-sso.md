# Browser Chat And EVE SSO

Status: active

The optional browser app is a same-origin adapter over the same SQLite-backed
agent runtime used by Telegram, Discord, and the CLI. It does not call OpenAI,
CheapVibeCode, ESI, or any tool directly from the browser.

## Product Flow

1. `GET /app` serves the built React client when `WEB_CHAT_ENABLED=true`.
2. A user can create an anonymous browser session or connect an EVE character.
3. The browser loads and creates conversations owned by that session.
4. `POST /api/web/chat` applies the shared in-flight, actor rate, and global
   concurrency guards before invoking the shared agent loop.
5. The configured process-wide provider (`openai` or `cheapvibecode`) handles
   the model turn. The browser receives only the final answer and a bounded
   activity summary.

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

`WEB_TRUST_PROXY=true` is valid only behind a reverse proxy controlled by the
operator. Otherwise forwarded client-address headers must remain untrusted.

## Provider Boundary

`OPENAI_PROVIDER=openai` preserves the official OpenAI HTTP/SSE path.
`OPENAI_PROVIDER=cheapvibecode` selects the fixed CheapVibeCode Codex Responses
WebSocket transport, client-side tool search, and bounded local parallel read
batches. Both modes enter through the same application-controlled tool
executor, private-data checks, persistence, and rate limits. Provider selection
is not a per-user browser option.
