# Perimeter — live threat map with a proactive agent chat

One screen that answers "where am I, what is around me, where do I go next"
while the pilot is flying, with an assistant that speaks first.

Implementation plan and API validation:
[`docs/exec-plans/active/perimeter-live-map.md`](../exec-plans/active/perimeter-live-map.md).

## What the pilot sees

Opening **Периметр / Perimeter** in the browser workspace gives one of three
honest states — never a blank canvas:

| State | What is shown |
| --- | --- |
| Map graph not built | The reason, and that the operator must load the SDE. |
| Guest, or no location scope | The public map around a default system, every danger layer working, and the exact missing scope (`esi-location.read_location.v1`). |
| Linked pilot with the scope | The live map centred on the pilot. |

### The map

- **Jump rings (default).** The pilot sits at the centre and every ring is one
  jump of distance. The ring index *is* the jump count, so "how close is the
  danger" is answered by looking, not by counting. The angle of a system on its
  ring comes from its real SDE coordinates, so the topology still reads
  geographically.
- **Geography (second view).** The familiar coordinate layout, reached by
  interpolating the same nodes rather than remounting the scene.
- **Follow camera.** Eases to the pilot on each jump, zooms out while jumps come
  frequently and back in when the pilot is stationary, and releases on a pan
  with a way back — the behaviour of a navigation app.
- Node colour is the danger band, node size is activity: a quiet red system and
  a busy amber one must not look alike.
- Gate camps get their own ring marker rather than a shade, because a camp is
  the thing that actually kills a traveller.
- **Whole map (third view).** The cluster atlas is polled every 15 s, and while
  the live stream is open its kills also flash on the atlas at once (the same
  flash as the bubble) and are counted into the system's activity until the
  next poll covers them — each kill once, a PvP kill lifting a calm system to
  `watch` at least, NPC kills counted as ratting only.

### The system inspector

Recent kills answer the question literally: who killed whom, in what hull, worth
how much, how long ago, linked to the killmail. Repeat attackers are called out,
and so is the gate the kills cluster on.

Above them, the danger score is broken into its labelled terms. A red dot
without an explanation is not intelligence, so the breakdown is not optional.

### The agent chat

The right-hand panel is a real conversation thread, not a notification rail. It
persists across reloads, restarts, and re-login, and it appears in the workspace
conversation list.

- **The pilot asks.** Every message silently carries the map context — current
  system and security, hull, bubble radius and its danger summary, the selected
  system, the active route — so a bare "стоит ли лететь?" is answerable without
  a clarifying question.
- **The pilot's question sees the radar.** A Perimeter turn carries a radar
  snapshot kept by the live stream — current system, hull, bubble verdict,
  the hottest nearby systems and the latest alarms — read from memory with no
  extra ESI call, and forgotten five minutes after the map closes.
- **The agent speaks first.** On a position change or a new kill inside the
  bubble, deterministic rules fire: pursuit, camp on the next hop, threat-level
  rise, value spike, capability gap, route degraded, security-band change, and
  all-clear. Each produces a finished, localized sentence. Threat-level rise is
  judged per bubble radius: two tabs watching different radii of the same pilot
  do not flip each other's band. A kill inside the
  bubble is pushed to the map at once and re-judged within about 1.5 s (bursts
  share one rebuild), not at the next 15 s intel tick. Kills that land before
  the first bubble or mid-jump are held and sorted by the next build rather than
  dropped; a bubble the pilot jumped out of while it was building is never
  published. Every open tab of the same pilot hears each advisory, which is
  persisted once.
- Every proactive message is anchored to what it is about; clicking it moves the
  camera to that system and highlights the killmail.
- Severity filter and mute are honoured server-side. Repeats inside a cooldown
  collapse into one message with a counter instead of repeating.

## Cost and load discipline

These are product guarantees, not implementation details:

- **The radar understands, rarely.** After a danger-level alarm the model gets
  a facts-only sheet of the live picture and writes a short assessment with one
  concrete action, published as a follow-up to the rule text. It runs detached
  (the radar never waits), at most once per `MAP_ADVISOR_LLM_COOLDOWN_SECONDS`
  per pilot, is billed like any model call, and can be switched off with
  `MAP_ADVISOR_LLM_ENABLED=false`.
- **A kill reacts in about a second and a half,** not on the next intel tick:
  an in-bubble kill schedules one debounced rebuild that a burst shares.
