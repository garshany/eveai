# Quality Score

Scoring uses `1` to `5`, where `5` means strong structure plus regression coverage.

| Domain | Score | Evidence | Gap |
| --- | --- | --- | --- |
| Agent runtime | 4 | dedicated modules plus tests for planner, executor, finalizer, prompts, native responses | prompt policy is still dense and should be decomposed further |
| Auth and identity | 4 | callback, auth storage, session, and route tests exist | ownership and legacy-path cleanup still coexist |
| ESI transport | 4 | retry, caching, compatibility date, and capability logic are explicit | operation surface is large and catalog drift risk remains |
| SDE pipeline | 3 | loader, downloader, SQL security test, and normalized tables exist | generated docs and ingestion contracts are still thin |
| Telegram UX | 4 | command handlers and bot tests exist | command copy and behavior are not yet spec-driven in docs |
| Web surface | 4 | health, auth routes, CSP, and asset serving are tested | dashboard API surface is small but not formally versioned |
| Documentation system | 2 | core structure now exists in-repo | no CI lint or doc-gardening automation yet |

## Current Quality Priorities

- add mechanical checks for docs coverage and stale references
- tighten product-spec coverage for Telegram and web flows
- reduce duplication between legacy chat-based identity paths and current user-based identity paths
