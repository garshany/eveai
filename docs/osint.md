# OSINT Inference

Status: active
Verified against code: 2026-04-02

This document describes the internal OSINT residence/staging inference flow.

## Purpose

The agent now exposes a top-level `osint_infer_home` tool for questions like:

- where a character likely lives
- where a corporation or alliance stages
- whether activity looks like home defense, staging, or a hunting pipe
- which core members repeatedly anchor the same cluster

The tool returns probabilistic hypotheses, not proof of literal residence.

## Sources

- zKillboard entity-scoped kills/losses feeds: primary scoped activity evidence
- public ESI killmail lookup by `killmail_id + hash`: system/time/participant enrichment for zKill rows
- EVE-KILL entity members: optional corp/alliance member enrichment
- local SDE SQLite: system names, regions, security, stargate adjacency
- internal LLM pass: optional interpretation of a compact graph digest

No external HTTP API was added for Telegram/LLM flow. The feature runs inside the existing tool executor path.

## Tool Contract

`osint_infer_home`

Arguments:

- `scope`: `character | corporation | alliance`
- `id`: target entity ID
- `window_days`: lookback window, default 30
- `include_member_analysis`: sample corp/alliance members for overlap patterns
- `include_graph`: include compact graph digest
- `include_llm_pattern_analysis`: run an extra LLM pass on the graph digest

Returns:

- `hypotheses`: top candidate systems with `kind`, `confidence`, `reasons`
- `activity_cluster`: primary cluster around the top anchor system
- `member_analysis`: compact core-member summary
- `graph_digest`: top systems, clusters, and graph-level signals
- `llm_pattern_analysis`: optional pattern labels / summary / alternatives / uncertainty
- `uncertainty`: deterministic caveats and ambiguity flags

## Inference Model

The current MVP is hybrid:

1. deterministic scoring in code
2. optional LLM interpretation on top of the compact digest

Deterministic inputs include:

- kills vs losses in a system
- repeat activity across unique days
- repeated member overlap
- adjacency support from nearby systems
- filtered ISK value concentration
- timezone and security-band labels from zKill
- trade-hub / chokepoint penalty
- single-day spike downweighting

Noise filtering:

- NPC rows are excluded
- awox rows are excluded
- incomplete zKill rows without usable location/time are skipped
- low-value single-day spikes in hubs are heavily downweighted
- direct zKill scoped feeds are capped by upstream to 7 days, and the tool reports that cap in `uncertainty`

The LLM never sees raw transport internals or token state. It receives only a compact digest.

## Prompt Policy

The developer prompt now instructs the model to prefer `osint_infer_home` for residence/staging questions instead of manually inferring from raw kill feeds.

## Known Limits

- killboard activity is a proxy for residence, not direct proof
- hubs and chokepoints can create false positives
- roaming and split-theater groups can remain ambiguous
- direct zKill `pastSeconds` is limited to 7 days, so wider user windows are narrowed to the upstream limit
- zKill entity feeds still need enrichment, so some rows can drop when public ESI killmail lookup is incomplete
- member analysis is intentionally capped for cost and latency