- **Live kills carry an ISK value.** Feed killmails are ESI-shaped and have no
  value; the index estimates hull + items at the cheapest sell in the home
  market region from the local snapshot, never overriding a provided value.
- **The radar stays on while watched.** The client renews the idle lease every
  four minutes while its tab is visible (`POST /api/web/map/live/touch`); a
  hidden, forgotten tab still times out. A client watchdog reconnects a stream
  that has been silent for 45 seconds.
- **Rules speak without the model.** Routine advisories cost nothing. The model
  is asked for prose only when a danger-level rule fired and its own longer
  cooldown has elapsed, so an hour of flying can never cost a model call every
  five seconds.
- **The position poll exists only while somebody is watching**, runs once per
  character across all tabs, and stops when the stream closes, the pilot logs
  off, or the session idles.
- **Live kill data is shared.** One rolling index fed by the feed poller serves
  every viewer, so "kills around me" is a local query, not a per-viewer fan-out.
- **A bot outage does not freeze the radar.** The index is a non-blocking feed
  observer: it receives every page before, and independently of, Telegram /
  Discord watch delivery. When a retryable delivery failure holds the durable
  cursor, the poller keeps fetching up to ten pages past it per (backed-off)
  poll for the index only; watches still resume from the held cursor with the
  documented at-least-once semantics once the platform recovers. Replays are
  absorbed by the `killmail_id` primary key.
- Global and per-user session caps refuse politely with a retry hint rather than
  queueing without bound.

## What Perimeter is honest about

Shown in the interface, not buried here:

- **There is no API for who is in local.** Verified against the ESI catalog this
  deployment uses: no such endpoint exists. Everything the map knows about
  hostiles is inferred from killmails, from the pilot's own ESI data, or from a
  local-chat paste the pilot supplies (`analyze_local`). The map never claims to
  show live player presence.
- **ESI aggregates are hourly** (`/universe/system_kills/`,
  `/universe/system_jumps/`, `/sovereignty/map/`) and are labelled as a baseline
  layer, never as live.
- **Killmails arrive with a publisher delay** of seconds to minutes; each event
  shows its age.
- **A stalled kill feed is not "all clear".** The bubble's `kills` layer is
  `live` only while the EVE-KILL feed is attached and fed the index within 90 s;
  otherwise it is `cached` (stale, with the feed error) or `unavailable`. The
  whole-map intel (`GET /api/web/map/universe/intel`) carries the same marker as
  `killFeed`, shown as the `kills` chip on the whole-map view.
- **The "recent kills" window is the retention window.** A system rollup's
  `killsWindow` covers `killsWindowHours` = min(24, `MAP_KILL_INDEX_RETENTION_HOURS`)
  — 3 h by default — and says so; it is never labelled 24 h when the index does
  not hold 24 h. Long-retained gate kills do not leak into it. The danger
  score's quiet discount uses that window and names it.
- **An unknown hull is not a doomed hull.** A ship type without dogma rows in the
  loaded SDE gets no capability assessment instead of "survival: dead".
- **Position cannot be fresher than five seconds** — that is the ESI cache, and
  it is exactly the poll interval.
- **Nothing reads the game client.** ESI only.
- **Incursion and faction-warfare layers are not available** through this ESI
  catalog and are not promised.
- Route danger covers only systems inside the bubble; systems outside it are
  scored zero, which the route panel states rather than implying they are safe.

## Agent tools

| Tool | Answers |
| --- | --- |
| `map_bubble_intel` | "What is around me / is it safe here" — one prepared payload with per-system danger scores and their terms, live kill counts, and gate camps. |
| `route_risk` | "How do I get there safely" — a danger-weighted route with a per-hop cost breakdown and how many extra jumps safety cost. |
| `compare_ships` | "Can that X catch my Y" — EHP, align, warp speed, and class from local SDE dogma. |
| `threat_explain` | "Why is this system red" — the actual killmails and which attackers repeat. |

## Operator configuration

All knobs are documented in `.env.example` under **Perimeter live map** and are
covered by `tests/unit/map-config.test.ts`, which fails if a knob exists in code
but not in the operator's reference file.

A missing or coordinate-less SDE disables only this screen. Telegram, Discord,
the CLI, and the chat lanes keep running, and the screen reports the reason.
