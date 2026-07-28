# Perimeter — live threat map with a proactive agent chat

Status: active

## Goal

One live screen that answers "where am I, what is around me, where do I go
next" while the pilot is flying, with an assistant that speaks first.

Perimeter is a full-screen section in the browser workspace:

- an ego-centric graph of New Eden centred on the pilot's live ESI position,
  covering every system within a configurable jump radius (default 5, hard
  maximum 10),
- live kill activity, explainable danger scoring, gate-camp attribution,
  wormhole shortcuts, and risk-weighted routing,
- and a **real chat thread docked beside the map into which the agent posts on
  its own initiative** — not a notification rail, a conversation.

## Naming

Feature and screen: **«Периметр» / Perimeter**. The assistant keeps the existing
workspace identity; Perimeter is where it gets eyes.

---

## 1. API validation

Re-verified on 2026-07-28 against the operator's own catalog and the live
services. This section is the contract the rest of the plan is built on.

### 1.1 ESI — verified against `data/cache/esi-swagger.json` (ESI 1.36, 75 paths)

| Endpoint | Cache | Scope | Use |
| --- | --- | --- | --- |
| `GET /characters/{id}/location/` | **5 s** | `esi-location.read_location.v1` | pilot position; 5 s is the hard floor on liveness and is exactly the poll interval |
| `GET /characters/{id}/ship/` | 5 s | `esi-location.read_ship_type.v1` | current hull, feeds the capability-gap term |
| `GET /characters/{id}/online/` | 60 s | `esi-location.read_online.v1` | stops the poller when the pilot logs off |
| `GET /universe/system_kills/` | **3600 s** | public | hourly baseline layer only |
| `GET /universe/system_jumps/` | 3600 s | public | traffic baseline |
| `GET /sovereignty/map/` | 3600 s | public | sov owner layer |
| `GET /route/{origin}/{destination}/` | 86400 s | public | cross-check only; our own Dijkstra is authoritative |
| `POST /ui/autopilot/waypoint/` | — | `esi-ui.write_waypoint.v1` | push the chosen route into the game client |
| `GET /universe/systems/{id}/` | — | public | coordinate backfill of last resort |
| `GET /status/` | 30 s | public | TQ up/down badge |

**Findings that change the plan:**

- **`/incursions/` does not exist in this catalog.** The Sansha incursion layer
  is removed from scope. It cannot be built from ESI as deployed here.
- **No faction-warfare endpoints exist** (`/fw/systems/`, `/fw/stats/` are
  absent; only `/universe/factions/` remains). The FW-contested layer is
  removed from scope.
- **No `/dogma/` endpoints.** Ship capability (EHP, align, warp speed,
  signature) comes from the **local SDE** `sde_type_dogma` + `sde_dogma_attributes`,
  which the repo already reads in `eve-board/threat.ts assessShip`. No change
  needed, but the plan must not promise an ESI dogma path.
- Confirmed there is **no endpoint for pilot presence in a system**. See §6.

### 1.2 EVE-KILL — verified live

- `GET https://api.eve-kill.com/feed/poll?after=<cursor>&limit=<n>` → HTTP 200,
  body `{ data: [...], latest: <int>, hasMore: bool, next, last }`. Confirmed
  live during this validation (`latest: 2386994`). This is the exact endpoint
  `src/eve-kill/client.ts fetchFeedPage` already calls, polled once per second
  by `feed-poll.ts`. **The live layer is built on this, not on ESI.**
- `https://eve-kill.com/_openapi.json` returns **404** — the published OpenAPI
  link is dead. The repo's hand-written client and normalizer stay the source of
  truth for payload shape; schema drift is caught by the existing normalizer
  tests, not by a spec fetch.
- A STOMP websocket (`wss://stomp.eve-kill.com/ws`) is advertised for live
  killmails. **Not adopted.** It would add a dependency (`@stomp/stompjs`), a
  second long-lived connection to supervise and reconnect, and a second failure
  mode — to replace a 1-second REST poll that already runs, already has cursor
  resume across restarts, and is already tested. Latency gain is under a second
  against a source whose own publish delay is seconds to minutes. Recorded as a
  future option in the tech-debt tracker, not built now.
- History backfill uses the existing `searchKillmails` (15-ID chunking and
  cursor pagination already implemented).

### 1.3 EVE-Scout — verified live

