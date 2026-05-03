# GPT-5.5 Migration

## Objective

Migrate the project model and directly related prompt/runtime documentation to `gpt-5.5` using the OpenAI Docs skill, then verify, commit, push, deploy to production, and confirm the deployed service uses the new model.

## Acceptance Criteria

- AC1: Official OpenAI documentation is consulted for the GPT-5.5 target slug and migration guidance.
- AC2: Active OpenAI model defaults use `gpt-5.5` in runtime configuration and env examples.
- AC3: Current project documentation that describes the active OpenAI model or prompt/runtime compatibility no longer presents GPT-5.4 as the current default.
- AC4: Prompt/runtime compatibility is reviewed against GPT-5.5 guidance, including reasoning effort, Responses API usage, tool-heavy flows, and continuation handling.
- AC5: Existing tests/checks relevant to the migration pass locally.
- AC6: The migration is committed and pushed to the remote repository.
- AC7: Production at `158.160.220.215:/opt/eveai` is deployed from the committed version and the running service is verified.

## Constraints

- Keep the migration narrow: model slug and directly related prompt/runtime docs only.
- Preserve current reasoning effort unless validation shows a reason to change it.
- Do not rewrite API surface, tool schemas, provider wiring, auth, or business logic as part of this migration.
- Do not revert unrelated local changes already present in the worktree.
