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
- `POST /auth/logout`
- `GET /callback`
