/**
 * Market history worker -- keeps market_price_history fresh for watched and
 * high-turnover region/type pairs.
 *
 * Tick (every hour): (a) seed market_history_sync with pairs worth tracking —
 * every market_watchlist entry (region_id NULL falls back to the configured
 * default region) plus the top-N types by listed value in major regions
 * (major = pages >= marketSnapshot.majorMinPages in market_snapshot_regions,
 * the same classifier the snapshot sweep uses); brand-new pairs are due
 * immediately, existing pairs keep their schedule. The top-N seed scans all
 * of market_orders (GROUP BY + ORDER BY SUM over ~1.6M rows) while the
 * orders behind it only change daily, so it runs at most once per
 * topTypesSeedIntervalMs; the cheap watchlist seed runs on every tick.
 * (b) take the oldest due pairs up to maxPerTick and refresh them through
 * ensureTypeHistorySynced with bounded concurrency.
 *
 * A tick with nothing due is two cheap SELECTs and zero ESI calls. CCP
 * rebuilds the history endpoint once a day at 11:05 UTC, so a steady state
 * has each tracked pair due once a day and the hourly cadence exists to
 * drain that set gently (and to retry the 1-hour error backoff).
 *
 * Single-flight: one tick at a time across BOTH entry points (cron schedule
 * and boot timer) — croner's `protect: true` only serializes its own
 * schedule. A tick that finds one in flight returns immediately instead of
 * queueing: the next tick is an hour away anyway. Same contract as
 * market-snapshot.ts.
 *
 * Shutdown: stop() kills the timer and the schedule, then waits for the
 * in-flight tick. Every pair commits independently inside the tick, so a
 * mid-tick exit loses at most the unprocessed remainder of that tick's due
 * list — those pairs simply stay due for the next process.
 */

import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import {
  ensureTypeHistorySynced,
  type HistorySyncDeps,
  type MarketHistoryFetcher,
} from './market-history.js';

// Minute 7: off the :00/:05 cluster where the snapshot sweep's own ticks land.
const MARKET_HISTORY_CRON = '7 * * * *';
// Later than the snapshot boot sweep (15s): the top-types seed reads
// market_orders, which only fills once the first snapshot sweep commits.
const BOOT_TICK_DELAY_MS = 60_000;
const BOOT_TICK_JITTER_MS = 60_000;
// The top-types seed is a full scan over market_orders; the snapshot data
// behind it changes daily, so re-running it on every hourly tick is waste.
const TOP_TYPES_SEED_INTERVAL_MS = 24 * 60 * 60_000;

let cronJob: Cron | null = null;
let bootTimer: NodeJS.Timeout | null = null;
// The single-flight guard for both tick entry points; see the module header.
let tickInFlight: Promise<void> | null = null;
// getTime() of the last top-types seed, or null before the first one.
// Process-local by design: a restart simply re-seeds on its first tick.
let lastTopTypesSeedAt: number | null = null;

export type MarketHistoryTickDeps = HistorySyncDeps & {
  maxPerTick: number;
  concurrency: number;
  seedTopTypes: number;
  defaultRegionId: number;
  majorMinPages: number;
  // Minimum gap between two top-types seeds; the watchlist seed is unaffected.
  topTypesSeedIntervalMs: number;
};

function defaultDeps(): MarketHistoryTickDeps {
  return {
    maxPerTick: config.marketHistory.maxPerTick,
    concurrency: config.marketHistory.concurrency,
    seedTopTypes: config.marketHistory.seedTopTypes,
    defaultRegionId: config.market.defaultRegionId,
    majorMinPages: config.marketSnapshot.majorMinPages,
    topTypesSeedIntervalMs: TOP_TYPES_SEED_INTERVAL_MS,
  };
}

export function startMarketHistoryWorker(db: Db): void {
  if (!config.marketHistory.enabled) {
    console.log('[market-history] Worker disabled (MARKET_HISTORY_ENABLED=false)');
    return;
  }
  console.log('[market-history] Starting market history worker');

  cronJob = new Cron(MARKET_HISTORY_CRON, { protect: true }, async () => {
    try {
      await runMarketHistoryTick(db);
    } catch (err) {
      // Pair-level failures are recorded in market_history_sync; this guards
      // against anything unexpected at the tick level.
      console.error('[market-history] tick error:', err);
    }
  });

  // Cold start: the first cron tick can be an hour out, and a restart should
  // not leave yesterday's backlog waiting that long. Jittered so a fleet
  // restart does not hit ESI in lockstep. A tick with nothing due is a cheap
  // no-op making zero ESI calls.
  const delay = BOOT_TICK_DELAY_MS + Math.floor(Math.random() * BOOT_TICK_JITTER_MS);
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runMarketHistoryTick(db).catch((err) => {
      console.error('[market-history] boot tick error:', err);
    });
  }, delay);
  bootTimer.unref();
}

