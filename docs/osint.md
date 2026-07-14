# OSINT Inference

Status: active
Verified against code: 2026-07-13

`osint_infer_home` estimates where a public character, corporation, or alliance
may live, stage, or hunt. Its output is probabilistic killboard inference, not
proof of residence and not an official roster.

## Source Boundary

- EVE-KILL `POST /killmails/search` supplies public kill observations for an
  explicit requested window.
- Official public ESI resolves entity and observed-character names.
- The installed local SDE snapshot resolves systems, regions, security bands,
  ship types, and stargate adjacency.
- An optional internal model pass interprets only a compact graph digest.

The search client splits long history into non-overlapping windows of at most
seven days, follows cursors, deduplicates killmail IDs, and returns explicit
request-count/truncation metadata. OSINT derives whether the target appeared as
attacker, victim, or both from the normalized participants; it does not depend
on source-specific labels.

## Tool Contract

Arguments:

- `scope`: `character | corporation | alliance`
- `id`: target entity ID
- `window_days`: requested lookback, default 30
- `include_member_analysis`: analyze repeatedly observed participants
- `include_graph`: include the compact graph digest
- `include_llm_pattern_analysis`: run the optional model interpretation

Important result sections:

- `hypotheses`: candidate home/staging/hunting systems with confidence/reasons
- `activity_cluster`: the primary connected activity cluster
- `member_analysis`: killmail-observed participants only
- `graph_digest`: bounded systems, clusters, members, and signals
- `llm_pattern_analysis`: optional interpretation and alternatives
- `uncertainty`: source errors, caps, truncation, ambiguity, and proxy limits

`member_analysis` always includes `authoritative: false`, source
`EVE-KILL`, basis `observed_killboard_activity`, the searched windows, request
count, truncation, and coverage caveats. It must never be described as a
corporation or alliance member list from CCP.

## Inference Model

The deterministic stage scores:

- target kills versus losses by system;
- repeat activity across distinct days and UTC activity windows;
- repeated observed-character overlap;
- adjacency support from local SDE topology;
- filtered ISK concentration;
- local-SDE security bands;
- hub/chokepoint penalties and single-day spike downweighting.

Noise handling excludes known NPC rows, skips records without usable
time/location, and downweights low-value one-day hub spikes. Observations where
the target entity appears on both sides remain explicit attacker+victim
evidence instead of being guessed away as awox noise. Unknown or incomplete
fields remain uncertainty; they are not silently converted into negative
evidence.

The optional model receives only the compact digest. It never receives tokens,
private ESI payloads, pagination/retry state, or raw transport responses.

## Known Limits

- Public kill activity is a proxy for residence, not direct proof.
- Hubs, chokepoints, deployments, roaming, and split theaters can mislead the
  scoring model.
- The local result cap is 500 normalized killmails; reaching it is reported as
  truncation.
- A source failure can produce no hypotheses, but remains visible in coverage
  and uncertainty.
- Observed-member analysis is intentionally bounded for latency and context.
