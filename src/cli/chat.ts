/**
 * Interactive terminal CLI for the EVE agent — a third platform adapter beside
 * Telegram and Discord, driving the same shared agent runtime. Lets you use the
 * full agent (SDE, market, routes, killboards, OSINT; private ESI after
 * /login) in a terminal with just an OpenAI key — no bot token required.
 *
 *   npm run cli
 */
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { initDb, type Db } from '../db/sqlite.js';
import { runMigrations } from '../db/migrations.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  clearChatConversation,
  createEveLoginLink,
  ensureChatSessionRow,
  resolveThreadForChat,
  runAgentTurn,
} from '../chat/shared.js';
import { getLinkedCharacter, listLinkedCharacters } from '../eve/sso.js';
import { runWithActivitySink } from '../agent/activity.js';
import { sanitizeOutput } from '../agent/finalizer.js';
import { createActivityRenderer as buildActivityRenderer, type ActivityRenderer } from './activity-renderer.js';
import { buildEveSsoSetupGuide, isEveSsoConfigured } from '../eve/eve-login.js';
import { htmlToDiscordMarkdown } from '../discord/format.js';
import { colorize } from '../observability/logger.js';
import { stripTerminalControls } from './term-sanitize.js';
import { createInputQueue } from './input-queue.js';

// Explicit local-platform lane: Telegram private chats are positive and
// allocated Discord DM lanes are negative. Ownership is persisted separately
// in cli_accounts, so the CLI never creates a fake Telegram identity.
const CLI_CHAT_ID = 0;

function getOrCreateCliUser(db: Db): number {
  const existing = db.prepare(
    "SELECT user_id FROM cli_accounts WHERE identity_key = 'local' AND chat_id = ?",
  ).get(CLI_CHAT_ID) as { user_id: number } | undefined;
  if (existing) return existing.user_id;

  return db.transaction((): number => {
    const raced = db.prepare(
      "SELECT user_id FROM cli_accounts WHERE identity_key = 'local' AND chat_id = ?",
    ).get(CLI_CHAT_ID) as { user_id: number } | undefined;
    if (raced) return raced.user_id;

    const result = db.prepare(
      "INSERT INTO users (display_name, created_at, updated_at) VALUES ('CLI', datetime('now'), datetime('now'))",
    ).run();
    const userId = Number(result.lastInsertRowid);
    db.prepare(
      "INSERT INTO cli_accounts (identity_key, user_id, chat_id) VALUES ('local', ?, ?)",
    ).run(userId, CLI_CHAT_ID);
    return userId;
  })();
}

/** CLI's own output — bypasses the console.log silencing installed below. */
function say(line = ''): void {
  process.stdout.write(line + '\n');
}

/**
 * Silence the app's internal console.log/console.warn debug chatter
 * ([api], [executor], [tool], [usage], INF/WRN log lines) so the CLI shows only
 * the spinner and the agent's answer. Real errors (console.error) stay visible.
 */
function silenceInternalLogs(): void {
  console.log = () => {};
  console.warn = () => {};
}