`GET https://api.eve-scout.com/v2/public/signatures` → HTTP 200. Records carry
`out_system_id`, `in_system_id`, `wh_type`, `max_ship_size`, `expires_at`,
`remaining_hours`, `signature_type`. Already wrapped by
`src/eve/eve-scout-client.ts` with its own timeout, retry, and 300 s cache.
These become extra traversable edges on the map and in the router, filtered by
`max_ship_size` against the pilot's hull and dropped when `expires_at` passed.

### 1.4 Local SDE — the map's skeleton

`solarSystems` records expose `position` `{x,y,z}` **and** `position2D`
`{x,y}`, plus `securityStatus`, `securityClass`, `constellationID`,
`stargateIDs`, `wormholeClassID` (verified against the published SDE schema).
The repo already loads these into `sde_systems.data_json` and `sde_stargates`.

Residual risk: this is verified against the SDE *schema*, not against the
operator's loaded database, which is not present in this worktree.
`scripts/verify-map-geometry.ts` is therefore step one of implementation, and
the builder refuses to write a partial or coordinate-less graph.

### 1.5 Summary of source responsibilities

| Layer | Source | Freshness |
| --- | --- | --- |
| Systems, coordinates, security, regions, gate graph | local SDE | static |
| Ship capability (EHP, align, warp) | local SDE dogma | static |
| Pilot position / hull / online | ESI | 5 s / 5 s / 60 s |
| **Live kills** | **EVE-KILL feed poll** | **seconds** |
| Kill history backfill | EVE-KILL search | on demand |
| Kill/jump baseline, sovereignty | ESI | 1 hour |
| Wormhole shortcuts | EVE-Scout | ~5 min |
| Repeat-attacker memory | `route_ganker_cache` | rolling |

No new external provider. Removed from scope by validation: incursions,
faction-warfare contest.

---

## 2. Rendering library decision

The question was whether to use D3 or a graph library. The answer follows from
what the layout actually is.

**Perimeter's layout is deterministic, not force-directed.** Ring index *is*
jump distance; angle comes from real SDE 2D coordinates. A force simulation
would destroy exactly the property that makes this map better than Dotlan, and
a jittering, settling scene is wrong for something you navigate by. So
`d3-force`, and the force-first libraries built around it, solve a problem
Perimeter does not have.

| Option | Verdict |
| --- | --- |
| **Sigma.js** (WebGL) | Rejected. Built for 5k–50k node force graphs; owns the scene; custom visuals (rings, kill flashes, route ribbon, follow camera) need GLSL. Our worst case is ~1200 nodes. |
| **Cytoscape.js** | Rejected. Heavy, its own style DSL, layout runs synchronously on the main thread, and it wants to own interaction. |
| **vis-network** | Rejected. Same ownership problem, weaker control over camera. |
| **d3-force** | Rejected. Wrong layout model, see above. |
| **Custom Canvas 2D + small d3 utility modules** | **Chosen.** |

**Chosen stack:** a hand-written Canvas 2D renderer plus four tiny, tree-shaken,
dependency-free d3 modules that solve genuinely fiddly problems and nothing else:

- `d3-zoom` (with its `d3-selection` peer) — pan/zoom/inertia and the transform
  matrix, applied manually to the canvas. Hand-rolling correct multi-touch and
  wheel-normalised zoom is where this kind of UI usually breaks.
- `d3-quadtree` — hit testing for click and hover at 1200 nodes.
- `d3-scale` — danger→colour and value→radius ramps.
- `d3-interpolate` — the ego↔geographic layout morph and camera easing.

Combined they are a small fraction of a full graph library and add no runtime
services, no workers, and no second render loop. `AGENTS.md` forbids queues,
Redis, and Postgres; it does not forbid libraries, but every added package is
justified above individually.

Performance budget: the 10-jump cap is 1200 nodes and roughly 2000 edges. Canvas
2D draws that in ~2–3 ms per frame with batched edge paths, leaving the 60 fps
budget almost untouched. The whole-New-Eden geographic view (~8000 systems,
~14000 links) is drawn with level-of-detail — labels above a zoom threshold
only, edges batched into one path — and stays within budget. WebGL is not
needed, and reaching for it would cost custom visuals we actually want.

Fallback if measurement disagrees: swap the node/edge draw calls for a WebGL
point/line pass behind the same renderer interface. The layout, camera, and
interaction code do not change.

