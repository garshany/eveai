# Security Policy

## Reporting

Do not open public issues for vulnerabilities that expose tokens, sessions, private ESI data, or account takeover paths. Report privately to the maintainer contact configured by your fork or deployment operator.

## Supported Surface

This project is a self-hosted application. Each operator is responsible for protecting their `.env`, SQLite database, generated `data/` files, Telegram and Discord bot tokens, OpenAI API key, EVE SSO secret, and host credentials.

## Before Publishing A Fork

- Rotate any credential that appeared in commits, chat logs, CI logs, screenshots, or local docs.
- Publish from a clean sanitized export or rewritten history if private infrastructure ever existed in the repository.
- Keep `.env`, `.env.*`, `data/`, `.agent/`, `.claude/`, logs, and database files out of git.
- Run a current-tree and history secret scan.

Runtime security design is documented in [docs/SECURITY.md](./docs/SECURITY.md).
