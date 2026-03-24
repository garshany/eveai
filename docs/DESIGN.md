# Design

## Core Direction

The repository is optimized for agent readability first and human readability second. Durable project knowledge must live in versioned repo artifacts, not in chat history or external docs.

## Design Principles

- Keep the entrypoint small and stable: `AGENTS.md` is a map, not an encyclopedia.
- Treat `docs/` as the system of record for architecture, product intent, plans, reliability, and security.
- Prefer progressive disclosure: start with the map, then descend into the exact document needed.
- Keep runtime boundaries narrow: Telegram, web, agent runtime, EVE integrations, and persistence each have a clear owner.
- Prefer generated or source-backed inventories over hand-maintained duplicated lists.

## Non-Goals

- No documentation sprawl inside many local `AGENTS.md` files.
- No giant monolithic repo manual.
- No hidden operational knowledge that only exists outside the repository.

## Verification Posture

The docs are only useful if they track real code. When runtime behavior changes, the matching doc must change in the same commit.
