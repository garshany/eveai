# Web Dashboard

## Purpose

The web surface supports authentication and character management. It is not the main conversational interface.

## Routes

- `GET /`
- `GET /app`
- `GET /client/*`
- `GET /health`
- `GET /api/me`
- `POST /api/characters/:id/activate`
- `POST /api/characters/:id/unlink`

## Auth Routes

- `GET /auth/telegram/callback`
- `GET /auth/eve/start`
- `GET /auth/eve/callback`
- `GET /auth/tg-handoff`
- `POST /auth/tg-handoff/exchange`
- `POST /auth/logout`
- `GET /callback`

## Handoff Notes

- the Telegram bot opens `/auth/tg-handoff#token=...`
- the browser reads the fragment locally, clears it from the address bar, and exchanges it with `POST /auth/tg-handoff/exchange`
- the handoff token must not be carried in a query string
