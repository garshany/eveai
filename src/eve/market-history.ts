/**
 * Local per-type daily market price history.
 *
 * Storage: market_price_history holds one row per (region_id, type_id, date)
 * upserted from ESI /markets/{region_id}/history/ (the same endpoint
 * market-history-summary.ts reads through). CCP rebuilds that endpoint once a
 * day at 11:05 UTC, so a pair that synced successfully is not due again until
 * the next rebuild plus a propagation buffer; market_history_sync tracks that
 * schedule per pair. Accumulating rows locally lets the series outgrow ESI's
 * own ~365-day window over time.
 *
 * Backfill: getTypeHistory serves reads from the local table and only calls
 * ensureTypeHistorySynced when the pair has no sync row yet or its
 * next_due_at passed — so the first view of an item fetches once, a pair
 * whose fetch came back empty or failed stays parked until next_due_at, and
 * repeat views are pure SQLite. The hourly market-history-worker refreshes
 * due pairs in bulk.
 *
 * Errors are recorded, not thrown: a route-triggered backfill must still
 * answer with whatever local rows exist, so ensureTypeHistorySynced resolves
 * { synced, error? } and marks the pair status='error' with a 1-hour backoff
 * instead of propagating ESI/validation failures.
 */

import type { Db } from '../db/sqlite.js';
import { callEsiOperation, type EsiCallResult } from './esi-client.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// ESI serves roughly a year of daily rows; reject payloads far beyond that.
const MAX_HISTORY_ROWS = 500;
const DAY_MS = 86_400_000;
// CCP republishes the history endpoint at 11:05 UTC; the buffer covers cache
// propagation so a due pair re-fetches only once the fresh row is visible.
const DAILY_REBUILD_HOUR_UTC = 11;
const DAILY_REBUILD_MINUTE_UTC = 5;
const DAILY_REBUILD_BUFFER_MS = 15 * 60_000;
// On failure retry in an hour: ESI outages are short, and the next rebuild is
// a day away anyway, so there is no value in tighter retries.
const ERROR_BACKOFF_MS = 60 * 60_000;

export type HistoryPoint = {
  date: string; // YYYY-MM-DD, UTC calendar day
  order_count: number;
  volume: number;
  highest: number;
  average: number;
  lowest: number;
};

export type HistoryStats = {
  mean_average: number | null;
  median_average: number | null;
  // Population σ of day-over-day log returns on the average price, in
  // percent; null with fewer than two usable points.
  daily_log_return_stddev_percent: number | null;
  // Change of the average price versus the latest point on/before the target
  // day; null when the series does not reach that far back.
  change_7d_percent: number | null;
  change_30d_percent: number | null;
  change_90d_percent: number | null;
  mean_daily_volume: number | null;
  // Least-squares slope of the average price over UTC days (ISK/day).
  trend_slope_per_day: number | null;
};

export type HistoryFreshness = {
  last_synced_at: string | null;
  next_due_at: string | null;
  status: 'ok' | 'error' | null;
  error: string | null;
};

export type TypeHistoryResult = {
  region_id: number;
  type_id: number;
  series: HistoryPoint[];
  stats: HistoryStats;
  freshness: HistoryFreshness;
};

/**
 * One ESI history call for a pair. Production uses callEsiOperation
 * (esi_cache/ETag-backed, same as market-history-summary.ts); tests inject a
 * stub.
 */
export type MarketHistoryFetcher = (regionId: number, typeId: number) => Promise<EsiCallResult<unknown>>;

export type HistorySyncDeps = {
  fetchHistory?: MarketHistoryFetcher;
  now?: Date;
};

export type HistorySyncResult = { synced: boolean; error?: string };

type SyncRow = {
  last_synced_at: string | null;
  next_due_at: string | null;
  status: string | null;
  error: string | null;
};

function defaultFetcher(db: Db): MarketHistoryFetcher {
  return (regionId, typeId) => callEsiOperation(
    db,
    'get_markets_region_id_history',
    { region_id: regionId, type_id: typeId },
    null,
  );
}

/**
 * The next moment a successful sync turns due again: the upcoming 11:05 UTC
 * rebuild plus the propagation buffer. A sync landing between 11:05 and 11:20
 * UTC may have beaten the republication, so it stays due at 11:20 the same
 * day rather than skipping a day.
 */
export function nextDailyDueUtc(now: Date): Date {
  const due = new Date(now.getTime());
  due.setUTCHours(DAILY_REBUILD_HOUR_UTC, DAILY_REBUILD_MINUTE_UTC, 0, 0);
  due.setTime(due.getTime() + DAILY_REBUILD_BUFFER_MS);
  if (due.getTime() <= now.getTime()) {
    due.setTime(due.getTime() + DAY_MS);
  }
  return due;
}

// In-flight dedup for concurrent syncs of the same pair: route reads and the
// hourly worker can ask for the same (region, type) at once, and every caller
// beyond the first must join the pending sync instead of fanning out into a
// parallel ESI request. Same pattern as sessionCleanupInFlight in
// web-session.ts.
const syncInFlight = new Map<string, Promise<HistorySyncResult>>();

