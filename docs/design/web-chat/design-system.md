# EVE AI web chat design system — «Фотонный мостик»

Current direction: a **chat-first shell**. The conversation is the app; Market,
Route and Capsuleer ride along in a right-hand **data dock** instead of living
on separate screens. The agent's tool calls are promoted from a hidden
`<details>` disclosure into visible instrumentation — a row of chips above
each answer and a live status strip while the request runs.

Visual direction: a ship-HUD feel in the spirit of EVE Online's in-game UI,
built only from original CSS (no CCP logos, art, screenshots or game UI
assets). A deep-space backdrop (nebula glow, faint 48 px HUD grid, star field)
sits behind translucent **glass panels** (dark blue-grey fills with
`backdrop-filter`), 1 px cool hairline frames, **cut (bevelled) corners** and
thin **corner brackets** on the two square corners of a panel. Cold
cyan/teal marks everything interactive and live data; amber/gold marks
highlights, counts and warnings. Headers and chrome labels are uppercase,
letter-spaced **Exo 2**; body stays IBM Plex Sans and telemetry IBM Plex Mono
with tabular numbers.

The previous «Солнечная палуба» (rounded 12–26 px, warm sun disc) and the older
angular concepts ([login-concept.png](./login-concept.png),
[chat-concept.png](./chat-concept.png)) are kept as history; the login screen
still follows their composition, restyled onto the tokens below.

## Tokens

All tokens live in the `:root` block of `web/src/styles.css`. Highlights:

| Group | Tokens |
| --- | --- |
| Surfaces (glass) | `--bg #03060a`; translucent `--bg-panel`, `--bg-card`, `--bg-elevated`, `--bg-answer`, `--bg-inset`, `--bg-user` (teal tint); `--bg-solid #0a111a` for opaque popups/options; `--glass-blur` |
| Borders | cool hairlines `--border`, `--border-soft`, `--border-strong`, `--border-inset` (rgb 128/176/206 at 9–28 %) |
| Text | `--text-bright #eef6fa`, `--text-body #d8e3ea`, `--text #c9d6df`, `--text-secondary #98a9b7`, `--muted #8797a7`, `--text-faint #72869a`, `--text-label #6f8497` — all ≥ 4.5:1 on panel glass |
| Interactive | `--cyan #45d3e6` (+ `-bright`, `-deep`, `-soft`, `-fill`, `-line`, `-glow`); `--accent*` alias it |
| Highlight | `--amber #f0b54a` (+ `-bright`, `-soft`, `-line`); legacy `--solar*` names alias amber |
| Data / money | `--data #63d0f5`; `--isk #ecd49a` via the `.isk` class (mono, tabular, pale gold) |
| Semantic | `--pos #6fe0a8`, `--neg #ff7f6e`, `--warning` = amber |
| Security | `--sec-10 … --sec-00`: 1.0 blue → 0.7 teal → 0.5 yellow-green → 0.4–0.1 orange/red → ≤ 0.0 red |
| Environment | `--nebula`, `--hud-grid`, `--scanlines`, `--starfield`, `--agent-core` (hex mark), `--agent-glow` |
| Geometry | `--cut-xs/sm/md/lg` (2 px fallback; 4/6/9/12 px bevels under `@supports (corner-shape: bevel)`); `--radius-*` alias the cuts; `--bracket`, `--bracket-size 9px` |
| Focus | `--focus-ring 1px cyan` + offset, `--focus-glow` for fields |

Panels use the asymmetric `border-radius: 0 var(--radius-sm)` so only the
top-right and bottom-left corners are cut; brackets (`::after`, four 1 px
gradients, `pointer-events: none`) mark the square top-left and bottom-right
corners. Browsers without `corner-shape` get near-square 2 px corners — never
round pills. Only status dots keep `corner-shape: round`.