export async function stopMarketHistoryWorker(): Promise<void> {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  // Wait for the in-flight tick to finish (bounded by the caller's shutdown
  // deadline) instead of abandoning pairs mid-upsert.
  await tickInFlight?.catch(() => {});
  lastTopTypesSeedAt = null;
  console.log('[market-history] Stopped');
}

export async function runMarketHistoryTick(
  db: Db,
  deps: Partial<MarketHistoryTickDeps> = {},
): Promise<void> {
  if (tickInFlight) {
    // A tick is already running (cron or boot timer): skip rather than queue —
    // the next cron tick is an hour away regardless.
    console.log('[market-history] Tick already in flight; skipping this tick');
    return;
  }
  const tick = tickOnce(db, { ...defaultDeps(), ...deps });
  tickInFlight = tick;
  try {
    await tick;
  } finally {
    if (tickInFlight === tick) tickInFlight = null;
  }
}

async function tickOnce(db: Db, deps: MarketHistoryTickDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const seeded = seedHistorySync(db, deps, now, nowIso);
  const due = selectDuePairs(db, nowIso, deps.maxPerTick);
  if (due.length === 0) {
    if (seeded > 0) {
      console.log('[market-history] Tick: seeded %d pair(s), none due yet', seeded);
    }
    return;
  }

  let synced = 0;
  let failed = 0;
  // Same bounded worker-pool shape as market-wide-summary.ts's mapPool.
  const fetchHistory: MarketHistoryFetcher | undefined = deps.fetchHistory;
  await mapPool(due, deps.concurrency, async (pair) => {
    const result = await ensureTypeHistorySynced(db, pair.region_id, pair.type_id, {
      fetchHistory,
      now,
    });
    if (result.synced) synced += 1;
    else failed += 1;
  });
  console.log(
    '[market-history] Tick: %d synced, %d failed (%d due, %d seeded)',
    synced,
    failed,
    due.length,
    seeded,
  );
}

function seedHistorySync(db: Db, deps: MarketHistoryTickDeps, now: Date, nowIso: string): number {
  // ON CONFLICT DO NOTHING: seeding only ever schedules pairs that are not
  // tracked yet; an existing pair keeps its own next_due_at and error state.
  // New rows carry next_due_at = now so they sync on this very tick.
  const watchlistSeeded = db.prepare(`
    INSERT INTO market_history_sync (region_id, type_id, next_due_at)
    SELECT COALESCE(w.region_id, ?), w.type_id, ?
    FROM market_watchlist w
    WHERE true
    ON CONFLICT (region_id, type_id) DO NOTHING
  `).run(deps.defaultRegionId, nowIso).changes;

  if (deps.seedTopTypes <= 0) return watchlistSeeded;
  // The top-types half is the expensive query (see the module header): skip
  // it while the previous seed is younger than the configured interval. The
  // stamp is taken on the attempt, so even a failing scan does not re-run
  // every tick.
  const nowMs = now.getTime();
  if (lastTopTypesSeedAt !== null && nowMs - lastTopTypesSeedAt < deps.topTypesSeedIntervalMs) {
    return watchlistSeeded;
  }
  lastTopTypesSeedAt = nowMs;
  const topTypesSeeded = db.prepare(`
    INSERT INTO market_history_sync (region_id, type_id, next_due_at)
    SELECT o.region_id, o.type_id, ?
    FROM market_orders o
    JOIN market_snapshot_regions r ON r.region_id = o.region_id
    WHERE r.pages >= ?
    GROUP BY o.region_id, o.type_id
    ORDER BY SUM(o.volume_remain * o.price) DESC
    LIMIT ?
    ON CONFLICT (region_id, type_id) DO NOTHING
  `).run(nowIso, deps.majorMinPages, deps.seedTopTypes).changes;
  return watchlistSeeded + topTypesSeeded;
}

function selectDuePairs(
  db: Db,
  nowIso: string,
  limit: number,
): Array<{ region_id: number; type_id: number }> {
  return db.prepare(`
    SELECT region_id, type_id
    FROM market_history_sync
    WHERE next_due_at IS NOT NULL AND next_due_at <= ?
    ORDER BY next_due_at ASC
    LIMIT ?
  `).all(nowIso, limit) as Array<{ region_id: number; type_id: number }>;
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
