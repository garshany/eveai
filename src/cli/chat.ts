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
import { config } from '../config.js';
import { initDb, type Db } from '../db/sqlite.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateUser, type UserContext } from '../auth/user-resolver.js';
import {
  clearChatConversation,
  createEveLoginLink,
  ensureChatSessionRow,
  pickThinkingPhrase,
  resolveThreadForChat,
  runAgentTurn,
} from '../chat/shared.js';
import { getLinkedCharacter, listLinkedCharacters } from '../eve/sso.js';
import { runWithActivitySink, type AgentActivitySink } from '../agent/activity.js';
import { buildEveSsoSetupGuide, isEveSsoConfigured } from '../eve/eve-login.js';
import { registerTelegramOutbound } from '../messaging/outbound.js';
import { htmlToDiscordMarkdown } from '../discord/format.js';
import { colorize } from '../observability/logger.js';

// Sentinel identity for the local CLI user. Real Telegram chat ids are large
// positive numbers and Discord lanes are negative, so 1 can't collide.
const CLI_CHAT_ID = 1;

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
  // Reuse the tested HTML->markdown converter, then light ANSI styling for
  // **bold** and `code` so answers read nicely in a terminal.
  const md = htmlToDiscordMarkdown(text);
  return md
    .replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => colorize('bold', s))
    .replace(/`([^`]+)`/g, (_m, s: string) => colorize('cyan', s));
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

  // Start the HTTP server so the EVE SSO callback works for /login.
  const { createServer } = await import('../web/server.js');
  const server = await createServer(db);
  await server.listen({ port: config.server.port, host: config.server.host });

  // From here on, hush the app's internal debug logs for a clean prompt.
  silenceInternalLogs();
  if (sdeTypes === 0 || sdeSystems === 0) {
    const missing = [
      sdeTypes === 0 ? 'items' : null,
      sdeSystems === 0 ? 'universe' : null,
    ].filter(Boolean).join(' & ');
    say(colorize('yellow', `SDE ${missing} data is empty — run \`npm run setup\` for full lookups (prices, routes).`));
  }

  // Route any producer notifications (kill/route/heartbeat alerts) for this
  // lane to the terminal. CLI uses a positive chat id, so the "telegram" slot.
  registerTelegramOutbound(async (chatId, text) => {
    if (chatId === CLI_CHAT_ID) {
      process.stdout.write('\n' + colorize('magenta', '🔔 ') + renderForTerminal(text) + '\n');
    }
  });

  const userId = getOrCreateUser(db, CLI_CHAT_ID, 'cli', 'CLI');
  ensureChatSessionRow(db, CLI_CHAT_ID, 'cli');
  const ctx: UserContext = { userId, chatId: CLI_CHAT_ID };

  banner();
  const linked = getLinkedCharacter(db, ctx);
  say(linked
    ? colorize('green', `Active character: ${linked.characterName} (${linked.scopes.length} scopes)`)
    : colorize('gray', 'No character linked — public data works now; /login for private ESI.'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(colorize('cyan', 'eve> '));
  const promptLine = () => rl.prompt();

  let closing = false;
  let busy = false;
  let pendingClose = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    rl.close();
    await server.close().catch(() => {});
    db.close();
    process.exit(0);
  };
  // Continue the prompt only if the stream is still open and no turn is running.
  const resumePrompt = () => {
    if (pendingClose || closing) { void shutdown(); return; }
    rl.resume();
    promptLine();
  };

  // EOF (Ctrl-D / end of piped input): finish any in-flight turn first.
  rl.on('close', () => {
    if (busy) pendingClose = true;
    else void shutdown();
  });

  promptLine();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { promptLine(); return; }

    if (text === '/exit' || text === '/quit') { await shutdown(); return; }

    if (text === '/clear' || text === '/reset') {
      const n = clearChatConversation(db, CLI_CHAT_ID);
      say(colorize('gray', `cleared ${n} thread(s).`));
      promptLine();
      return;
    }

    if (text === '/whoami') {
      const l = getLinkedCharacter(db, ctx);
      say(l
        ? `${colorize('bold', l.characterName)} · id ${l.characterId} · ${l.scopes.length} scopes`
        : colorize('gray', 'no character linked — use /login'));
      promptLine();
      return;
    }

    if (text === '/characters' || text === '/chars') {
      const list = listLinkedCharacters(db, ctx);
      if (list.length === 0) say(colorize('gray', 'no linked characters — /login'));
      else for (const e of list) say(`${e.isActive ? colorize('green', '* ') : '  '}${e.characterName} (${e.characterId})`);
      promptLine();
      return;
    }

    if (text === '/login') {
      if (!isEveSsoConfigured()) {
        say(colorize('yellow', buildEveSsoSetupGuide()));
      } else {
        const url = createEveLoginLink(db, userId, CLI_CHAT_ID);
        say('Открой ссылку для привязки персонажа:\n' + colorize('cyan', url));
        say(colorize('gray', 'После входа станут доступны приватные данные (скиллы, ассеты, локация, …).'));
      }
      promptLine();
      return;
    }

    // Plain text -> agent turn. Pause input so turns never overlap.
    rl.pause();
    busy = true;
    const activity = createActivityRenderer();
    try {
      const threadId = resolveThreadForChat(db, CLI_CHAT_ID, ctx);
      const answer = await runWithActivitySink(activity.sink, () => runAgentTurn(db, threadId, ctx, text));
      activity.finish(answer);
    } catch (err) {
      activity.abort();
      console.error(colorize('red', 'error: ') + (err instanceof Error ? err.message : String(err)));
    } finally {
      busy = false;
      resumePrompt();
    }
  });

  rl.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Friendly label + icon for a tool name shown in the live activity feed. */
