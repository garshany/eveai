/**
 * Market snapshot worker -- keeps the local market_orders table in sync with
 * the public ESI order books of every k-space trade region.
 *
 * Tick (every 5 minutes): hand the SDE trade-region list and a direct ESI page
 * fetcher to the loader. The loader refetches only regions whose tier interval
 * elapsed (two-tier freshness by page count, intervals via env) and carries
 * the rest over locally, so a tick with nothing due is a cheap no-op making
 * zero ESI calls. Sweep failures are recorded in market_snapshot_state and
 * leave the previous snapshot serving (tools report its growing age as
 * `stale`).
 *
 * Single-flight: one sweep at a time across BOTH entry points (cron tick and
 * boot timer). Croner's `protect: true` only serializes its own schedule and
 * knows nothing about the boot timer — two concurrent sweeps would drop and
 * refill the same staging table under each other, and the cold snapshot would
 * never finish. A tick that finds a sweep in flight returns immediately
 * instead of queueing: the next tick is five minutes away anyway.
 *
 * Restart survival: state lives in SQLite (market_snapshot_state +
 * market_snapshot_regions). On boot, when the table is empty or no sweep ever
 * completed, the worker schedules an immediate sweep (jittered) instead of
 * waiting for the first cron tick.
 *
 * Shutdown: stop() kills the timer and the schedule, then waits for the
 * in-flight sweep to commit or abort. app.ts bounds that wait with the shared
 * shutdown deadline; if the deadline wins and the process exits mid-sweep,
 * nothing is lost — the serving table is only touched inside the atomic swap
 * and the next sweep drops the half-filled staging table.
 */

import { Cron } from 'croner';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import {
  createEsiOrdersPageFetcher,
  getMarketSnapshotState,
  loadMarketSnapshotFromEsi,
  recordSnapshotError,
  type LoadMarketSnapshotOptions,
} from './market-snapshot-loader.js';
import { loadTradeRegions } from './market-wide-summary.js';

const MARKET_SNAPSHOT_CRON = '*/5 * * * *';
const BOOT_LOAD_DELAY_MS = 15_000;
const BOOT_LOAD_JITTER_MS = 15_000;

let cronJob: Cron | null = null;
let bootTimer: NodeJS.Timeout | null = null;
// The single-flight guard for both sweep entry points; see the module header.
let sweepInFlight: Promise<void> | null = null;

export type MarketSnapshotTickDeps = LoadMarketSnapshotOptions;

function defaultDeps(db: Db): MarketSnapshotTickDeps {
  return {
    regions: loadTradeRegions(db),
    fetchPage: createEsiOrdersPageFetcher(),
    batchSize: config.marketSnapshot.batchSize,
    majorMinPages: config.marketSnapshot.majorMinPages,
    majorIntervalMinutes: config.marketSnapshot.majorIntervalMinutes,
    minorIntervalMinutes: config.marketSnapshot.minorIntervalMinutes,
  };
}

export function startMarketSnapshotWorker(db: Db): void {
  if (!config.marketSnapshot.enabled) {
    console.log('[market-snapshot] Worker disabled (MARKET_SNAPSHOT_ENABLED=false)');
    return;
  }
  console.log('[market-snapshot] Starting market snapshot worker');

  cronJob = new Cron(MARKET_SNAPSHOT_CRON, { protect: true }, async () => {
    try {
      await runMarketSnapshotTick(db);
    } catch (err) {
      // The tick records its own failures; this guards against anything unexpected.
      console.error('[market-snapshot] tick error:', err);
    }
  });

  // Cold start: until the first sweep the market tools answer ok:false, so do
  // not sit out the first cron interval. Jittered so a fleet restart does not
  // hit ESI in lockstep.
  const hasRows = db.prepare('SELECT 1 FROM market_orders LIMIT 1').get() !== undefined;
  const state = getMarketSnapshotState(db);
  if (!hasRows || state?.snapshot_time == null) {
    const delay = BOOT_LOAD_DELAY_MS + Math.floor(Math.random() * BOOT_LOAD_JITTER_MS);
    bootTimer = setTimeout(() => {
      bootTimer = null;
      runMarketSnapshotTick(db).catch((err) => {
        console.error('[market-snapshot] boot sweep error:', err);
      });
    }, delay);
    bootTimer.unref();
  }
}

export async function stopMarketSnapshotWorker(): Promise<void> {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  // Wait for the in-flight sweep to finish (bounded by the caller's shutdown
  // deadline) instead of abandoning a commit that may be seconds away. The
  // sweep itself is abort-safe: see the module header.
  await sweepInFlight?.catch(() => {});
  console.log('[market-snapshot] Stopped');
}

export async function runMarketSnapshotTick(db: Db, deps: MarketSnapshotTickDeps = defaultDeps(db)): Promise<void> {
  if (sweepInFlight) {
    // A sweep is already running (cron tick or boot timer): skip rather than
    // queue — the next cron tick is five minutes away regardless.
    console.log('[market-snapshot] Sweep already in flight; skipping this tick');
    return;
  }
  const sweep = sweepOnce(db, deps);
  sweepInFlight = sweep;
  try {
    await sweep;
  } finally {
    if (sweepInFlight === sweep) sweepInFlight = null;
  }
}

async function sweepOnce(db: Db, deps: MarketSnapshotTickDeps): Promise<void> {
  try {
    if (deps.regions.length === 0) {
      recordSnapshotError(db, 'Local SDE has no stargate geography; cannot determine k-space trade regions.');
      return;
    }
    const startedAt = Date.now();
    const result = await loadMarketSnapshotFromEsi(db, deps);
    if (!result.swept) {
      return; // No region was due; zero ESI calls made.
    }
    console.log(
      '[market-snapshot] Sweep committed: %d rows in %ds (%d regions fetched, %d carried over, %d malformed skipped)',
      result.rowsLoaded,
      Math.round((Date.now() - startedAt) / 1000),
      result.regionsFetched,
      result.regionsCarriedOver,
      result.malformedRows,
    );
    for (const failure of result.regionErrors) {
      console.error('[market-snapshot] region %d keeps previous rows: %s', failure.regionId, failure.error);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordSnapshotError(db, message);
    console.error('[market-snapshot] sweep failed, keeping previous snapshot:', message);
  }
}
