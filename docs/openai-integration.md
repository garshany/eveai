# OpenAI Integration

This project uses the OpenAI Responses API for a tool-heavy EVE Online agent loop.

## Default Target

- Model: `gpt-5.6-sol`
- Provider: `openai` (default) or `cheapvibecode`
- Transport: OpenAI uses streamed HTTP `POST /v1/responses`; CheapVibeCode uses
  one-shot Responses WebSockets at
  `wss://cheapvibecode.ru/backend-api/codex/responses`
- Base URL: fixed by provider ID (`https://api.openai.com/v1` or
  `https://cheapvibecode.ru/backend-api/codex`)
- Reasoning effort: `auto` (local goal classifier, with `medium` for internal calls)
- Reasoning mode: `standard`
- Text verbosity: `low`
- State mode: `stateless`
- Storage: `store=false` by default; `OPENAI_STORE_RESPONSES=true` opts into
  OpenAI stored Response logs
- Response timeout: 90 seconds

These defaults follow the current [GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model): use the Responses API for reasoning and tools, select a family tier by workload, set reasoning and verbosity intentionally, keep stable prompt content first for caching, and preserve output-item fields when replaying tool state.

`OPENAI_PROVIDER` is an explicit allowlist, not a generic gateway URL. The
runtime, authenticated smoke, and aggregate smoke resolve the same fixed
endpoint. Unknown IDs fail at startup, and `OPENAI_BASE_URL` remains ignored so
an operator typo cannot redirect credentials or private chat/tool data.
CheapVibeCode has no HTTP fallback. Live probes showed that its Codex-shaped
HTTP/SSE routes stalled or disconnected, while the Codex WebSocket route
completed normal and parallel function-calling requests. WebSocket requests
omit `stream`, `background`, and the optional `truncation:"auto"` field. Local bounded context,
pre-turn compaction, and mid-turn compaction still enforce the context budget.
Its client `tool_search` descriptor must match the Codex wire shape exactly:
`type`, `execution`, `description`, and `parameters`; adding function-tool-only
fields such as `strict` caused the provider to hang instead of returning a
validation error. The WebSocket proxy may split one JSON event across several
application messages, so the client incrementally assembles bounded JSON while
respecting quoted strings and nesting before normal event reduction.
The provider profile also omits `reasoning.encrypted_content`: live probes
showed that requesting it changed the same EVE prompt from a function call to a
plain-text answer. CheapVibeCode stateless continuation therefore replays
function calls and outputs but filters reasoning items. The default OpenAI
profile keeps exact encrypted-reasoning replay unchanged.

## Model And Reasoning Choice

The self-hosting operator selects one process-wide model:

| Value | Role |
| --- | --- |
| `gpt-5.6-sol` | Default, strongest capability and quality-first work |
| `gpt-5.6-terra` | Strong capability with a lower-cost balance |
| `gpt-5.6-luna` | Efficient, latency-sensitive, high-volume work |
| `gpt-5.6` | Family alias that currently routes to Sol |

`OPENAI_REASONING_EFFORT=auto` is an EVE Agent policy, not an API value. It uses the existing goal classifier for top-level chat turns and resolves internal model calls to the balanced `medium` baseline. A fixed value (`none`, `low`, `medium`, `high`, `xhigh`, or `max`) overrides the classifier and reaches every normal chat turn unchanged.

`OPENAI_REASONING_MODE=pro` sends `reasoning.mode="pro"` on top-level agent turns. Pro uses the selected family model; there is no separate `gpt-5.6-pro` slug. It increases latency and token use, so evaluate it on representative difficult EVE tasks and raise `OPENAI_RESPONSES_TIMEOUT_MS` only when the measured workload needs more than 90 seconds. Internal summarization, OSINT, and advisor calls stay in standard mode.

`OPENAI_TEXT_VERBOSITY` accepts `low`, `medium`, or `high`. The developer prompt keeps task-specific chat requirements; this API control supplies the default amount of detail.

## Response State Modes

`OPENAI_RESPONSE_STATE_MODE=stateless` remains the default and immediate
rollback path. The app rebuilds visible history from SQLite and sends each prior
`function_call` with its matching `function_call_output`.

