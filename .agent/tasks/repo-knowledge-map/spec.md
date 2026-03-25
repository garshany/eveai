# Task Spec: repo-knowledge-map

## Metadata
- Task ID: repo-knowledge-map
- Created: 2026-03-25T00:39:07+00:00
- Repo root: /home/antipedik/eveai
- Working directory at init: /home/antipedik/eveai

## Guidance sources
- AGENTS.md
- ARCHITECTURE.md
- docs/DESIGN.md
- docs/PRODUCT_SENSE.md
- docs/FRONTEND.md
- docs/PLANS.md
- docs/QUALITY_SCORE.md
- docs/RELIABILITY.md
- docs/SECURITY.md
- docs/design-docs/index.md
- docs/product-specs/index.md
- docs/generated/db-schema.md
- docs/exec-plans/active/index.md
- docs/exec-plans/completed/index.md
- docs/exec-plans/tech-debt-tracker.md
- docs/deployment.md
- OpenAI article: https://openai.com/ru-RU/index/harness-engineering/

## Original task statement
Изучи https://openai.com/ru-RU/index/harness-engineering/ и перестрой repo knowledge как system of record: короткий AGENTS.md как карта, подробные docs/*, карта файлов и описания репозитория

## Acceptance criteria
- AC1: Root `AGENTS.md` is a short navigation map, not a long-form manual; it clearly points agents to the deeper repo sources of truth and stays scoped to durable routing/invariant guidance rather than duplicating the full repository knowledge base.
- AC2: `docs/` is the canonical knowledge store for the repository, with indexed and discoverable entries for architecture, product sense, design, reliability, security, deployment, generated schema, design docs, product specs, and exec plans.
- AC3: The repository has an explicit file-and-domain map that lets an agent quickly find the major code areas, supporting docs, and operational surfaces without reading unrelated files first.
- AC4: The documentation structure reflects progressive disclosure from the OpenAI article: stable entrypoint first, then indexed deep links, then domain-specific docs and versioned plans/tech-debt artifacts.
- AC5: Any ambiguity about `agent.md` is resolved consistently in the repo and spec: the existing `AGENTS.md` remains the root map, and no separate `agent.md` file is introduced unless a concrete repo need is proven.

## Constraints
- Preserve the existing single-process Node.js architecture and runtime behavior.
- Do not introduce new external state stores, queues, workers, or webhooks.
- Keep the repository knowledge local, versioned, and readable by agents from within the repo.
- Prefer short navigation files and deep-link indexes over one large monolithic guide.
- Do not change product behavior unless a documentation or map update requires it.
- Treat the OpenAI article as a design reference for repo knowledge structure, not as a mandate to mirror unrelated tooling.

## Non-goals
- Rewriting the app architecture or production runtime.
- Renaming `AGENTS.md` to a different root map filename.
- Creating a new `agent.md` file unless a concrete gap is demonstrated during implementation.
- Replacing the existing docs hierarchy with a different taxonomy.
- Adding unrelated product features, tests, or infra changes.

## Verification plan
- Build: run the standard build/typecheck path if any file wiring or link changes require validation.
- Unit tests: run docs or repo-map regression checks if present.
- Integration tests: run only if documentation wiring or runtime map assumptions touch integration coverage.
- Lint: run the repository lint check.
- Manual checks: inspect `AGENTS.md`, `ARCHITECTURE.md`, `docs/*`, and the file map to confirm the repository now reads as a layered knowledge system with progressive disclosure.

## Assumptions
- `AGENTS.md` is the intended root map for this repository and should remain the primary entrypoint.
- The task is mainly a documentation-and-navigation refactor, not a production code change.
- The OpenAI article's core lesson for this repo is repository-local knowledge management: short map, rich indexed docs, versioned plans, and mechanical discoverability.
