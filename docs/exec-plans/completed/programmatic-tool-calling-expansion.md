# Programmatic Tool Calling expansion

Status: completed and independently verified
Task proof: `.agent/tasks/programmatic-tool-expansion/`

Expanded the default-off OpenAI hosted-program boundary from the static count
canary to exactly five bounded public-read tools. The frozen acceptance contract
and verified provider-compatibility amendment are in
`.agent/tasks/programmatic-tool-expansion/spec.md` (AC1-AC14).

Delivered:

- strict shared output schemas, safe serialization, exact allowlist, recursive
  namespace decoration, caller/program/work-unit and terminal-shape accounting;
- fixed public market output and unauthenticated ESI access;
- bounded EVE-Scout wormhole comparison and corrected system search;
- compact EVE-KILL activity summary without raw killmail data;
- hermetic tests, real public-source probes, exact OpenAI wire-schema probes,
  five hosted positive scenarios, a production-loop negative dispatch gate,
  documentation, fresh verifier, and independent read-only review.

Verification completed with 76 test files / 511 tests, strict TypeScript,
zero-warning ESLint, four real public-source probes, five production-shaped wire
schemas, five hosted programs, and one hosted disallowed-call rejection. All
AC1-AC14 are `PASS` in the task verdict.

Production enablement and deployment remain explicitly out of scope. Rollback
is the existing feature flag plus process restart and requires no migration.