function renderForTerminal(text: string): string {
  // Model/tool text can quote hostile external data (bios, web pages) — strip
  // terminal control sequences BEFORE adding our own ANSI styling. Then reuse
  // the tested HTML->markdown converter plus light styling for **bold**/`code`.
  const md = htmlToDiscordMarkdown(stripTerminalControls(text));
  return md
    .replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => colorize('bold', s))
    .replace(/`([^`]+)`/g, (_m, s: string) => colorize('cyan', s));
}

/** External error text → one safe line for the terminal. */
function safeErrorText(err: unknown): string {
  return stripTerminalControls(err instanceof Error ? err.message : String(err));
}

function banner(): void {
  const c = (s: string) => colorize('cyan', s);
  const g = (s: string) => colorize('green', s);
  say(c('┌─ EVE AI Agent · CLI ───────────────────────────────┐'));
  say(c('│') + ' Talk to the agent in your terminal. Commands:      ' + c('│'));
  say(c('│') + '   ' + g('/login') + '   link an EVE character (opens SSO)     ' + c('│'));
  say(c('│') + '   ' + g('/whoami') + '  show the active character            ' + c('│'));
  say(c('│') + '   ' + g('/clear') + '   wipe this conversation               ' + c('│'));
  say(c('│') + '   ' + g('/exit') + '    quit                                ' + c('│'));
  say(c('└────────────────────────────────────────────────────┘'));
}

async function main(): Promise<void> {
  const db: Db = initDb(config.db.path);
  runMigrations(db);

  // Check the two pillars independently: items (sde_types) power market/price
  // lookups, universe (sde_systems) powers routes. A partial load can leave one
  // empty while the other is full, so a single-table check would mislead.
  const sdeTypes = safeCount(db, 'sde_types');
  const sdeSystems = safeCount(db, 'sde_systems');

  // Start the HTTP server so the EVE SSO callback works for /login. It's only
  // needed for /login, so a bind failure (e.g. port already in use) must not
  // sink the whole CLI — degrade to "public data only" and keep going.
  const { createServer } = await import('../web/server.js');
  const server = await createServer(db);
  let ssoServerReady = false;
  let ssoServerError = '';
  try {
    await server.listen({ port: config.server.port, host: config.server.host });
    ssoServerReady = true;
  } catch (err) {
    ssoServerError = err instanceof Error ? err.message : String(err);
    await server.close().catch(() => {});
  }

  // From here on, hush the app's internal debug logs for a clean prompt.
  silenceInternalLogs();
  if (!ssoServerReady) {
    const portBusy = /EADDRINUSE/i.test(ssoServerError);
    say(colorize('yellow', portBusy
      ? `Порт ${config.server.port} занят — /login недоступен в этой сессии. Освободи порт (lsof -nP -iTCP:${config.server.port} -sTCP:LISTEN) и перезапусти. Публичные данные работают.`
      : `SSO-сервер не стартовал (${ssoServerError}) — /login недоступен; остальное работает.`));
  }
  if (sdeTypes === 0 || sdeSystems === 0) {
    const missing = [
      sdeTypes === 0 ? 'items' : null,
      sdeSystems === 0 ? 'universe' : null,
    ].filter(Boolean).join(' & ');
    say(colorize('yellow', `SDE ${missing} data is empty — run \`npm run setup\` for full lookups (prices, routes).`));
  }

  const userId = getOrCreateCliUser(db);
  ensureChatSessionRow(db, CLI_CHAT_ID, 'cli');
  const ctx: UserContext = {
    userId,
    chatId: CLI_CHAT_ID,
    // The CLI process has no background-producer lifecycle. Persistent watch,
    // heartbeat, and route-monitor tools are hidden and fail closed.
    durableNotifications: false,
  };

  banner();
  const linked = getLinkedCharacter(db, ctx);
  say(linked
    ? colorize('green', `Active character: ${linked.characterName} (${linked.scopes.length} scopes)`)
    : colorize('gray', 'No character linked — public data works now; /login for private ESI.'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(colorize('cyan', 'eve> '));
  const promptLine = () => rl.prompt();

  let closing = false;
  let pendingClose = false;
  // The turn currently talking to the model, if any. Ctrl-C marks it abandoned:
  // the renderer stops and the result is discarded when the turn completes.
  type ActiveTurn = { abandoned: boolean; activity: ActivityRenderer; threadId: string; watermark: number };
  let activeTurn: ActiveTurn | null = null;

  // Delete everything an abandoned turn wrote to its thread (idempotent: the
  // watermark is the pre-turn MAX(id)), and drop any server-state response id
  // so the next turn can't warm-start from the discarded exchange.
  const discardTurnRows = (turn: ActiveTurn): void => {
    db.prepare('DELETE FROM messages WHERE thread_id = ? AND id > ?')
      .run(turn.threadId, turn.watermark);
    db.prepare('UPDATE agent_threads SET last_response_id = NULL WHERE thread_id = ?')
      .run(turn.threadId);
  };

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // Double Ctrl-C can exit while an abandoned turn is still settling.
    // Capture the reference BEFORE any await: if the turn settles during
    // server.close(), its finally nulls activeTurn and skips its own cleanup
    // (closing is already true) — without this capture the rows would leak
    // into the next session.
    const abandonedTurn = activeTurn?.abandoned ? activeTurn : null;
    rl.close();
    if (ssoServerReady) await server.close().catch(() => {});
    // SQLite is sync and there is no await between here and exit, so the
    // in-flight turn cannot write between this cleanup and process.exit.
    if (abandonedTurn) discardTurnRows(abandonedTurn);
    db.close();
    process.exit(0);
  };

  /**
   * Process one input line. Returns true when the screen already ends with a
   * fresh prompt (abandoned turn), so the queue drain must not re-prompt.
   */
  const handleLine = async (line: string): Promise<boolean> => {
    const text = line.trim();
    if (!text || closing) return false;

    if (text === '/exit' || text === '/quit') { await shutdown(); return false; }

    if (text === '/clear' || text === '/reset') {
      const n = clearChatConversation(db, CLI_CHAT_ID);
      say(colorize('gray', `cleared ${n} thread(s).`));
      return false;
    }

    if (text === '/whoami') {
      const l = getLinkedCharacter(db, ctx);
      say(l
        ? `${colorize('bold', l.characterName)} · id ${l.characterId} · ${l.scopes.length} scopes`
        : colorize('gray', 'no character linked — use /login'));
      return false;
    }

    if (text === '/characters' || text === '/chars') {
      const list = listLinkedCharacters(db, ctx);
      if (list.length === 0) say(colorize('gray', 'no linked characters — /login'));
      else for (const e of list) say(`${e.isActive ? colorize('green', '* ') : '  '}${e.characterName} (${e.characterId})`);
      return false;
    }

    if (text === '/login') {
      if (!isEveSsoConfigured()) {
        say(colorize('yellow', buildEveSsoSetupGuide()));
      } else if (!ssoServerReady) {
        say(colorize('yellow', `Локальный SSO-сервер не запущен (порт ${config.server.port} занят) — ссылка входа не сможет принять колбэк. Освободи порт и перезапусти CLI.`));
      } else {
        const url = createEveLoginLink(db, userId, CLI_CHAT_ID);
        say('Открой ссылку для привязки персонажа:\n' + colorize('cyan', url));
        say(colorize('gray', 'После входа станут доступны приватные данные (скиллы, ассеты, локация, …).'));
      }
      return false;
    }

    // Plain text -> agent turn. readline stays ACTIVE during the turn: pausing
    // stdin in raw mode would buffer the ^C byte unread, so Ctrl-C could not
    // abandon an in-flight turn (it would exit later, after the answer).
    // Overlap is impossible anyway — the input queue serializes lines; typing
    // during a turn just echoes and queues.
    const activity = createActivityRenderer();
    const threadId = resolveThreadForChat(db, CLI_CHAT_ID, ctx);
    // Watermark for Ctrl-C: an abandoned turn's rows (user message, tool and
    // assistant rows) are deleted once the turn settles — or in shutdown() if
    // the user exits first — so the discarded exchange never leaks into later
    // context. The queue is serialized, so nothing else writes to this thread
    // while the turn runs.
    const turn: ActiveTurn = {
      abandoned: false,
      activity,
      threadId,
      watermark: (db.prepare(
        'SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE thread_id = ?',
      ).get(threadId) as { m: number }).m,
    };
    activeTurn = turn;
    activity.begin(); // spin immediately — pre-loop work (profile/live-context/compaction) runs before the first model turn
    try {
      const answer = await runWithActivitySink(activity.sink, () => runAgentTurn(db, threadId, ctx, text));
      if (!turn.abandoned) activity.finish(answer);
    } catch (err) {
      if (!turn.abandoned) {
        activity.abort();
        console.error(colorize('red', 'error: ') + safeErrorText(err));
      }
    } finally {
      activeTurn = null;
      if (turn.abandoned && !closing) discardTurnRows(turn);
    }
    return turn.abandoned;
  };

  const inputQueue = createInputQueue({
    handleLine,
    onDrained: (promptSuppressed) => {
      if (pendingClose || closing) { void shutdown(); return; }
      if (!promptSuppressed) promptLine();
    },
    onError: (err) => {
      // Slash-command/DB failures must not become unhandled rejections that
      // kill the CLI — report and keep the loop alive.
      console.error(colorize('red', 'error: ') + safeErrorText(err));
    },
  });

  // EOF (Ctrl-D / end of piped input): drain queued lines, then exit.
  rl.on('close', () => {
    if (inputQueue.isBusy() || inputQueue.size() > 0) pendingClose = true;
    else void shutdown();
  });

  promptLine();
  rl.on('line', (line) => { inputQueue.push(line); });

  // Ctrl-C: first press abandons the in-flight turn (its result is discarded
  // on completion; queued lines still run after it); idle press — exit.
  // Both handlers are needed: readline swallows SIGINT while it owns the TTY,
  // the process-level signal fires while input is paused during a turn.
  const handleSigint = (): void => {
    if (activeTurn && !activeTurn.abandoned) {
      activeTurn.abandoned = true;
      activeTurn.activity.abort();
      say(colorize('yellow', '⏹ Ход прерван — ответ будет отброшен. Ctrl-C ещё раз — выход.'));
      promptLine();
      return;
    }
    void shutdown();
  };
  rl.on('SIGINT', handleSigint);
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', () => { void shutdown(); });
}

/** Wire the terminal activity renderer to real stdout/timers. */
function createActivityRenderer(): ActivityRenderer {
  return buildActivityRenderer({
    write: (text) => { process.stdout.write(text); },
    isTty: Boolean(process.stdout.isTTY),
    render: renderForTerminal,
    // Feed text (reasoning, tool details) bypasses renderForTerminal — compose
    // secret redaction with control-sequence stripping for that path too.
    sanitize: (text) => stripTerminalControls(sanitizeOutput(text)),
    colorize,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => { clearInterval(handle); },
  });
}

function safeCount(db: Db, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

// Only launch the interactive loop when run directly (npm run cli / tsx). Guarded
// so a test can import this module for its helpers without starting a server.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
