# Docs Index

Status: active
Verified against code: 2026-07-13

This directory is the repository knowledge system of record.

Read the smallest document that answers the current question. Start here, then descend into the next linked document instead of loading the whole tree at once.

## Stable Entry Points

- [../AGENTS.md](../AGENTS.md): shortest repo map plus hard invariants
- [../ARCHITECTURE.md](../ARCHITECTURE.md): system context, runtime boundaries, state model, request flows
- [repo-map.md](./repo-map.md): fast file-and-domain map for the codebase

## Top-Level Docs

- [DESIGN.md](./DESIGN.md): documentation and repo-structure design rules
- [PRODUCT_SENSE.md](./PRODUCT_SENSE.md): product shape, primary user jobs, deliberate non-goals
- [PLANS.md](./PLANS.md): how execution plans and tech debt are stored in-repo
- [QUALITY_SCORE.md](./QUALITY_SCORE.md): scored view of domain quality and major gaps
- [RELIABILITY.md](./RELIABILITY.md): runtime failure model and operational checks
- [SECURITY.md](./SECURITY.md): auth, secret, and web protection rules
- [deployment.md](./deployment.md): generic self-host deployment guide
- [legal.md](./legal.md): CCP legal notices, Developer License Agreement, and Community Showcase readiness
- [open-source-release.md](./open-source-release.md): clean public release and history-safety checklist
- [community-showcase.md](./community-showcase.md): CCP Community Showcase submission bundle and eligibility gate
- [heartbeat.md](./heartbeat.md): periodic background checks and notifications system
- [osint.md](./osint.md): probabilistic residence/staging inference from activity graphs
- [eve-kill.md](./eve-kill.md): current EVE-KILL REST/feed, locally wrapped MCP analytics, source ownership, and route handoff
- [openai-integration.md](./openai-integration.md): stateless Responses loop and local function/MCP privacy boundary

## Indexed Subtrees

- [design-docs/index.md](./design-docs/index.md): slower-changing architectural beliefs and domain boundaries
- [product-specs/index.md](./product-specs/index.md): product-surface contracts for Telegram, web, and identity flows
- [exec-plans/active/index.md](./exec-plans/active/index.md): current substantial work
- [exec-plans/completed/index.md](./exec-plans/completed/index.md): completed execution plans
- [exec-plans/tech-debt-tracker.md](./exec-plans/tech-debt-tracker.md): cross-cutting debt not tied to one task

## Generated And Reference Artifacts

- [generated/db-schema.md](./generated/db-schema.md): schema inventory derived from the SQLite source of truth
- [references/eve-platform-reference-llms.txt](./references/eve-platform-reference-llms.txt): EVE platform source links
- [references/openai-codex-reference-llms.txt](./references/openai-codex-reference-llms.txt): OpenAI/Codex reference links
- [references/telegram-reference-llms.txt](./references/telegram-reference-llms.txt): Telegram reference links

## Reading Order By Question

- "How is the app split up?" -> [../ARCHITECTURE.md](../ARCHITECTURE.md)
- "Where is the code for X?" -> [repo-map.md](./repo-map.md)
- "What is the product supposed to do?" -> [PRODUCT_SENSE.md](./PRODUCT_SENSE.md)
- "What are the hard safety or transport rules?" -> [SECURITY.md](./SECURITY.md), [RELIABILITY.md](./RELIABILITY.md)
- "How should new work be planned and recorded?" -> [PLANS.md](./PLANS.md), [exec-plans/active/index.md](./exec-plans/active/index.md)
- "How do background notifications work?" -> [heartbeat.md](./heartbeat.md)