`OPENAI_RESPONSE_STATE_MODE=server` is an OpenAI-only explicit opt-in and requires
`OPENAI_STORE_RESPONSES=true`. A completed assistant Response id is stored in the
same SQLite transaction as the exact assistant-message id it represents. The id
is reused only when that assistant is still the latest assistant, exactly one
new user message follows it, and the anchor is no older than 55 minutes. Every
other case cold-starts from SQLite. Missing provider state also cold-replays the
exact active turn. CheapVibeCode uses one socket per response and therefore
requires `stateless`; startup rejects the server-state combination. Ordinary
transport failures retry the unchanged request on a new WebSocket and never
fall back to HTTP.

## CheapVibeCode client tool search and local parallel batch

CheapVibeCode advertises client-executed `tool_search`. Deferred tool schemas
remain in an immutable per-turn local index built from the exact inventory
already filtered for the current notification lane and configured integrations.
The first request carries only always-on tools plus a strict client-search
descriptor. A valid `tool_search_call` is answered with a linked
`tool_search_output` using the exact `call_id` and at most eight full trusted
specifications. Missing, duplicate, mixed, or over-budget search calls fail
closed. OpenAI retains its hosted tool-search path unchanged.

CheapVibeCode does not expose hosted Programmatic Tool Calling on the verified
route. EVE therefore never sends `programmatic_tool_calling` to that provider,
even if the hosted feature flag is set. Its local `local_parallel_batch` is a
declarative bounded substitute, not a JavaScript runtime: it accepts one to four
unique calls from the existing nine public-read facade names, validates the
entire batch and all arguments before egress, then runs them concurrently with
stable result ordering. Private ESI, raw SQL, web search, writes, UI operations,
monitors, recursion, dynamic code, `eval`, subprocesses, and result-directed
follow-up are not representable. Per-tool schemas and size caps still apply;
raw upstream failures are replaced by fixed local error contracts.

## Public multi-user load control

Every accepted chat turn is tied to the resolved internal `user_id` and chat
lane. Thread ownership, linked-character resolution, private ESI credentials,
the local tool-search index, function budgets, and continuation input remain
per turn; none is stored in a shared provider session. Telegram and Discord now
share the same actor guard, so one user cannot run overlapping turns by entering
through two platforms. The public web chat must call the same
`evaluateChatRequestAllowance`, in-flight registration, `runAgentTurn`, and
cleanup path rather than invoking the executor directly.

Provider sampling has a second, process-wide admission layer because internal
compaction/profile calls also consume model capacity. It admits a bounded number
of simultaneous HTTP/WebSocket Responses, queues excess work FIFO up to a fixed
ceiling, rejects a full queue, and removes timed-out waiters. A release is
idempotent and happens in `finally`, including transport failure. This protects
the event loop, provider connection count, and memory while the existing chat
guard keeps one active turn per user, a global active-turn ceiling, and a
sliding request window.

Leaf tools have their own process-wide admission boundary. Public reads use a
bounded shared pool (`16` active and `64` queued by default); write and UI tools
use one global permit, so state mutations from different users cannot overlap.
The `local_parallel_batch` container deliberately holds no permit while its one
to four children wait for read permits, avoiding semaphore deadlock. Its leaf
calls still count against the global read cap.

Defaults are deliberately conservative for one Node.js process and SQLite:

- `OPENAI_MAX_CONCURRENT_RESPONSES=8`
- `OPENAI_MAX_QUEUED_RESPONSES=32`
- `OPENAI_RESPONSE_QUEUE_TIMEOUT_MS=15000`
- `AGENT_MAX_CONCURRENT_READ_TOOLS=16`
- `AGENT_MAX_QUEUED_TOOLS=64`
- `AGENT_TOOL_QUEUE_TIMEOUT_MS=15000`
- `TELEGRAM_MAX_ACTIVE_REQUESTS_GLOBAL=8` (shared chat guard despite the
  legacy environment-variable prefix)

