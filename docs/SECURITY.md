# Security

## Core Rules

- model-facing code must not get raw secrets, refresh logic, pagination internals, or shell access
- private ESI access must remain isolated per user and chat
- Telegram bot is private-chat only
- auth state is one-time and expires
- encrypted storage is used for EVE token material

## Web Protections

- CSP blocks inline script execution and restricts script sources
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- HSTS is emitted for secure deployments
- permissions policy disables unused browser capabilities

## Auth Protections

- Telegram login data is verified server-side
- Telegram login nonce is one-time and expiring
- EVE callback state is validated and marked used
- logout clears the web session cookie

## Current Gaps

- no automated documentation drift enforcement yet
- legacy compatibility paths in auth storage increase reasoning surface
- production secrets handling is operationally documented but not yet encoded as policy checks
