# EVE AI web chat design system — «Солнечная палуба»

Current direction: a **chat-first shell**. The conversation is the app; Market,
Route and Capsuleer ride along in a right-hand **data dock** instead of living
on separate screens. The agent's tool calls are promoted from a hidden
`<details>` disclosure into visible instrumentation — a row of pill chips above
each answer and a live status pill while the request runs.

Visual direction: near-black blue-black background, a star field and a solar
limb as environment, a **sun disc as the agent's mark** (brand, thread avatar
and empty state all wear the same gradient). Warm solar accent for identity and
actions, cold cyan for data and tool calls, generous corner radii (12–26 px,
pills at 999 px).

[login-concept.png](./login-concept.png) and [chat-concept.png](./chat-concept.png)
documented the previous angular "bortovoy terminal" direction and are kept as
history; the login screen still follows their composition, restyled onto the
tokens below.

## Tokens

All tokens live in the `:root` block of `web/src/styles.css`. Highlights:

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg #06080c`, `--bg-panel #080b10`, `--bg-card #0d1218`, `--bg-elevated #0e141b`, `--bg-answer #0c1117`, `--bg-inset #080c11`, `--bg-user #141d28` |
| Borders | `--border #1b2634`, `--border-soft #141b24`, `--border-strong #22303f` |
| Text | `--text-bright #f4f8fb`, `--text #cdd8e2`, `--text-body #dce6ef`, `--text-secondary #8b9aaa`, `--muted #7f8fa0`, `--text-faint #5c6a78`, `--text-label #4e5b69` |
| Accents | `--solar #ffb15c` on `--solar-ink #2a1403`; `--data #63d7f5`; `--pos #7ee0b0`; `--neg #ff8a72` |
| Environment | `--sun-disc`, `--sun-glow`, `--limb`, `--starfield` |
| Radii | `--radius-pill 999px`, `--radius-lg 26px` (composer), `--radius-md 18px` (bubbles), `--radius-sm 14px` (dock cards), `--radius-xs 12px` (rows), `--radius-tail 6px` (bubble tail) |

Legacy names (`--surface`, `--accent`, `--link`, `--danger`, …) are kept as
aliases so the market, profile, support and settings screens re-skin from the
same source. Two extra radii — `--radius-chip 10px` and `--radius-panel 14px` —
carry the smaller service chrome (inputs, table cells, code blocks) that would
read as a greeting card at 18 px.

Type: **IBM Plex Sans** for UI and body, **IBM Plex Mono** for chrome labels,
telemetry and tabular numbers. Both are self-hosted from
`web/public/assets/fonts/` as latin / latin-ext / cyrillic / cyrillic-ext
subsets with `unicode-range`, so a Russian session never downloads latin-ext.
Sans ships as one variable file per subset; Mono as static 400/500.

Mono label sizes are 9 / 9.5 / 10.5 px with 0.06–0.16em tracking, uppercase for
chrome; data is 11.5 px mono with `tabular-nums`; UI text 12.5–13.5 px; body
14.5 px / 1.62.

## Component inventory

- **Shell** (`web/src/App.tsx`): CSS grid `250px | minmax(0,1fr) | 336px`, full
  viewport height, every column `min-height: 0` and `overflow: hidden` so only
  the message list scrolls. The dock column exists only while the dock is open.
- **Sidebar** (`web/src/components/Sidebar.tsx`): sun-disc brand over a mono
  tagline; a status pill fed by the live market snapshot; nav rows with a mono
  count on the active row; a full-width solar "new thread" pill; the session
  list with relative timestamps and a hover delete affordance; a pinned account
  card with the ESI portrait, SP and current system.
- **Chat** (`web/src/components/ChatScreen.tsx`): 58 px header (mono context
  line, thread title, model pill, locale track, dock toggle); user bubbles with
  a cut bottom-right corner and a pilot portrait; assistant answers on a panel
  with a cut top-left corner beside the 30 px sun avatar; tool-call chips; the
  live thinking pill; a 26 px composer with a 38 px solar send circle and a mono
  meta row.
