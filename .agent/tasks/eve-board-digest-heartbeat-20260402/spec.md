# EVE Board Digest Heartbeat

## Goal
Keep live ESP analytics visible during route monitoring instead of sending only one initial digest followed by raw kill alerts.

## Acceptance Criteria
- AC1: Periodic route digest can re-send after a heartbeat interval even when no new delta event fired.
- AC2: Heartbeat applies only to actionable routes, not quiet LOW/no-intel routes.
- AC3: Regression coverage and repo checks pass.