/**
 * Fetch the pair's ESI history, validate every row, upsert into
 * market_price_history and record the outcome in market_history_sync. Never
 * throws: failures land in the sync row with a backoff and resolve
 * { synced: false, error }. Concurrent calls for the same pair share one
 * in-flight sync.
 */
export async function ensureTypeHistorySynced(
  db: Db,
  regionId: number,
  typeId: number,
  deps: HistorySyncDeps = {},
): Promise<HistorySyncResult> {
  const key = `${regionId}:${typeId}`;
  const inFlight = syncInFlight.get(key);
  if (inFlight) return inFlight;
  const sync = runTypeHistorySync(db, regionId, typeId, deps).finally(() => {
    syncInFlight.delete(key);
  });
  syncInFlight.set(key, sync);
  return sync;
}

async function runTypeHistorySync(
  db: Db,
  regionId: number,
  typeId: number,
  deps: HistorySyncDeps,
): Promise<HistorySyncResult> {
  const now = deps.now ?? new Date();
  const fetchHistory = deps.fetchHistory ?? defaultFetcher(db);
  try {
    const response = await fetchHistory(regionId, typeId);
    if (!response.ok) {
      return recordSyncFailure(db, regionId, typeId, now, `ESI request failed with HTTP status ${response.status}.`);
    }
    const rows = parseHistoryRows(response.data);
    upsertHistoryRows(db, regionId, typeId, rows);
    db.prepare(`
      INSERT INTO market_history_sync (region_id, type_id, last_synced_at, next_due_at, status, error)
      VALUES (?, ?, ?, ?, 'ok', NULL)
      ON CONFLICT (region_id, type_id) DO UPDATE SET
        last_synced_at = excluded.last_synced_at,
        next_due_at = excluded.next_due_at,
        status = 'ok',
        error = NULL
    `).run(regionId, typeId, now.toISOString(), nextDailyDueUtc(now).toISOString());
    return { synced: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return recordSyncFailure(db, regionId, typeId, now, message);
  }
}

function recordSyncFailure(
  db: Db,
  regionId: number,
  typeId: number,
  now: Date,
  error: string,
): HistorySyncResult {
  // Keep any previous last_synced_at: it marks the data actually serving.
  db.prepare(`
    INSERT INTO market_history_sync (region_id, type_id, last_synced_at, next_due_at, status, error)
    VALUES (?, ?, NULL, ?, 'error', ?)
    ON CONFLICT (region_id, type_id) DO UPDATE SET
      next_due_at = excluded.next_due_at,
      status = 'error',
      error = excluded.error
  `).run(regionId, typeId, new Date(now.getTime() + ERROR_BACKOFF_MS).toISOString(), error);
  return { synced: false, error };
}

/**
 * Serve the pair's history from local storage, backfilling from ESI when the
 * pair has no sync row yet or its sync is due. opts.days bounds the returned
 * window (last N calendar days of stored rows); omitted returns everything.
 */
export async function getTypeHistory(
  db: Db,
  regionId: number,
  typeId: number,
  opts: { days?: number | null; deps?: HistorySyncDeps } = {},
): Promise<TypeHistoryResult> {
  const now = opts.deps?.now ?? new Date();
  if (needsHistorySync(db, regionId, typeId, now)) {
    await ensureTypeHistorySynced(db, regionId, typeId, opts.deps ?? {});
  }
  const series = readHistorySeries(db, regionId, typeId, opts.days ?? null);
  const sync = readSyncRow(db, regionId, typeId);
  return {
    region_id: regionId,
    type_id: typeId,
    series,
    stats: computeHistoryStats(series),
    freshness: {
      last_synced_at: sync?.last_synced_at ?? null,
      next_due_at: sync?.next_due_at ?? null,
      status: sync?.status === 'ok' || sync?.status === 'error' ? sync.status : null,
      error: sync?.error ?? null,
    },
  };
}

// The sync row alone decides whether to fetch: a pair with next_due_at in
// the future stays parked even when it has no rows (an empty ESI payload or
// the error backoff), while a pair with rows but no sync row — or a due or
// unscheduled (next_due_at NULL) one — syncs now.
function needsHistorySync(db: Db, regionId: number, typeId: number, now: Date): boolean {
  const sync = readSyncRow(db, regionId, typeId);
  if (sync?.next_due_at == null) return true;
  return sync.next_due_at <= now.toISOString();
}

function readHistorySeries(db: Db, regionId: number, typeId: number, days: number | null): HistoryPoint[] {
  const rows = db.prepare(`
    SELECT date, order_count, volume, highest, average, lowest
    FROM market_price_history
    WHERE region_id = ? AND type_id = ?
    ORDER BY date ASC
  `).all(regionId, typeId) as HistoryPoint[];
  return days !== null && days > 0 ? rows.slice(-days) : rows;
}

function readSyncRow(db: Db, regionId: number, typeId: number): SyncRow | undefined {
  return db.prepare(
    'SELECT last_synced_at, next_due_at, status, error FROM market_history_sync WHERE region_id = ? AND type_id = ?',
  ).get(regionId, typeId) as SyncRow | undefined;
}

function upsertHistoryRows(db: Db, regionId: number, typeId: number, rows: HistoryPoint[]): void {
  const statement = db.prepare(`
    INSERT INTO market_price_history (region_id, type_id, date, order_count, volume, highest, average, lowest, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (region_id, type_id, date) DO UPDATE SET
      order_count = excluded.order_count,
      volume = excluded.volume,
      highest = excluded.highest,
      average = excluded.average,
      lowest = excluded.lowest,
      synced_at = excluded.synced_at
  `);
  const upsertAll = db.transaction((points: HistoryPoint[]) => {
    for (const point of points) {
      statement.run(
        regionId,
        typeId,
        point.date,
        point.order_count,
        point.volume,
        point.highest,
        point.average,
        point.lowest,
      );
    }
  });
  upsertAll(rows);
}

// Same validation contract as market-history-summary.ts: every row must
// parse, dates must be real UTC calendar days, highest must cover lowest, and
// duplicate dates must not disagree. One bad row fails the fetch — partial
// payloads are never stored.
function parseHistoryRows(value: unknown): HistoryPoint[] {
  if (!Array.isArray(value)) throw new Error('history must be an array');
  if (value.length > MAX_HISTORY_ROWS) throw new Error('history exceeds row limit');
  const byDate = new Map<string, { raw: string; row: HistoryPoint }>();
  for (const valueRow of value) {
    const source = record(valueRow);
    const row: HistoryPoint = {
      date: calendarDate(source.date),
      order_count: nonNegativeSafeInteger(source.order_count),
      volume: nonNegativeSafeInteger(source.volume),
      highest: finiteNonNegative(source.highest),
      average: finiteNonNegative(source.average),
      lowest: finiteNonNegative(source.lowest),
    };
    if (row.highest < row.lowest) throw new Error('invalid price range');
    const raw = JSON.stringify(valueRow);
    const existing = byDate.get(row.date);
    if (existing && existing.raw !== raw) throw new Error('conflicting duplicate date');
    if (!existing) byDate.set(row.date, { raw, row });
  }
  return [...byDate.values()].map((entry) => entry.row);
}

/**
 * Aggregates over the stored daily points, sorted by date ascending. Every
 * field is null when the series is too short to support it, so callers can
 * render "недостаточно данных" instead of a bogus zero.
 */
export function computeHistoryStats(points: HistoryPoint[]): HistoryStats {
  if (points.length === 0) {
    return {
      mean_average: null,
      median_average: null,
      daily_log_return_stddev_percent: null,
      change_7d_percent: null,
      change_30d_percent: null,
      change_90d_percent: null,
      mean_daily_volume: null,
      trend_slope_per_day: null,
    };
  }

  const averages = points.map((point) => point.average);
  const mean = averages.reduce((sum, value) => sum + value, 0) / averages.length;
  const sorted = [...averages].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  // Log returns between consecutive stored points. Sparse series (missing
  // days) stretch the window; only positive prices can take a logarithm.
  const returns: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].average;
    const current = points[index].average;
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  let volatility: number | null = null;
  if (returns.length > 0) {
    const returnMean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - returnMean) ** 2, 0) / returns.length;
    volatility = round(Math.sqrt(variance) * 100);
  }

  let slope: number | null = null;
  if (points.length >= 2) {
    const x0 = dateToUtcMs(points[0].date);
    const xs = points.map((point) => (dateToUtcMs(point.date) - x0) / DAY_MS);
    const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < points.length; index += 1) {
      numerator += (xs[index] - xMean) * (averages[index] - mean);
      denominator += (xs[index] - xMean) ** 2;
    }
    if (denominator > 0) slope = round(numerator / denominator);
  }

  return {
    mean_average: round(mean),
    median_average: round(median),
    daily_log_return_stddev_percent: volatility,
    change_7d_percent: changeOverDays(points, 7),
    change_30d_percent: changeOverDays(points, 30),
    change_90d_percent: changeOverDays(points, 90),
    mean_daily_volume: round(points.reduce((sum, point) => sum + point.volume, 0) / points.length),
    trend_slope_per_day: slope,
  };
}

function changeOverDays(points: HistoryPoint[], days: number): number | null {
  const last = points.at(-1);
  if (!last || last.average <= 0) return null;
  const targetMs = dateToUtcMs(last.date) - days * DAY_MS;
  let base: HistoryPoint | null = null;
  for (const point of points) {
    if (dateToUtcMs(point.date) <= targetMs) base = point;
    else break; // ascending order: the last point on/before the target wins
  }
  if (!base || base.average <= 0) return null;
  return round((last.average / base.average - 1) * 100);
}

function dateToUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function round(value: number): number {
  if (!Number.isFinite(value)) throw new Error('non-finite result');
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid date');
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error('invalid date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('invalid date');
  }
  return value;
}

function finiteNonNegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid number');
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid integer');
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('expected plain object');
  return value;
}
