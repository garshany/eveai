# Terminal CLI

## Primary Surface

The interactive terminal is a third chat adapter with the explicit local lane
`chat_id = 0`. It uses the same agent, SQLite state, EVE SSO callback, and
EVE-KILL feed implementation without requiring a bot token.

## Commands

- `/login`
- `/whoami`
- `/characters` (`/chars`)
- `/clear` (`/reset`)
- `/version` (`/update`, `/update check`)
- `/exit` (`/quit`)

## Durable behavior

- EVE-KILL watches and route monitoring deliver prompt-safe alerts while the CLI is open.
- Watch and route-monitor rows persist and eligible route monitors restore on the next CLI launch.
- Events missed while the CLI is closed are not replayed.
- Heartbeat configuration is not exposed because the CLI does not own that scheduler.
- The CLI and bot service cannot concurrently own the same `DB_PATH`.

## Update behavior

Version commands are read-only and use the shared canonical stable-release
checker. They do not modify the checkout, install dependencies, or restart the
process.