---

## 3. The agent chat — the part that was missing

Perimeter's assistant is a **chat thread**, docked to the right of the map,
collapsible, persistent, and bilingual. It is not a toast stack and not a list
of alerts.

### 3.1 It is a real thread

A Perimeter conversation is an ordinary `agent_threads` row marked
`kind = 'perimeter'` (new column, added with the existing `addColumnIfMissing`
helper). Consequences that matter:

- history survives reloads, restarts, and re-login,
- it appears in the existing conversation list,
- the existing agent request queue, admission control, quota accounting,
  cancellation, per-user lane serialization, and SSE recovery all apply
  unchanged,
- anything the agent says on the map can be continued in the full chat screen,
  and anything said there is visible here.

`messages` gains a nullable `meta_json` carrying the anchor of a proactive
message: `{ severity, rule, systemId?, killmailId?, routeId? }`. Listing a
conversation currently titles it from the first *user* message; a Perimeter
thread may open with an assistant message, so the title falls back to the
thread kind and the pilot's system.

### 3.2 Two directions of traffic

**Pilot → agent.** Normal composer at the bottom of the panel. Every message
automatically carries map context the pilot did not have to type: current
system and security, hull, online state, bubble radius and its danger summary,
the currently selected system, and the active route. So "стоит ли лететь?" is
answerable without a single clarifying question.

**Agent → pilot, unprompted.** This is the core of the feature. A server-side
advisor tick runs on two triggers: a position change (≤5 s granularity) and a
new killmail landing inside the pilot's bubble. It evaluates deterministic
rules, and when one fires it writes an assistant message into the Perimeter
thread and pushes it over the map SSE stream, where it appears in the chat like
any other reply.

### 3.3 The rules that make it speak

Each is deterministic, individually testable, and carries its own severity and
cooldown.

| Rule | Trigger | Example message |
| --- | --- | --- |
| **Pursuit** (`detectPursuit`, already in repo) | the same attacker characters appear in kills tracking the pilot's path | "Те же двое, что убили в Sivala, засветились в Hatakani. Они идут по твоему следу." |
| **Camp on the next hop** | kills clustered on one gate of an adjacent system inside the window | "В Uedama три трупа на гейте за 20 минут, все на выходе к тебе." |
| **Threat level rise** | bubble danger crosses a band boundary | "Периметр из жёлтого в красный: за пять минут четыре кила в двух прыжках." |
| **Value spike** | a kill above a value threshold inside the bubble | "В двух прыжках выбили фрейтер на 4 млрд — там сейчас будет толпа." |
| **Capability gap** | hulls killing nearby out-class the pilot's current hull | "Loki сходится за 3.4 с, ты за 12. Он тебя поймает." |
| **Route degraded** | a system on the active route lights up | "Твой маршрут покраснел на 4-м прыжке. Обход стоит +3 прыжка — построить?" |
| **All clear** | danger falls and stays low for the cooldown | "Чисто. За 15 минут в периметре ничего." |
| **Entered a new region / lost highsec** | security band change on jump | "Ты вышел из хайсека. Дальше правил нет." |

### 3.4 Cost and noise control — non-negotiable

- **Rules fire first, without the model.** Routine events produce a templated,
  localised sentence at zero model cost.
- **The model is invoked only** when a rule fired, the situation clears the
  escalation bar (a `danger` severity, or a pursuit at any severity), and the
  separate LLM cooldown has elapsed. A pilot flying for an hour must never cost
  a model call every five seconds.
  *(Implemented as `shouldEscalateToModel` in `src/eve-map/advisor.ts` rather
  than the existing `shouldUseLlmIntel`: that helper needs a `RouteThreatDigest`,
  which only exists when a route monitor is running, and Perimeter must warn a
  pilot who has no destination set.)*
- Per-rule cooldown plus global per-session cooldown; repeated identical
  conditions collapse into one message with a counter rather than repeating.
- Severity filter in the UI (`всё` / `важное` / `тихо`) and a mute switch.
- Every proactive message is anchored: clicking it flies the camera to the
  system and highlights the killmail it came from.

### 3.5 Agent tools

Four bounded tools registered alongside the existing catalog:

- `map_bubble_intel(radius)` — the server-computed picture of the bubble, so the
  model reads one prepared payload instead of fanning out.
- `route_risk(origin, destination, risk_preference, ship?)` — build and compare
  routes with the cost breakdown.