Tune these from measured provider latency, open sockets, event-loop delay,
SQLite busy time, memory, and upstream ESI limits. Do not raise the chat ceiling
without also considering that one accepted local batch can fan out to four
bounded public reads. The current single-process runtime lock and SQLite design
mean horizontal multi-instance serving is out of scope until coordination and
database architecture are changed explicitly.

GPT-5.6 `reasoning.context=all_turns` is intentionally not exposed. With `store=false`, correct persisted reasoning requires requesting `reasoning.encrypted_content`, preserving every response output item, and replaying those opaque items in order. The current SQLite history stores user-visible messages and tool audit data, not complete encrypted reasoning items. Sending `all_turns` without that storage path would silently overstate continuity.

Within one active tool loop, the default OpenAI profile requests
`reasoning.encrypted_content` and replays each opaque reasoning item in provider
output order with the corresponding function calls and outputs. These items are
never persisted in SQLite. The CheapVibeCode profile is the explicit exception:
it does not request encrypted reasoning and filters reasoning items while
replaying function calls and outputs. With the default
`OPENAI_STORE_RESPONSES=false`, the application does not create a stored
Response object for Dashboard Logs; with the OpenAI opt-in enabled, the request
and response are subject to OpenAI's applicable retention policy and may be
visible to the model operator. The OpenAI path preserves same-turn GPT-5.6
reasoning without claiming cross-turn `all_turns` continuity.

## Stored Response Logs

