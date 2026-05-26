# Data Boundaries

## Data Classes

- durable identity state: users, chats, sessions, linked characters
- conversation state: threads, messages, summaries, artifacts, plans
- live game data: ESI responses and temporary cache entries
- static game data: SDE exports and normalized SQLite tables
- generated user context: `USER_*.md` snapshots

## Boundary Rules

- static SDE lookups and live ESI reads must stay separate
- cache data is disposable and should be reproducible
- docs are knowledge, not runtime state
- runtime DB files in `data/` are artifacts, not hand-maintained source files
