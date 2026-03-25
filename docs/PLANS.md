# Plans

## Planning Policy

- Small changes can be executed directly with lightweight local reasoning.
- Multi-step or risky changes should be captured under `docs/exec-plans/`.
- Active and completed plans stay in the repo so future agents can reconstruct prior decisions.

## Current State

- `docs/exec-plans/active/` is the queue for in-flight substantial work.
- `docs/exec-plans/completed/` is the history of completed execution plans.
- `docs/exec-plans/tech-debt-tracker.md` tracks known structural issues that are not tied to one active task.
- plans are versioned repo artifacts, not external chat-only context

## Planning Standard

Each execution plan should capture:

- problem statement
- scope boundaries
- implementation steps
- progress log
- decision log
- follow-up work

## Related Docs

- [index.md](./index.md)
- [exec-plans/active/index.md](./exec-plans/active/index.md)
- [exec-plans/completed/index.md](./exec-plans/completed/index.md)
- [exec-plans/tech-debt-tracker.md](./exec-plans/tech-debt-tracker.md)
