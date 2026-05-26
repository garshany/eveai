# Contributing

- Keep the app single-process Node.js with SQLite.
- Do not add workers, queues, Redis, Postgres, or Telegram webhooks.
- Keep private ESI access isolated per Telegram user/chat and gated by `get_eve_capabilities`.
- Do not commit secrets, local server addresses, private domains, production paths, logs, or operator runbooks.
- Update matching docs when behavior changes.
- Run `npm run check` before submitting changes when feasible.
