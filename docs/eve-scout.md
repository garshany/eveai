# EVE-Scout Integration

Status: active
Verified against code: 2026-07-14

The local `eve_scout` namespace reads the fixed public EVE-Scout API through
`src/eve/eve-scout-client.ts`. Results are third-party observations and may be
stale or incomplete. Routes, signatures, observations, broad wormhole-type
filters, and system search remain deferred tools; the model never receives
transport URLs, headers, response bodies, retries, or cache internals.

## Bounded comparison tools

`compare_wormhole_types` accepts exactly two-to-eight unique identifiers after
trim/uppercase normalization (`C140`, `A239`, and similar). It performs one
cached public encyclopedia read and returns one fixed row per input, in input
order. Missing types are explicit `found:false` rows with null scalars. Free-form
comments and signature data are excluded. The broader
`scout_wormhole_types` tool remains direct-only.

`scout_systems` accepts a 1-64 character query, one optional exact class
(`hs`, `ls`, `ns`, `c1`-`c6`, `c12`, or `c13`), and a strict 1-25 result limit.
EVE-Scout's live API accepts `query=` plus only coarse `k-space|j-space`; the
client maps our class to the coarse filter, fetches at most 250 candidates,
then filters the exact class locally before applying the requested limit. It
does not clamp or coerce invalid input.

Both outputs include `source:"EVE-Scout"`, `authoritative:false`, an explicit
limitation, retrieval time, known cache/upstream observation time when
available, and the fixed 86,400-second cache ceiling. Success and error objects
are validated against closed schemas and remain below 12,000 serialized
characters.

With default-off Programmatic Tool Calling enabled, the bounded wormhole facade
may be used once per program, while system comparison permits two-to-four
distinct searches with at most ten returned rows each. Programs cannot invoke
routes, signatures, observations, or broad wormhole filters. See
[openai-integration.md](./openai-integration.md) for the exact allowlist and
budgets.

Run the real public-source verification without enabling hosted programs:

```bash
npm run smoke:eve-tool -- --public-source-matrix
```

The runner prints sanitized metrics only and never prints the queried systems,
wormhole identifiers, returned rows, or source payloads.
