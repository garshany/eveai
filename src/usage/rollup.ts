import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';

export const DAY_MS = 86_400_000;

export function startOfUtcDayMs(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

/** UTC calendar day, YYYY-MM-DD. All usage bucketing is UTC on purpose. */
export function utcDayString(dayStartMs: number): string {
  return new Date(dayStartMs).toISOString().slice(0, 10);
}

export type RollupResult = {
  rolledDays: number;
  rolledEvents: number;
  prunedEvents: number;
};

/**
 * Refresh usage_daily from raw events for every day older than today (UTC),
 * then prune raw events past the retention window.
 *
 * Each affected day is rebuilt wholesale (delete + re-aggregate), so re-runs
 * are idempotent and a late event for an already-rolled day (a turn finishing
 * past midnight) simply corrects the day on the next run. Raw events are NOT
 * deleted by the rollup itself — they stay available for the full retention
 * window and are removed only by age. usage_daily rows are never deleted.
 */
export function rollupUsageEvents(
  db: Db,
  nowMs: number = Date.now(),
  retentionDays: number = config.usage.retentionDays,
): RollupResult {
  const todayStart = startOfUtcDayMs(nowMs);
  const tx = db.transaction(() => {
    // CAST is load-bearing: better-sqlite3 binds JS numbers as REAL, and a
    // REAL divisor turns SQLite's integer division into float division —
    // every event would land in its own fractional "bucket".
    const buckets = db.prepare(`
      SELECT DISTINCT CAST(created_at_ms / ? AS INTEGER) AS bucket
      FROM usage_events
      WHERE created_at_ms < ?
    `).all(DAY_MS, todayStart) as Array<{ bucket: number }>;

    let rolledEvents = 0;
    let rolledDays = 0;
    for (const { bucket } of buckets) {
      const dayStart = bucket * DAY_MS;
      const day = utcDayString(dayStart);
      const counted = db.prepare(
        'SELECT COUNT(*) AS n FROM usage_events WHERE created_at_ms >= ? AND created_at_ms < ?',
      ).get(dayStart, dayStart + DAY_MS) as { n: number };
      const stored = db.prepare(
        'SELECT COALESCE(SUM(events), 0) AS n FROM usage_daily WHERE day = ?',
      ).get(day) as { n: number };
      // Pruning only ever removes events and late events only ever add them,
      // so fewer raw events than already summarized means the day lost rows
      // to retention (e.g. a legacy unaligned prune). Never rebuild a
      // summary from a partially pruned day — that would shrink history.
      if (counted.n < stored.n) continue;
      db.prepare('DELETE FROM usage_daily WHERE day = ?').run(day);
      db.prepare(`
        INSERT INTO usage_daily (
          day, channel, model, user_id, events,
          input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens,
          cost_micros, unknown_cost_events
        )
        SELECT
          ?, channel, model, user_id, COUNT(*),
          SUM(input_tokens), SUM(output_tokens), SUM(cached_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens),
          COALESCE(SUM(cost_micros), 0), SUM(cost_micros IS NULL)
        FROM usage_events
        WHERE created_at_ms >= ? AND created_at_ms < ?
        GROUP BY channel, model, user_id
      `).run(day, dayStart, dayStart + DAY_MS);
      rolledEvents += counted.n;
      rolledDays += 1;
    }

    // Prune whole UTC days only: a cutoff inside a day would leave that day
    // partially pruned, and its summary must never be rebuilt from leftovers.
    const pruneBeforeMs = todayStart - retentionDays * DAY_MS;
    const pruned = db.prepare('DELETE FROM usage_events WHERE created_at_ms < ?').run(pruneBeforeMs);
    return { rolledDays, rolledEvents, prunedEvents: Number(pruned.changes) };
  });
  return tx();
}
