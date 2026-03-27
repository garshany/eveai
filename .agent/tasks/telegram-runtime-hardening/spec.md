# Task Spec: telegram-runtime-hardening

## Metadata
- Task ID: telegram-runtime-hardening
- Created: 2026-03-27T20:53:57+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- CLAUDE.md

## Original task statement
Investigate and fix production Telegram runtime issues around proxy tool-state mismatch (No tool call found for function call output with call_id ...), private ESI decrypt/auth failures (Unsupported state or unable to authenticate data), slow moon-related requests, and adjacent failure patterns similar to the recent region-moons issue. Track the newly sent moon request in production logs, verify Codex proxy/API behavior and latency, identify where these classes of failures can recur, implement the smallest safe fixes, and leave full repo-task-proof-loop artifacts.

## Acceptance criteria
- AC1: Warm-turn proxy tool-state mismatches (`No tool call found for function call output with call_id ...`) must not surface as raw runtime failures to Telegram users. The runtime must either recover deterministically to a cold/local path or fail with a controlled user-facing fallback, and regression coverage must prove the behavior.
- AC2: Private ESI token decrypt/auth failures (`Unsupported state or unable to authenticate data`, invalid token continuity, or equivalent auth-state failures) must not crash the entire Telegram request path. The runtime must degrade cleanly, preserve prompt secrecy rules, and leave actionable logs without exposing secrets to the model or user.
- AC3: Moon-like requests that depend on current location and/or static celestial counting must have a bounded, observable execution path. The investigation must include current production latency/proxy evidence for the freshly sent moon request and the fix must reduce avoidable slow-path behavior where the code can do so safely.
- AC4: The investigation must identify at least the adjacent code paths where the same failure classes can recur and either harden them in the same minimal change set or document the remaining risk precisely in repo-local artifacts/docs.
- AC5: Evidence must distinguish proxy/API behavior from app/runtime behavior on production, including concrete proofs from logs/manual reproductions and rerun checks against the fixed code.

## Constraints
- Keep all task artifacts inside `.agent/tasks/telegram-runtime-hardening/`.
- Preserve the single-process Node/Telegram long-polling architecture.
- Do not expose tokens, refresh flow internals, raw secrets, or decrypt material to the model.
- Prefer the smallest defensible diff set; avoid redesigning the proxy or auth system unless strictly required by the evidence.
- If runtime behavior changes, update the matching docs in `docs/`.

## Non-goals
- Replacing Codex proxy with a different transport/service.
- Rotating all production secrets or manually relinking every EVE account unless the evidence proves that is the only safe fix.
- Broad product redesign outside the runtime failure paths in scope.
- Solving every historical PM2 warning unrelated to proxy/tool-state, ESI auth, or slow moon-like requests.

## Verification plan
- Build: `npm run build`
- Unit tests: targeted runtime/auth/prompt/executor tests plus any new regression tests for hardened failure paths
- Integration tests: only if the fix crosses Telegram/auth seams materially
- Lint: `npm run lint`
- Manual checks:
  - inspect production PM2 logs for the fresh moon request and runtime failures
  - measure/observe `/responses` and request-path latency in production
  - rerun controlled server reproductions against the fixed code path
