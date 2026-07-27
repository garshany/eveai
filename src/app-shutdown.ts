/**
 * The ordered heart of graceful shutdown, factored out of app.ts so the
 * sequence is unit-testable.
 *
 * Live conversations drain FIRST, bounded by the shared SHUTDOWN_DRAIN_MS
 * budget; the in-flight market sweep stops LAST, under its own small budget.
 * Order matters: stopping the sweep first burns the shared drain budget on a
 * sweep wait that can run for minutes (a deploy lands mid-sweep 10-30% of the
 * time), and live conversations then get cut without their drain. The sweep
 * is abort-safe by design — the serving table is only touched inside the
 * atomic swap and the next sweep drops the half-filled staging table — so a
 * nearly-committed sweep gets a few dozen seconds, no more.
 */

import { waitForInFlightRequests } from './chat/shared.js';

/**
 * Own ceiling for the post-drain market-sweep stop, deliberately independent
 * of the shared drain budget. Adds to the total stop time beyond
 * SHUTDOWN_DRAIN_MS: systemd's TimeoutStopSec headroom above the drain (60s
 * by default, see deploy/systemd/eveai.service) covers it.
 */
export const MARKET_SWEEP_STOP_BUDGET_MS = 30_000;

/**
 * Await a promise but never past `deadlineMs`. A stalled shutdown step must not
 * eat the whole drain window and leave the supervisor to SIGKILL instead.
 */
export async function withDeadline(promise: Promise<unknown> | undefined, deadlineMs: number): Promise<void> {
  if (!promise) return;
  const remaining = Math.max(0, deadlineMs - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type DrainThenSweepStopResult = {
  /** Turns still running when the drain budget ran out; null when the drain
   * is disabled (drainMs = 0) and no wait happened at all. */
  turnsLeftAfterDrain: number | null;
};

export async function drainConversationsThenStopSweep(
  deps: {
    /** 0 disables the drain wait entirely. */
    drainMs: number;
    drainPollMs: number;
    /** Absolute end of the shared drain window (shutdown start + drainMs). */
    drainDeadlineMs: number;
    /** Combined in-flight turn counter across the chat and web lanes. */
    countInFlightTurns: () => number;
    stopMarketSweep: () => Promise<unknown> | void;
    /** Test seam; production uses MARKET_SWEEP_STOP_BUDGET_MS. */
    sweepStopBudgetMs?: number;
  },
): Promise<DrainThenSweepStopResult> {
  let turnsLeft: number | null = null;
  if (deps.drainMs > 0) {
    const remaining = Math.max(0, deps.drainDeadlineMs - Date.now());
    turnsLeft = await waitForInFlightRequests(remaining, deps.drainPollMs, deps.countInFlightTurns);
  }
  await withDeadline(
    Promise.resolve(deps.stopMarketSweep()),
    Date.now() + (deps.sweepStopBudgetMs ?? MARKET_SWEEP_STOP_BUDGET_MS),
  );
  return { turnsLeftAfterDrain: turnsLeft };
}
