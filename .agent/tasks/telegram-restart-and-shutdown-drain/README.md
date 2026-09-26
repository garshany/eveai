# Telegram restart delivery, Markdown rendering, and the shutdown drain

Covers PR #22 (Telegram) and PR #23 (shutdown drain), plus the follow-up that
fixes what Codex found on both after merge. Written after the fact: the two PRs
shipped without this artifact, which `AGENTS.md` requires for substantial work.

## Why

A runtime audit found five defects worth fixing (P1–P3 shipped in #28, #29,
#30). The two remaining ones:

- The agent's output contract is chat Markdown, but Telegram renders entities
  only through `parse_mode`, so every answer arrived with literal `**` and
  backticks.
- Boot dropped pending updates and `shutdown()` called `process.exit()`
  directly, so a deploy swallowed whatever was sent while the bot was down and
  killed any turn that was mid-answer.

## Acceptance criteria

### Rendering

- Chat Markdown (`**bold**`, `*italic*`, `` `code` ``, ``` fences, links) is
  converted to Telegram HTML; plain text is sent with no `parse_mode` at all.
- Markdown that arrives **alongside** existing Telegram HTML (a `plan_route`
  summary with the agent's prose around it) is converted, and the HTML survives.
  Tags outside Telegram's set are still escaped.
- Arithmetic is never markup: `5 * 3 * 2` and `2 ** 3 ** 4` stay literal.
- Link destinations keep balanced parentheses (`.../Tengu_(ship)`).
- No formatting path may delete user-visible text. A same-line ` ```span``` `
  renders as inline code and does not consume the text after it or the next
  line.
- Chunking is fence-aware: a split never cuts through a ``` delimiter, never
  strands an opening fence from its newline, and closes/reopens a block across
  chunks so each chunk parses alone.

### Restart

- Messages sent while the bot was down are answered after boot
  (`TELEGRAM_DROP_PENDING_UPDATES=false`).
- A pre-boot backlog older than `TELEGRAM_MAX_UPDATE_AGE_MINUTES` is skipped;
  an update sent **after** boot is never skipped, however long it queues behind
  a running turn.
- An update whose handler already ran is not handled twice after a crash
  (`telegram_processed_updates`, claimed before dispatch).
- A redelivered button tap cannot silently switch the active character: a tap is
  honoured only when its keyboard was sent by the running process.
- The update queue is never probed to measure the backlog — `getUpdates` with a
  negative offset confirms and discards everything before what it returns.

### Shutdown

- One budget (`SHUTDOWN_DRAIN_MS`, default 30s, ceiling 600s, 0 disables) taken
  on the first line of `shutdown()` covers the whole stop.
- Ingress closes before any await. Refused work is answered, not dropped:
  Discord replies with a retry notice (the gateway never replays events to the
  next process), web `enqueue()` answers 503. Telegram closes via `bot.stop()`,
  because refusing an update in middleware still lets grammY confirm its offset.
- In-flight turns drain for what is left of the budget, counting **web-agent**
  turns as well as chat lanes.
- Every wait in the sequence is bounded: `bot.stop()`, `stopEveKillFeedPoller()`,
  `client.destroy()`, `server.close()`, and the coordinator's own close grace.
- Turns still running at the deadline are logged by count — never silent.
- `deploy/systemd/eveai.service` stop timeout stays above the drain.

## Verification

| check | result |
| --- | --- |
| `npm run check` (typecheck + lint + vitest) | 793 tests passing |
| `codex exec review --base <merge-base>` on #22 | 8 rounds, every finding fixed with a test |
| `codex exec review --base <merge-base>` on #23 | 6 rounds, every finding fixed with a test |
| Codex GitHub review on the merged #22 / #23 | 3 findings, all fixed in the follow-up |

Behaviour is covered by unit tests in `tests/unit/telegram-formatting.test.ts`,
`telegram-staleness.test.ts`, `telegram-update-dedup.test.ts`,
`finalizer-split.test.ts`, `shutdown-drain.test.ts`, `web-agent-requests.test.ts`
and the drain knobs in `config.test.ts`.

## Known limitations

- **Not exercised against a live deployment.** No real restart test was run;
  the drain and the restart guards are covered by unit tests only.
- **Mid-batch Telegram stop.** grammY fetches updates in batches and
  `bot.stop()` only prevents the *next* poll, so a stop arriving mid-batch can
  start turns inside the drain window and cut them at the deadline. They are
  claimed, so the next process does not retry them; they appear in the
  "N turn(s) still running" warning. Refusing them before the claim would let
  the next process re-fetch them, but that is the same refuse-in-middleware
  pattern that loses updates silently whenever polling has not stopped, so the
  bounded and *reported* loss is kept deliberately.
- **A restart retires older keyboards.** Tapping a button from before the
  restart answers "send the command again" instead of acting. Deliberate: a tap
  carries no press time, so it can only be honoured when its keyboard provably
  belongs to this process.
- **Telegram tags in model output are live in mixed messages.** Preserving
  Telegram's tag set means an `<a href>` emitted by the model is rendered rather
  than escaped. The pure-HTML passthrough path already behaved this way; the
  conversion path now matches it. Tags outside that set are still escaped.