- `compare_ships(a, b)` — EHP, align time, warp speed, signature, class, from
  local SDE dogma.
- `threat_explain(system_id)` — why a system is red: who killed whom, in what,
  when, and which attackers are repeat offenders.

---

## 4. Architecture

### 4.1 Map graph — `src/eve/map-graph.ts`, tables `map_systems` / `map_edges` / `map_graph_meta`

Derived from the SDE at boot, rebuilt when the SDE build number changes, cached
in memory (~8000 systems, ~14000 links, a couple of megabytes). `map_x/map_y`
prefer `position2D`, otherwise project the 3D position as `(x, -z)` per CCP's
map-data guide; the source used is recorded and surfaced to the client. A build
that resolves coordinates for under 90% of systems throws rather than drawing a
partial map.

Operations: `bubbleFrom(systemId, radius, maxNodes)` — BFS admitting whole rings
so every node has a correct jump distance, reporting the radius that actually
fit when capped; `routeWithRisk(origin, destination, opts)` — Dijkstra with cost
`1 + λ·danger`, security preference as a penalty rather than a ban (a secure
route to a nullsec station must still exist), avoid-set, and wormhole edges.

### 4.2 Live kill index — `src/eve-map/kill-index.ts`, table `map_kill_events`

Subscribes to the **already running** global EVE-KILL feed poller and writes one
row per killmail. This is the decision that makes the map both live and cheap:
"kills in my bubble" becomes one indexed local query instead of 30+ outbound
requests per refresh, shared across all users, seconds-fresh instead of an hour
stale. Bounded by age retention and a row cap. Cold start after a restart is
covered by a bounded, per-system-deduplicated backfill via `searchKillmails`.

### 4.3 Bubble intel and danger — `src/eve-map/bubble.ts`, `danger.ts`

Per system: security, sovereignty, hourly ESI baseline, live 15 m / 1 h / 24 h
counts and destroyed value, gate-camp attribution (`attributeKillsToGates`),
repeat attackers, wormhole exits.

The danger score is returned as **labelled terms, never a bare number**:
recency-weighted kill rate, repeat-attacker presence, camp signature, victim
similarity to the pilot's hull, capability gap against the pilot's live ship,
security floor, and a low-activity discount so a quiet nullsec system does not
outrank a camped highsec gate.

### 4.4 Live session and stream — `src/eve-map/live-session.ts`, `src/web/map-routes.ts`

- `GET /api/web/map/graph` — bubble topology and geometry.
- `GET /api/web/map/intel` — live rollups.
- `GET /api/web/map/live` — SSE: `location` (5 s), `intel` (~15 s), `kill`
  (immediate), `advisory` (agent chat message), heartbeat, `Last-Event-ID`
  resume.
- `POST /api/web/map/route` — risk-weighted route, optional in-game waypoint.
- `POST /api/web/map/ask` — a message into the Perimeter thread.

The 5 s ESI poll runs only while a stream is attached, once per character across
all tabs, under global and per-user session caps, with exponential backoff,
auto-stop on offline or idle, and a shutdown drain. Mutations carry CSRF;
model-touching endpoints pass `admitWebEvent`.

### 4.5 Screen — `web/src/components/map/`

Full-screen section with the map on the left and the collapsible agent chat on
the right.

- **Ego-ring layout (primary):** pilot centred, one ring per jump, angle from
  real 2D coordinates, siblings spread along the arc.
- **Geographic layout (secondary):** real coordinates, region-clustered,
  reached by interpolating the same nodes rather than remounting the scene.
- **Follow camera:** eases to the pilot on each jump, auto-zooms out while
  jumping frequently and back in when stationary, released by panning with a
  "back to me" control.
- Overlays: danger heat, kill flashes, route ribbon, gate camps, wormholes.
- System inspector: recent kills with victim, attacker, both hulls, value, age,
  and a killmail link; gates and which one is camped; actions to route, avoid,
  or ask the agent.
- Per-layer freshness markers; the hourly ESI baseline is never shown as live.

---

## 5. Config knobs

