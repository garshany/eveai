/**
 * Terminal renderer for the CLI's live activity feed.
 *
 * Turns the agent's activity events into terminal output: a "thinking" spinner
 * between steps, one line per tool/skill as it runs, and brief reasoning notes.
 * The answer itself is rendered once at finish() from the finalized (sanitized)
 * text — the feed shows the work, finish shows the result.
 *
 * I/O is injected (write/isTty/render/setInterval) so the whole thing is
 * testable against a virtual screen — the invariant that matters is that a
 * cursor-erase (\r\x1b[K) only ever wipes the spinner's own line, never a
 * printed activity line or the answer.
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
  /**
   * Redact secrets (Bearer tokens, JWTs, keys) from feed text before it is
   * printed. Reasoning summaries and tool-arg details bypass the finalizer, so
   * the feed must sanitize them itself to match the answer's redaction.
   */
  sanitize: (text: string) => string;
  /** Apply ANSI color (identity in tests). */
  colorize: (color: AnsiColor, text: string) => string;
  /** Injected so tests can drive the spinner with fake timers. */
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

export interface ActivityRenderer {
  sink: AgentActivitySink;
  /** Start the "thinking" spinner immediately, before the first model call —
   *  covers pre-loop work (profile refresh, live-context fetch, compaction). */
  begin: () => void;
  finish: (answer: string) => void;
  abort: () => void;
}

export function createActivityRenderer(deps: RendererDeps): ActivityRenderer {
  const { write, isTty, render, colorize, sanitize } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let spinnerOnLine = false; // the spinner (and nothing else) currently occupies the cursor line
  // Set by abort(): the turn was abandoned (Ctrl-C) but the agent may keep
  // running for a while — every later event/finish must be a silent no-op or
  // feed lines would print over the fresh prompt.
  let dead = false;

  const say = (text: string) => write(text + '\n');

  const startSpinner = () => {
    if (!isTty || timer) return;
    timer = deps.setInterval(() => {
      // Neutral, honest label — the real work shows as tool/reasoning lines. A
      // flavor phrase here reads as a fake action ("checking Jita") not happening.
      write(`\r${colorize('cyan', SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${colorize('gray', 'думаю…')}`);
      frame += 1;
      spinnerOnLine = true;
    }, 90);
  };
  // Stop the animation. Erase the line ONLY if the spinner itself is on it — never
  // wipe a printed activity line or the answer.
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
    if (dead) return;
    switch (event.type) {
      case 'model_turn':
        startSpinner();
        break;
      case 'tool_start': {
        const detail = event.detail ? sanitize(event.detail) : '';
        printLine('  ' + colorize('cyan', toolLabel(event.name)) + (detail ? colorize('gray', ` · ${detail}`) : ''));
        break;
      }
      case 'reasoning': {
        const clean = sanitize(event.text).replace(/\s+/g, ' ').trim();
        const text = clean.length > 240 ? `${clean.slice(0, 239)}…` : clean;
        printLine('  ' + colorize('gray', `💭 ${text}`));
        break;
      }
    }
  };

  return {
    // `aborted` doubles as the agent loop's cooperative-cancellation probe:
    // after Ctrl-C the executor stops before the next model call / tool run.
    sink: { emit: onEvent, aborted: () => dead },
    begin: () => { if (!dead) startSpinner(); },
    // The answer is rendered once, cleanly, from the finalized (sanitized) text —
    // the live feed above shows tools/reasoning, this shows the result.
    finish: (answer: string) => {
      if (dead) return;
      stopSpinner();
      say('\n' + render(answer));
    },
    abort: () => {
      dead = true;
      stopSpinner();
    },
  };
}
