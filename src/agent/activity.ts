/**
 * Optional live-activity channel for the agent runtime.
 *
 * The interactive CLI wants to show what the agent is doing in real time —
 * which tool ("skill") is running and a one-line "thinking" note. The
 * Telegram/Discord bots do not: they reply with one finished message.
 *
 * Rather than thread an optional callback through runAgentTurn -> the executor
 * loop -> the model transport (five layers, all shared with the bots), the sink
 * is carried in AsyncLocalStorage. A caller wraps its turn in
 * runWithActivitySink(); deep code calls reportActivity() and only does work if
 * a sink is present. With no sink (the bots) every call is a cheap no-op and the
 * transport path is byte-for-byte unchanged. AsyncLocalStorage also scopes the
 * sink per async turn, so concurrent bot turns never see the CLI's sink.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type AgentActivityEvent =
  | { type: 'model_turn'; iteration: number }
  | { type: 'tool_start'; name: string; detail?: string }
  | { type: 'reasoning'; text: string };

export interface AgentActivitySink {
  emit: (event: AgentActivityEvent) => void;
  /**
   * Optional cooperative-cancellation probe (the CLI's Ctrl-C). When it
   * returns true, the agent loop stops before the next model call or tool
   * execution — in particular no WRITE tool may run after the user aborted.
   * Absent for the bots: their turns are never user-aborted.
   */
  aborted?: () => boolean;
}

/** Thrown (via error message match) when the user abandoned the turn. */
export const TURN_ABORTED_MESSAGE = 'Turn aborted by user';

/** True when the active sink reports the user abandoned this turn. */
export function isTurnAborted(): boolean {
  const sink = storage.getStore();
  if (!sink?.aborted) return false;
  try {
    return sink.aborted();
  } catch {
    return false;
  }
}

const storage = new AsyncLocalStorage<AgentActivitySink>();

/** Run `fn` with `sink` active for every reportActivity() call it transitively makes. */
export function runWithActivitySink<T>(sink: AgentActivitySink, fn: () => Promise<T>): Promise<T> {
  return storage.run(sink, fn);
}

export function getActivitySink(): AgentActivitySink | undefined {
  return storage.getStore();
}

/**
 * Deliver an event to the active sink, if any. A sink that throws must never
 * break the turn — the UI is best-effort, the answer is not.
 */
export function reportActivity(event: AgentActivityEvent): void {
  const sink = storage.getStore();
  if (!sink) return;
  try {
    sink.emit(event);
  } catch {
    // Swallow: a rendering error must not fail the agent turn.
  }
}

/**
 * A short, human-facing summary of a tool call's arguments for the activity
 * line (e.g. "2 items", "Jita→Amarr"). Presentation-only and defensive: unknown
 * shapes return undefined so the caller shows just the tool name.
 */
export function summarizeToolArgs(name: string, args: Record<string, unknown>): string | undefined {
  const typeIds = args.type_ids;
  if (Array.isArray(typeIds)) return `${typeIds.length} item${typeIds.length === 1 ? '' : 's'}`;

  if (name === 'plan_route' || name === 'scout_route') {
    const from = pickString(args.origin, args.from, args.origin_name);
    const to = pickString(args.destination, args.to, args.destination_name);
    if (from && to) return `${from}→${to}`;
  }

  if (typeof args.query === 'string' && args.query.trim()) return truncate(args.query.trim(), 48);
  if (typeof args.intent === 'string' && args.intent.trim()) return truncate(args.intent.trim(), 48);
  if (typeof args.sql === 'string') return 'query';

  const id = pickString(args.system, args.system_name, args.region_id, args.character_id);
  return id ? truncate(id, 32) : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
