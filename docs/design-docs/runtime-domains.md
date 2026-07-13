# Runtime Domains

## Domains

- agent runtime: model loop, tools, planning, finalization
- auth: EVE SSO, one-time login state, encrypted token storage, and ownership state
- EVE domain: ESI transport, capability checks, SDE, route and killmail features
- transport surfaces: Telegram private chats, Discord DMs, and Fastify SSO/health routes
- persistence: SQLite schema, migrations, caches, and thread memory

## Layering Rule

Outer layers call inward. Telegram, Discord, and browser SSO layers should delegate to domain modules rather than owning business logic directly.
