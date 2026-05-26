# Runtime Domains

## Domains

- agent runtime: model loop, tools, planning, finalization
- auth: Telegram login, EVE SSO, session and ownership state
- EVE domain: ESI transport, capability checks, SDE, route and killmail features
- transport surfaces: Telegram bot and Fastify web routes
- persistence: SQLite schema, migrations, caches, and thread memory

## Layering Rule

Outer layers call inward. Telegram and web layers should delegate to domain modules rather than owning business logic directly.