Type: **Exo 2** (variable 100–900) for display headings and chrome labels
(`--font-hud`, `--font-label`, label scale `--label-sm/md/lg` 10/11/12 px,
`--tracking-label` 0.14em); **IBM Plex Sans** for UI and body (14.5 px / 1.62);
**IBM Plex Mono** for telemetry, times and numbers (`--mono-*` 9–11.5 px,
`tabular-nums`). All three are self-hosted from `web/public/assets/fonts/` as
latin / latin-ext / cyrillic / cyrillic-ext subsets with `unicode-range`
(OFL, see `OFL.txt`); no font CDN.

Security status is coloured through `web/src/security.ts`
(`securityClassName(sec, 'sec' | 'sec-badge')`, tier rounded from the same
`toFixed(1)` string that is displayed, with (0, 0.05) kept at 0.1). It is used
wherever a system's security is shown: the map inspector and route list and the
pilot profile location cards. The universe canvas mirrors the same ramp as a
constant array (a canvas cannot read CSS variables per frame), and the map
legend gradient uses the tokens.

## Component inventory

- **Shell** (`web/src/App.tsx`): CSS grid `250px | minmax(0,1fr) | 336px`, full
  viewport height, every column `min-height: 0` and `overflow: hidden` so only
  the message list scrolls. The dock column exists only while the dock is open.
- **Sidebar** (`web/src/components/Sidebar.tsx`): hex-crystal brand over an
  Exo 2 tagline; a status strip (left colour bar: cyan ok / amber stale / red
  down) fed by the live market snapshot; uppercase nav rows with a cyan left
  bar and glow on the active row and an amber count; a cyan glass "new thread"
  button; the session list (active row: amber left edge) with relative
  timestamps and a hover delete affordance; a pinned account card with a
  square ESI portrait, SP and current system.
- **Chat** (`web/src/components/ChatScreen.tsx`): 58 px glass header (label
  kicker, Exo 2 thread title, amber-edged model tag, segmented locale switch,
  dock toggle that stays lit while open) with a cyan tick on its bottom rule;
  user bubbles as teal glass with a cyan right edge; assistant answers on a
  scanlined glass panel with corner brackets beside the 30 px hex avatar
  (markdown `#`/`##` headings become uppercase Exo 2 with a cyan rule/bar);
  square tool chips with a data-blue left edge; the live status strip with a
  restrained sweep highlight; a bevelled glass composer with a cyan focus glow
  and a 40 px cyan send key.
- **Data dock** (`web/src/components/DataDock.tsx`): a squared segmented tab
  control (Market / Route / Capsuleer; active = cyan fill + underline) over
  bracketed glass cards — region, watchlist prices, a 30-day history
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
- **Motion**: 160 ms ease-out for hover (border, glow, bracket brighten),
  220 ms `cubic-bezier(.2,.7,.3,1)` for the dock sheet, a 1.6 s pulse on the
  thinking dot, a 2.4 s sweep across the status strip and a slow 4.8 s glow
  "breath" on the empty-state core — all disabled under
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
- `<= 640px`: a three-segment bottom bar (Chat / Market / Pilot) sits above the
  dock sheet, so raising the dock never hides the way back to the thread.
- The login split still becomes a single readable content column over the
  generated orbital background while preserving contrast.

## Environment layers

The nebula, HUD grid and star field are **background layers on `.chat-app`**
(and `.login`), not positioned elements; sidebar, dock and headers are glass
over them. An absolutely positioned limb at `right: -130px`
extended the scrollable area inside `overflow: hidden`, and focusing the
composer scrolled the entire chat column 130 px sideways. Backgrounds never
contribute to scrollable overflow.

## Asset treatment

The hex agent mark (`.sun-disc` / `.assistant-mark` / `.chat-intro__orbit`,
legacy class names), nebula, grid, scanlines and star field are pure CSS
gradients and `clip-path` — no images, no CCP logos or game art. The favicon is
an original SVG of the same hex mark. Backdrop blur is used on panels outside
the map; overlays that sit on the animated map canvas keep an opaque fill
instead of adding new `backdrop-filter`, so the canvas does not pay for a
re-blur every frame.
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
