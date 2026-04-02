# EVE Board Combat ESP

## Goal
Push `src/eve-board` toward a more tactical "combat ESP" style output so route analysis emphasizes route-relative risk, tactical state, and actionable windows instead of only kill counts.

## Acceptance Criteria
- AC1: Route threat digest includes a tactical assessment derived from current/start, transit, destination, and rear route zones.
- AC2: Live ESP output exposes tactical state/window context in addition to the existing `Сейчас / Впереди / Действие` contract.
- AC3: Pre-flight briefing includes a concise tactical line so one-shot route output also feels more operational.
- AC4: Regression coverage and full repo checks pass.