function toolLabel(name: string): string {
  const KNOWN: Record<string, string> = {
    sde_sql: '🗄  SDE query',
    batch_market_prices: '💰 market prices',
    get_eve_capabilities: '🔑 EVE access check',
    plan_route: '🗺  route planner',
    route_monitor: '🛰  route monitor',
    web_search: '🌐 web search',
    osint_infer_home: '🕵  OSINT',
    analyze_local: '📡 local analysis',
    analyze_scan: '📡 d-scan analysis',
    intel_note: '🗒  intel note',
    update_plan: '📝 plan',
    set_active_fit: '🔧 active fit',
    heartbeat_config: '⏰ heartbeat',
    count_universe_objects: '🔢 universe count',
  };
  if (KNOWN[name]) return KNOWN[name];
  if (name === 'kill_feed' || name.startsWith('eve_kill')) return '☠  killboard';
  if (name.startsWith('eve_scout') || name.startsWith('scout_')) return '🪐 EVE-Scout';
  if (name.startsWith('get_') || name.startsWith('post_') || name.startsWith('eve_')) return `🛰  ESI · ${name}`;
  return `⚙  ${name}`;
}

/**
 * Renders the agent's live activity to the terminal: a "thinking" spinner
 * between steps, one line per tool/skill as it runs, brief reasoning notes, and
 * the answer streamed token by token. Returns a sink to hand to
 * runWithActivitySink plus finish()/abort() to close out the turn.
 */
function createActivityRenderer(): {
  sink: AgentActivitySink;
  finish: (answer: string) => void;
  abort: () => void;
} {
  const isTty = Boolean(process.stdout.isTTY);
  const phrase = pickThinkingPhrase();
  let timer: NodeJS.Timeout | null = null;
  let frame = 0;
  let streaming = false;   // answer tokens have started arriving
  let streamedAny = false;
  let streamedText = '';   // raw answer text streamed so far

  const clearLine = () => {
    if (isTty) process.stdout.write('\r\x1b[K');
  };
  const startSpinner = () => {
    if (!isTty || streaming || timer) return;
    timer = setInterval(() => {
      process.stdout.write(`\r${colorize('cyan', SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${colorize('gray', phrase)}   `);
      frame += 1;
    }, 90);
  };
  const stopSpinner = () => {
    if (timer) { clearInterval(timer); timer = null; }
    clearLine();
  };
  // Print a persistent activity line without losing the spinner animation.
  const printLine = (text: string) => {
    stopSpinner();
    say(text);
    startSpinner();
  };

  const sink: AgentActivitySink = {
    wantsTokens: true,
    emit: (event) => {
      switch (event.type) {
        case 'model_turn':
          startSpinner();
          break;
        case 'tool_start':
          printLine('  ' + colorize('cyan', toolLabel(event.name)) + (event.detail ? colorize('gray', ` · ${event.detail}`) : ''));
          break;
        case 'reasoning': {
          const text = event.text.length > 240 ? `${event.text.slice(0, 239)}…` : event.text;
          printLine('  ' + colorize('gray', `💭 ${text.replace(/\s+/g, ' ').trim()}`));
          break;
        }
        case 'token':
          if (!streaming) { stopSpinner(); streaming = true; process.stdout.write('\n'); }
          streamedAny = true;
          streamedText += event.delta;
          process.stdout.write(event.delta);
          break;
      }
    },
  };

  return {
    sink,
    finish: (answer: string) => {
      stopSpinner();
      if (!streamedAny) {
        // No token stream (short/edge response) — render the final answer cleanly.
        say('\n' + renderForTerminal(answer));
        return;
      }
      // The answer body already streamed in raw; close the line. If finalize
      // appended a tail the stream didn't carry (e.g. a helpful-commands block),
      // print just that tail so nothing is silently dropped. Only when the final
      // answer cleanly extends the streamed text — never re-print the body.
      process.stdout.write('\n');
      const streamedTrim = streamedText.trimEnd();
      const answerTrim = answer.trimEnd();
      if (answerTrim.length > streamedTrim.length && answerTrim.startsWith(streamedTrim)) {
        const tail = answerTrim.slice(streamedTrim.length).trim();
        if (tail) say('\n' + renderForTerminal(tail));
      }
    },
    abort: () => stopSpinner(),
  };
}

function safeCount(db: Db, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
