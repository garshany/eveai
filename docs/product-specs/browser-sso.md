# Browser SSO Callback

The browser is not an end-user dashboard. Fastify exposes only the EVE SSO login redirect/callback and the health endpoint.

## Routes

- `GET /health`
- `GET /auth/eve/login?state=...` — validates a one-time login state and redirects to EVE SSO
- `GET /auth/eve/callback` — receives the EVE SSO callback and links the character to its originating chat lane
- `GET /callback` — compatibility redirect to `/auth/eve/callback`

## Security Boundary

- the one-time state is validated before redirect and consumed on callback
- EVE tokens are encrypted before local storage
- the success page contains no dashboard session or private character data beyond the linked character name and granted-scope count
- there are no `/app`, `/client/*`, or `/api/*` dashboard routes
