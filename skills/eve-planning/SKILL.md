---
name: eve-planning
description: Use for multi-step EVE tasks that require planning, dependency tracking, or replanning after failures.
---

## When to use

When a user request requires multiple data fetches, cross-referencing, or sequential logic. Examples:
- "What's the profit margin on building a Rifter?"
- "Show my wallet history and correlate with market prices"
- "What ships can I fly with my current skills?"

## Workflow

1. Break the task into short steps (max 6-8 steps).
2. Separate data fetching from analysis.
3. Mark dependencies between steps using `depends_on`.
4. Call `update_plan` to persist the plan.
5. Execute steps in dependency order.
6. Update step status after each execution.
7. Replan on failure instead of retrying blindly.

## Step statuses

- `pending` -- not started
- `running` -- in progress
- `done` -- completed successfully
- `blocked` -- waiting on dependency or missing scope
- `failed` -- failed, needs replanning

## Replanning rules

- If a step fails due to missing scope, mark it `blocked` and suggest auth.
- If a step fails due to ESI error, try an alternative approach.
- If no alternative exists, mark the step `failed` and inform the user.
- Never retry the exact same call more than once.