Set `OPENAI_STORE_RESPONSES=true` only when the self-hosting operator accepts
provider retention of the complete Responses exchange, which can include chat
context, generated programs, function-call arguments, and tool outputs replayed
on later iterations. Stored Responses can be inspected at
<https://platform.openai.com/logs?api=responses>. OpenAI documents a 30-day
[Responses application-state retention period](https://developers.openai.com/api/docs/guides/your-data#v1responses)
by default or with `store=true`; an organization or project with Zero Data
Retention treats `store=true` as `false`.

Storage and state continuation are separate controls: `store=true` makes logs
available but only `OPENAI_RESPONSE_STATE_MODE=server` reuses response ids.
SQLite remains the canonical durable conversation history. `previous_response_id`
reduces client replay payloads and simplifies normal tool continuations; it does
not remove prior-chain input from billing. Top-level instructions are still sent
on every request. Prompt caching may reduce repeated-prefix processing, but it is
not conversation memory and usage counters remain authoritative.

CheapVibeCode live cache probes confirmed prefix caching but not synchronous
cache population. A 9,625-input-token stable-prefix request initially reported
zero cached tokens; after the provider populated its cache, repeated requests
reported 8,960 cached tokens. The real three-round EVE tool-search smoke reached
4,864 cached tokens on its final round. Very short 29-token probes remained at
zero, and this provider reported `cache_write_tokens=0` even when later reads
were cached. Treat `cached_tokens` as the runtime billing/latency evidence;
do not infer a cache write from the absent counter. The app keeps its opaque
`prompt_cache_key` derived per user and never sends a raw user/chat/database ID.

## EVE-KILL MCP Analytics

Full agent turns do not serialize third-party hosted MCP descriptors. Those
turns may contain chat history, linked-character context, profile data, active
fits, and private ESI results. With a direct hosted MCP descriptor, a remote call
can execute before application code receives the model response, so response
validation cannot protect the outbound arguments.

Ordinary EVE-KILL access uses the local `eve_kill` REST function namespace.
`doctrine_detect`, `meta_pulse`, `killmail_forensics`, and `coalition_graph` use
a separate local `eve_kill_analytics` function namespace. The model produces a
strict local function call; application code accepts only public numeric IDs,
canonical date pairs, enums, booleans, and bounded limits, and only then sends a
fixed JSON-RPC `tools/call` request to EVE-KILL MCP. Aggregate-only mode exposes
neither namespace.

The OpenAI request never contains an EVE-KILL hosted MCP descriptor. Application
validation, not prompt policy or a remote allowlist, is the pre-egress privacy
boundary. Rejected analytics arguments are not persisted by value, and remote
error bodies are not exposed to the model or logs.

The streaming fallback follows the official `output_index` ordering and joins
`response.output_item.added` with the documented flat
`response.function_call_arguments.done` fields. Non-2xx provider bodies are
reduced at the transport boundary to HTTP status plus a fixed recovery category;
their raw text never enters an exception or bot log.

Recoverable errors carried in a response envelope are classified before the
generic non-completed-status failure and before any envelope output is processed.
Transient errors retry the same logical request within the existing bound, and
tool-state errors retain bounded cold recovery. Output from an error or otherwise
non-completed envelope is never registered, replayed, budgeted, audited, or
dispatched as a tool call. Unrecoverable envelopes return only the generic safe
model-service failure.

## Relevant Environment

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
OPENAI_RESPONSE_STATE_MODE=stateless
OPENAI_STORE_RESPONSES=false
OPENAI_PROGRAMMATIC_TOOL_CALLING=false
OPENAI_REASONING_EFFORT=auto
OPENAI_REASONING_MODE=standard
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSES_TIMEOUT_MS=90000
OPENAI_MAX_CONCURRENT_RESPONSES=8
OPENAI_MAX_QUEUED_RESPONSES=32
OPENAI_RESPONSE_QUEUE_TIMEOUT_MS=15000
AGENT_MAX_CONCURRENT_READ_TOOLS=16
AGENT_MAX_QUEUED_TOOLS=64
AGENT_TOOL_QUEUE_TIMEOUT_MS=15000
OPENAI_RESPONSE_LANGUAGE=Russian
OPENAI_MAX_OUTPUT_TOKENS=0
OPENAI_COMPACT_THRESHOLD=0
OPENAI_MODEL_CONTEXT_WINDOW=200000
```

## Compatibility Notes

- The request uses streaming and function tools.
- `prompt_cache_key` is forwarded when available.
- `phase` is preserved on replayed function-call output items instead of being stripped.
- Invalid response-state, reasoning-effort, reasoning-mode, verbosity, and timeout values fail fast at startup rather than becoming a delayed API 400.
- Usage telemetry records `cached_tokens`, `cache_write_tokens`, and reasoning tokens separately. GPT-5.6 implicit caching remains enabled; explicit cache breakpoints are not part of the baseline migration.
- When `AUTH_SECRET_KEY` is configured, top-level calls send a stable HMAC-derived `safety_identifier`. Raw Telegram, Discord, chat, and database user ids are not sent.
- `OPENAI_RESPONSE_LANGUAGE` is injected into the developer prompt as a dedicated response-language instruction. Use values like `ru`, `русский`, `en`, `English`, or a custom language name.
- The model must not see tokens, refresh flow internals, pagination internals, retries, or secrets; those stay in backend code.

`OPENAI_MODEL_CONTEXT_WINDOW=200000` is a conservative local compaction budget, not a claim about the selected model's advertised context window. The runtime compacts at 90% of this value and keeps it configurable because maximum input, reserved output, latency, and cost all matter.

## Validation

Run:

```bash
npm run check
npm run smoke
npm run smoke:openai
npm run smoke:eve-tool
```

`npm run check` validates type safety, unit/integration tests, linting, and Responses payload regressions. `npm run smoke` checks required environment variables, the model `/responses` endpoint, and app health.

The authenticated smoke script sends a minimal request through the selected provider transport: HTTP/SSE for OpenAI or the fixed Codex Responses WebSocket route for CheapVibeCode. It prints only sanitized response metadata.

`npm run smoke:eve-tool` runs the real agent loop on a copied SQLite database and requires the model to call an EVE SDE tool before returning a final answer. Use `EVE_TOOL_SMOKE_MODE=direct` to validate only the DB-backed tool path without a model call.

## Default-off Programmatic Tool Calling expansion

`OPENAI_PROGRAMMATIC_TOOL_CALLING=false` is the supported baseline and rollback switch. The value is parsed strictly as `true` or `false` (case-insensitive). When enabled, EVE adds one hosted `{type:"programmatic_tool_calling"}` descriptor. The selected OpenAI model, project, and organization must be entitled to the feature; an enabled provider rejection is surfaced through the normal sanitized error boundary and is never retried with the feature silently removed.

The exact programmatic allowlist has nine names:

1. `count_universe_objects`
2. `batch_market_prices`
3. `compare_wormhole_types`
4. `scout_systems`
5. `kill_activity_summary`
6. `market_history_summary`
7. `system_metric_snapshot`
8. `doctrine_summary`
9. `dynamic_item_summary`

All nine remain directly callable. Each advertises
`allowed_callers:["direct","programmatic"]` and a fixed `output_schema` only
while the feature is enabled; nested Scout tools retain that decoration after
tool search. Eligibility is by exact function name, not namespace, source,
read-only classification, prefix, or input shape. EVE validates caller linkage,
inputs, work units, family coherence, and serialized outputs again before
dispatch or external egress. Provider schemas and prompt text are
interoperability aids, not authorization.

The OpenAI function-input schema sent on the wire intentionally omits
`uniqueItems` for arrays such as market type IDs, wormhole identifiers, system
IDs, and dynamic-item attribute IDs because the current Responses API rejects
that keyword in function parameters. EVE still rejects duplicates strictly in
application validation before any CCP ESI, EVE-Scout, or EVE-KILL egress; the
constraint is not weakened or silently normalized.

One program can use only one exact tool name and one bounded comparison shape:

- exactly two independent static counts;
- the same ordered one-to-ten type IDs over two-to-four market regions;
- one facade call comparing two-to-eight wormhole identifiers;
- two-to-four distinct Scout system searches with at most ten rows each;
- two-to-four explicit public kill summaries over distinct targets or
  non-overlapping windows of at most seven days and at most five evidence IDs;
- two-to-four distinct market-history `(region_id,type_id)` pairs using the
  same 30-day or 90-day window;
- two-to-four distinct system metrics over the exact same ordered one-to-100
  system IDs;
- two-to-four distinct corporation/alliance doctrine targets using the exact
  same explicit window and `top<=5`; or
- two-to-four distinct dynamic `(type_id,item_id)` pairs using the exact same
  ordered one-to-ten requested attribute IDs.

Names and numeric IDs are resolved directly before the program starts. A
single lookup stays direct. Programs cannot retry, loop, discover IDs, call a
raw backing operation, or mix families.

The four added direct facades are deliberately narrower than their backing
operations:

- `market_history_summary` accepts one positive region/type pair and `days` of
  30 or 90, then returns aggregate price, volume, volatility, and liquidity
  evidence without daily rows;
- `system_metric_snapshot` accepts one of `kills`, `jumps`, `industry`, or
  `sovereignty` plus one-to-100 unique ordered system IDs, then returns exactly
  one compact typed row per requested ID;
- `doctrine_summary` accepts one public corporation/alliance ID, an explicit
  canonical window of at most 366 days, and `top` from one to ten, then returns
  validated non-authoritative loss-fit inference without raw analytics; and
- `dynamic_item_summary` accepts one exact type/item pair and one-to-20 unique
  ordered attribute IDs, then returns only those numeric values plus optional
  local-SDE base/delta evidence.

OpenAI's hosted runtime executes generated programs. EVE never evaluates generated JavaScript and executes only returned client-owned function calls. On the OpenAI profile, every provider output item (including opaque reasoning, `program`, `program_output`, fingerprints, messages, and callers) is retained in memory for the active turn and replayed in exact provider order, followed by local function outputs in call order. The CheapVibeCode profile filters reasoning items as described above; its local compatibility profile keeps Programmatic Tool Calling disabled. EVE does not persist program code, fingerprints, encrypted reasoning, or replay payloads in SQLite. When `OPENAI_STORE_RESPONSES=true`, OpenAI may retain those request and response items in its stored Response logs. Mid-turn SQLite compaction is skipped while a program is active because it cannot reconstruct this chain.

The application permits at most four programmatic calls per response batch,
user turn, and program ID. Family work ceilings are 40 region/type pairs for
`batch_market_prices`, 400 examined observations for
`kill_activity_summary`, 360 requested history-days for
`market_history_summary`, 400 requested system rows for
`system_metric_snapshot`, 20 requested doctrine rows for `doctrine_summary`,
and 40 requested dynamic attributes for `dynamic_item_summary`. Duplicate
targets, mismatched ordered ID/attribute sets, mixed history windows, doctrine
windows/tops, repeated metrics, overlapping kill-summary windows, mixed tool
names, malformed calls, and over-budget batches are rejected atomically before
any call in that programmatic batch dispatches. Every eligible result is
schema-validated and serialized as at most 12,000 characters; invalid,
non-finite, drifted, unserializable, or oversized data becomes a schema-valid
fixed error rather than a sliced preview. The existing 16 model-iteration
ceiling remains.

A provider final message is accepted only after every program with accepted
calls has reached its declared minimum shape: two calls for every family except
the one-call bounded wormhole comparison; static count is exactly two. This
remains true even if a later duplicate, incoherent, invalid, or over-budget
batch for that program is rejected. Only a fully rejected program with zero
accepted calls may report its structured rejection without a minimum-shape
obligation. Hosted verification requires an explicit final-assistant event and
recomputes schema validity from each emitted local output. Negative wire
scenarios require a structured rejection with no `tool_start` or dispatch.

All programmatic tools are public reads. Market price/history, system metrics,
and dynamic dogma use unauthenticated CCP ESI; dynamic-item base comparisons may
also read the installed local SDE. Scout results carry third-party provenance
and a fixed 86,400-second cache ceiling. Kill summaries carry third-party
provenance, a 90-second search-cache ceiling, compact aggregates and bounded
evidence IDs only. `doctrine_summary` calls only the fixed local
`doctrine_detect` wrapper, is non-authoritative, and projects at most five
validated rows without URLs, module lists, raw clusters, or transport data.
Dynamic-item output excludes creator identity, effects, and unrequested
attributes; system snapshots exclude the full bulk response; market history
excludes raw daily rows. Programs cannot reach private ESI/capabilities,
`sde_sql`, web/search/browser, routes, raw ESI backing operations, raw kill
arrays/detail, generic EVE-KILL analytics, writes, UI, notes, fits, watches,
monitors, heartbeat, notifications, or any unlisted tool.

Routine audit records and console output for the four new bounded facades
contain only the fixed `bounded-public-read` or `programmatic-bounded`
classification, not argument names, values, or IDs. Programmatic result audit stores only
success/blocked/schema status and output length. Generated program text, caller
IDs, raw arguments, full upstream responses, and credentials are neither
persisted nor logged.

Verification is split by boundary. The public-source matrix calls the bounded
public facades through production executors with the feature disabled. The
hosted matrix covers all nine eligible families plus disallowed, mixed-family,
and over-budget rejection scenarios. Both print sanitized metrics only:
scenario status/category, elapsed time, iteration/token counts when available,
facade names, accepted/rejected counts, work units, output character counts,
final-answer length, and schema status. They never print prompts, arguments,
IDs, names, market/dogma/doctrine/system values, kill evidence, programs/caller
IDs, response bodies, answers, endpoints, or credentials.

```bash
npm run smoke:eve-tool -- --public-source-matrix
OPENAI_PROGRAMMATIC_TOOL_CALLING=true npm run smoke:eve-tool -- --programmatic-matrix
```

Dynamic-item scenarios additionally require `EVE_TOOL_SMOKE_DYNAMIC_SAMPLES`
to contain a local JSON array of two currently valid public samples, each with
positive `type_id`, `item_id`, and the same ordered one-to-ten
`attribute_ids`. Sample IDs remain local operator input and are never printed
or committed. Missing or malformed samples produce an explicit failing
`NOT_RUN` record instead of silently skipping the scenario.

The hosted run requires an existing `OPENAI_API_KEY` and feature entitlement
for the configured model/project. A missing credential, provider entitlement,
or public source is `NOT_RUN`/failure evidence, never a passing substitute.
Rollback is still only `OPENAI_PROGRAMMATIC_TOOL_CALLING=false` plus process
restart: the hosted descriptor and programmatic-only decoration disappear, all
nine tools remain directly callable, and no migration, cache deletion, replay
recovery, provider cleanup, remote revocation, or data repair is needed.