- **Data dock** (`web/src/components/DataDock.tsx`): a 999 px tab track (Market
  / Route / Capsuleer) over cards — region, watchlist prices, a 30-day history
  histogram, a stat pair, and a triggered-alert strip; the Capsuleer tab shows
  identity, wallet, clone, active ship and question pills that seed the composer.
- **Feedback**: accessible focus rings, the loading trio, an inline sanitized
  error rail above the composer, the scroll-to-latest pill.

## Behaviour

- **Tool chip click** and **dock rows** are both wired: a chip opens that
  answer's tool payload on the Route tab; a dock row seeds the composer through
  the same `initialDraft` path the examples screen uses.
- **Streaming**: while `request.status` is `queued | running` the thinking pill
  shows the phase, the newest tool name and an elapsed `m:ss` timer ticking from
  `parseSqlUtcMs(request.createdAt)`; when `streamText` arrives the answer panel
  appears above it with a 1-ch caret.
- **Motion**: 160 ms ease-out for hover, 220 ms `cubic-bezier(.2,.7,.3,1)` for
  the dock sheet, a 1.6 s pulse on the thinking dot — all disabled under
  `prefers-reduced-motion`.

## Responsive behavior

- `>= 1180px`: persistent 336 px dock beside the thread. Dock open/closed is
  remembered in `localStorage` (`eveai.dock.v1`) and defaults to open only where
  there is a column for it.
- `<= 1180px`: the dock becomes an overlay sheet (right on tablet, bottom on
  phone) with its own close control.
- `<= 820px`: the sidebar becomes the off-canvas drawer; the header drops the
  model pill; the composer textarea goes to 16 px because iOS Safari force-zooms
  a smaller focused field and the `100dvh` shell never pans back.
- `<= 640px`: a three-pill bottom bar (Chat / Market / Pilot) sits above the
  dock sheet, so raising the dock never hides the way back to the thread.
- The login split still becomes a single readable content column over the
  generated orbital background while preserving contrast.

## Environment layers

The star field and the solar limb are **background layers on `.chat-canvas`**,
not positioned elements. An absolutely positioned limb at `right: -130px`
extended the scrollable area inside `overflow: hidden`, and focusing the
composer scrolled the entire chat column 130 px sideways. Backgrounds never
contribute to scrollable overflow.

## Asset treatment

The sun disc, star field and solar limb are pure CSS gradients — no images.
`orbit-route.png` remains the generated login background with no overlay baked
into the image; CSS may use an edge mask or a matching background fade to
preserve text contrast, but must not tint or wash the asset.
`alyx-voss-concept.png` remains an extraction reference only: production
identity uses the authenticated character name and never presents the fictional
concept pilot as a real user.

## Known substitutions

The design reference showed values the browser API does not expose. Where that
happened the layout was kept and the data was made honest:

- the sidebar status pill reads the market snapshot (`/api/web/market/status`)
  rather than an `SDE 21.09` build string, which no endpoint returns; a failed
  poll clears the snapshot to "status unknown" instead of holding the last good
  reading, so an API outage cannot look green;
- tool chips show `name · detail`, because `ActivityStep` carries no per-call
  duration;
- the dock's second stat card shows order **escrow** instead of "outbid", which
  is not derivable from `/api/web/profile/orders`;
- the watchlist delta column shows the **sell/buy spread**, the only change the
  watchlist contract exposes without a history call per row;
- the capsuleer card shows **online/offline and the current system**, not
  "Omega" and "docked/in space": `profile.online` means logged into EVE rather
  than subscribed, and `profile.location` is populated whether the pilot is
  docked or in space;
- the `⌘K` composer hint was dropped: the tool palette has not shipped.

## Data isolation

Dock state is per-thread and per-character, and none of it may outlive a
boundary. The retained tool trace is recomputed (to `null` when empty) on every
thread switch, and cleared on logout together with the dock tab and the cached
profile; character-scoped dock reads (orders, clones) are keyed on the active
character ID and clear their previous values before refetching, so switching
pilot A → B never leaves A's numbers on screen.
