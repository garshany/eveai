/**
 * Terminal renderer for the CLI's live activity feed.
 *
 * Turns the agent's activity events into terminal output: a "thinking" spinner
 * between steps, one line per tool/skill as it runs, brief reasoning notes, and
 * the answer streamed in token by token.
 *
 * I/O is injected (write/isTty/render/setInterval) so the whole thing is
 * testable against a virtual screen — the invariant that matters is that a
 * cursor-erase (\r\x1b[K) only ever wipes the spinner's own line, never a
 * printed activity line or the streamed answer.
 */
import type { AgentActivityEvent, AgentActivitySink } from '../agent/activity.js';
import type { AnsiColor } from '../observability/logger.js';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Friendly label + icon for a tool name shown in the live activity feed. */
export function toolLabel(name: string): string {
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

export interface RendererDeps {
  /** Raw terminal write (no trailing newline added). */
  write: (text: string) => void;
  /** Whether the output is an interactive TTY (enables the \r spinner). */
  isTty: boolean;
  /** Convert the model's markup to terminal-styled text for the non-streamed path. */
  render: (text: string) => string;
  /** Apply ANSI color (identity in tests). */
  colorize: (color: AnsiColor, text: string) => string;
  /** Injected so tests can drive the spinner with fake timers. */
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

export interface ActivityRenderer {
  sink: AgentActivitySink;
  finish: (answer: string) => void;
  abort: () => void;
}

export function createActivityRenderer(deps: RendererDeps): ActivityRenderer {
  const { write, isTty, render, colorize } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let spinnerOnLine = false; // the spinner (and nothing else) currently occupies the cursor line
  let streaming = false;     // answer tokens have started arriving
  let streamedAny = false;
  let streamedText = '';     // raw answer text streamed so far

  const say = (text: string) => write(text + '\n');

  const startSpinner = () => {
    if (!isTty || streaming || timer) return;
    timer = deps.setInterval(() => {
      // Neutral, honest label — the real work shows as tool/reasoning lines. A
      // flavor phrase here reads as a fake action ("checking Jita") not happening.
      write(`\r${colorize('cyan', SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${colorize('gray', 'думаю…')}`);
      frame += 1;
      spinnerOnLine = true;
    }, 90);
  };
  // Stop the animation. Erase the line ONLY if the spinner itself is on it — never
  // wipe printed activity lines or the streamed answer.
  const stopSpinner = () => {
    if (timer) { deps.clearInterval(timer); timer = null; }
    if (spinnerOnLine) { write('\r\x1b[K'); spinnerOnLine = false; }
  };
  const printLine = (text: string) => {
    stopSpinner();
    say(text);
    startSpinner();
  };

  const onEvent = (event: AgentActivityEvent) => {
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
        if (!streaming) { stopSpinner(); streaming = true; write('\n'); }
        streamedAny = true;
        streamedText += event.delta;
        write(event.delta);
        break;
    }
  };

  return {
    sink: { wantsTokens: true, emit: onEvent },
    finish: (answer: string) => {
      stopSpinner();
      if (!streamedAny) {
        // No token stream (short/edge response) — render the final answer cleanly.
        say('\n' + render(answer));
        return;
      }
      // The answer body already streamed in raw; close the line. If finalize
      // appended a tail the stream didn't carry (e.g. a helpful-commands block),
      // print just that tail so nothing is silently dropped — only when the final
      // answer cleanly extends the streamed text; never re-print the body.
      write('\n');
      const streamedTrim = streamedText.trimEnd();
      const answerTrim = answer.trimEnd();
      if (answerTrim.length > streamedTrim.length && answerTrim.startsWith(streamedTrim)) {
        const tail = answerTrim.slice(streamedTrim.length).trim();
        if (tail) say('\n' + render(tail));
      }
    },
    abort: () => stopSpinner(),
  };
}