All wired to runtime behaviour and covered by tests: `MAP_BUBBLE_DEFAULT_RADIUS`,
`MAP_BUBBLE_MAX_RADIUS`, `MAP_BUBBLE_MAX_NODES`, `MAP_LOCATION_POLL_SECONDS`,
`MAP_INTEL_REFRESH_SECONDS`, `MAP_MAX_LIVE_SESSIONS`,
`MAP_MAX_LIVE_SESSIONS_PER_USER`, `MAP_KILL_INDEX_RETENTION_HOURS`,
`MAP_KILL_INDEX_MAX_ROWS`, `MAP_ADVISOR_COOLDOWN_SECONDS`,
`MAP_ADVISOR_LLM_COOLDOWN_SECONDS`.

---

## 6. What the feature is honest about

Product-facing limits, shown in the UI rather than buried:

- **There is no API for who is in local.** Verified: no such endpoint exists in
  the ESI catalog. Everything Perimeter knows about hostiles is inferred from
  killmails, from the pilot's own ESI data, or from a local-chat paste the pilot
  supplies (`analyze_local` already does this). The map never claims to show
  live player presence.
- **ESI aggregates are hourly** and are labelled as a baseline layer.
- **Killmails arrive with a publisher delay** of seconds to minutes; each event
  displays its age.
- **Position cannot be fresher than 5 seconds** — that is the ESI cache.
- **Nothing reads the game client.** ESI only.
- **Incursion and faction-warfare layers are unavailable** through this ESI
  catalog and are not promised.

---

## 7. Production risks and guards

| Risk | Guard |
| --- | --- |
| SDE lacks coordinates in the operator's DB | `scripts/verify-map-geometry.ts` reports what the loaded SDE provides; the builder refuses partial (<90%) or empty geometry and names the missing field. A failed build disables only the Perimeter screen — the bots and chat lanes keep running and the screen reports the reason, because taking down every lane over one screen is the wrong trade |
| 10-jump highsec bubble is very large | whole-ring node cap with an honest `truncated` flag and the radius that fit |
| Per-user 5 s ESI polling | poll only while streamed, one poll per character, global + per-user caps, backoff, offline stop, shutdown drain |
| Kill index unbounded growth | age retention + row cap + sweep |
| Model cost on a moving pilot | rule-first advisories, LLM gated by `shouldUseLlmIntel` + cooldown |
| Advisory spam | per-rule and per-session cooldowns, collapse of repeats, severity filter, mute |
| SSE connection leak | heartbeats, idle timeout, close on abort, drain on shutdown |
| Guest or missing location scope | public map and public intel remain; position and advisories gated on the scope, with the missing scope named |
| EVE-KILL outage | index goes stale, not wrong: freshness marker flips and the agent says the live layer is down |

---

## 8. Verification plan

See `.agent/tasks/perimeter-live-map/verification.md` for what was actually run
and what was not.

- Unit: graph build and geometry fallback, BFS ring caps, risk Dijkstra
  (λ=0 equals shortest path; raising λ lengthens and de-risks), danger term
  math, kill-index dedup and retention, live-session lifecycle and backoff,
  advisory rules and cooldowns, thread persistence, tool schemas, config wiring.
- `npm run check` and `npm run build`.
- Manual: browser preview against the dev server for the renderer, camera, and
  the chat panel.

## 8a. Delivered beyond the original plan

The first real flight and two external consultations changed the shape of this:

- **A separate Perimeter assistant.** The plan assumed the workspace agent with
  map tools attached. In flight that was wrong: it answered with the workspace
  prompt and the full trading catalog. A thread's `kind` now selects the
  assistant, and the flight one carries a focused catalog.
- **Whole-cluster view.** The plan scoped a bubble. The owner wanted all of New
  Eden, and it turned out the bubble was never the limit — the per-viewer intel
  model was. A shared static payload plus one shared live rollup made it
  affordable (`src/eve-map/universe.ts`).
- **Long-term accumulation.** Two ESI endpoints each return the whole cluster
  per response, so two requests an hour cover everything. Hourly buckets, an
  hour-of-week profile that outlives them, and per-gate camp history with the
  pilots who keep appearing.
- **A standing avoid list**, per pilot rather than per request.
- **Autopilot from the map**, which the plan listed as optional and which turned
  out to be the cheapest missing piece.
- **Level rules instead of cooldowns** for advisories. Cooldowns re-announced a
  persisting condition every minute; production showed the same warning eight
  times in ten minutes.

## 9. Out of scope

Corporation or fleet map sharing, in-game overlay, flight replay export, mobile
layout, and the STOMP websocket transport. Recorded in the tech-debt tracker.
