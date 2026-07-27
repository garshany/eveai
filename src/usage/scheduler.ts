import type { Db } from '../db/sqlite.js';
import { rollupUsageEvents } from './rollup.js';

/** Hourly is plenty: daily aggregates trail reality by at most an hour plus a
 * UTC day boundary, and the public page reads daily rows plus today's raw
 * tail regardless of when the last rollup ran. */
export const USAGE_ROLLUP_INTERVAL_MS = 3_600_000;

/**
 * Runs once at startup (so a long-stopped instance catches up immediately)
 * and then on a fixed interval. Returns the stop function for shutdown.
 * A failed rollup is logged and retried next tick — it must never crash the
 * process, just like the accounting write itself.
 */
export function startUsageRollupScheduler(
  db: Db,
  intervalMs: number = USAGE_ROLLUP_INTERVAL_MS,
): () => void {
  const run = () => {
    try {
      const result = rollupUsageEvents(db);
      if (result.rolledEvents > 0 || result.prunedEvents > 0) {
        console.log(
          '[usage] rollup: days=%d events=%d pruned=%d',
          result.rolledDays,
          result.rolledEvents,
          result.prunedEvents,
        );
      }
    } catch (error) {
      console.error('[usage] rollup failed: %s', error instanceof Error ? error.message : error);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
