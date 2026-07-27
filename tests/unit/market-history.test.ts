import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  computeHistoryStats,
  ensureTypeHistorySynced,
  getTypeHistory,
  nextDailyDueUtc,
  type HistoryPoint,
  type MarketHistoryFetcher,
} from '../../src/eve/market-history.js';

const FORGE = 10000002;
const TRITANIUM = 34;
const PYERITE = 35;
const T0 = new Date('2026-07-27T10:00:00.000Z');
const DAY_MS = 86_400_000;

// The market tables land in schema.ts in parallel with this change (plan
// phase 1); create-if-missing keeps this suite green on either ordering. The
// DDL mirrors the landed schema (status defaults to 'ok', never-synced pairs
// are told apart by last_synced_at IS NULL).
const MARKET_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS market_price_history (
  region_id   INTEGER NOT NULL,
  type_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,
  order_count INTEGER NOT NULL,
  volume      INTEGER NOT NULL,
  highest     REAL NOT NULL,
  average     REAL NOT NULL,
  lowest      REAL NOT NULL,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (region_id, type_id, date)
);
CREATE TABLE IF NOT EXISTS market_history_sync (
  region_id      INTEGER NOT NULL,
  type_id        INTEGER NOT NULL,
  last_synced_at TEXT,
  next_due_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'error')),
  error          TEXT,
  PRIMARY KEY (region_id, type_id)
);
CREATE INDEX IF NOT EXISTS idx_market_history_sync_due
  ON market_history_sync(next_due_at);
CREATE TABLE IF NOT EXISTS market_watchlist (
  user_id    INTEGER NOT NULL,
  type_id    INTEGER NOT NULL,
  region_id  INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, type_id, region_id)
);
`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(MARKET_HISTORY_DDL);
});

afterEach(() => {
  db.close();
});

function makeEsiRow(date: string, average: number, overrides: Record<string, unknown> = {}) {
  return {
    date,
    average,
    highest: Math.round(average * 1.1 * 100) / 100,
    lowest: Math.round(average * 0.9 * 100) / 100,
    order_count: 120,
    volume: 50_000,
    ...overrides,
  };
}

function okFetcher(rows: unknown[]): MarketHistoryFetcher {
  return vi.fn(async () => ({
    ok: true as const,
    status: 200,
    data: rows,
    cached: false,
    headers: {},
  }));
}

function makePoints(days: number, startAverage: number, dailyStep = 0): HistoryPoint[] {
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  return Array.from({ length: days }, (_, index) => {
    const average = startAverage + dailyStep * index;
    return {
      date: new Date(start + index * DAY_MS).toISOString().slice(0, 10),
      order_count: 100 + index,
      volume: 1_000 * (index + 1),
      highest: average + 5,
      average,
      lowest: average - 5,
    };
  });
}

function syncRow(regionId = FORGE, typeId = TRITANIUM) {
  return db.prepare(
    'SELECT last_synced_at, next_due_at, status, error FROM market_history_sync WHERE region_id = ? AND type_id = ?',
  ).get(regionId, typeId) as
    | { last_synced_at: string | null; next_due_at: string | null; status: string | null; error: string | null }
    | undefined;
}

function historyCount(regionId = FORGE, typeId = TRITANIUM): number {
  return (db.prepare(
    'SELECT COUNT(*) AS c FROM market_price_history WHERE region_id = ? AND type_id = ?',
  ).get(regionId, typeId) as { c: number }).c;
}

describe('ensureTypeHistorySynced', () => {
  it('upserts rows and stays idempotent across repeated syncs', async () => {
    const rows = [
      makeEsiRow('2026-07-25', 100),
      makeEsiRow('2026-07-26', 101),
      makeEsiRow('2026-07-27', 102),
    ];
    const fetchHistory = okFetcher(rows);
    const first = await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory, now: T0 });
    expect(first).toEqual({ synced: true });
    expect(historyCount()).toBe(3);

    // The same payload again must not duplicate rows.
    await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory, now: T0 });
    expect(historyCount()).toBe(3);

    // A changed payload updates the stored row in place (UPSERT DO UPDATE).
    await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, {
      fetchHistory: okFetcher([makeEsiRow('2026-07-27', 130)]),
      now: T0,
    });
    expect(historyCount()).toBe(3);
    const stored = db.prepare(
      "SELECT average FROM market_price_history WHERE region_id = ? AND type_id = ? AND date = '2026-07-27'",
    ).get(FORGE, TRITANIUM) as { average: number };
    expect(stored.average).toBe(130);
  });

  it('schedules the next sync at the daily rebuild plus the propagation buffer', async () => {
    const fetchHistory = okFetcher([makeEsiRow('2026-07-27', 100)]);
    await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory, now: T0 });
    expect(syncRow()).toEqual({
      last_synced_at: T0.toISOString(),
      next_due_at: '2026-07-27T11:20:00.000Z',
      status: 'ok',
      error: null,
    });

    // A sync after today's buffer rolls the pair to tomorrow's rebuild.
    await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, {
      fetchHistory,
      now: new Date('2026-07-27T12:00:00.000Z'),
    });
    expect(syncRow()?.next_due_at).toBe('2026-07-28T11:20:00.000Z');
  });

  it('records an HTTP failure with a 1-hour backoff instead of throwing', async () => {
    const failing: MarketHistoryFetcher = vi.fn(async () => ({
      ok: false as const,
      status: 503,
      error: 'upstream unavailable',
    }));
    const result = await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory: failing, now: T0 });
    expect(result.synced).toBe(false);
    expect(result.error).toContain('503');
    expect(syncRow()).toEqual({
      last_synced_at: null,
      next_due_at: new Date(T0.getTime() + 3_600_000).toISOString(),
      status: 'error',
      error: 'ESI request failed with HTTP status 503.',
    });
    expect(historyCount()).toBe(0);
  });

  it('records a fetcher exception as an error without propagating it', async () => {
    const throwing: MarketHistoryFetcher = vi.fn(async () => {
      throw new Error('socket reset');
    });
    const result = await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory: throwing, now: T0 });
    expect(result).toEqual({ synced: false, error: 'socket reset' });
    expect(syncRow()?.status).toBe('error');
    expect(syncRow()?.error).toBe('socket reset');
  });

  it('rejects a malformed payload without storing partial rows', async () => {
    // highest below lowest violates the price-range invariant.
    const bad = okFetcher([makeEsiRow('2026-07-27', 100, { highest: 50 })]);
    const result = await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory: bad, now: T0 });
    expect(result.synced).toBe(false);
    expect(historyCount()).toBe(0);
    expect(syncRow()?.status).toBe('error');
  });

  it('keeps last_synced_at from a previous success when a later sync fails', async () => {
    await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, {
      fetchHistory: okFetcher([makeEsiRow('2026-07-27', 100)]),
      now: T0,
    });
    const failing: MarketHistoryFetcher = vi.fn(async () => ({ ok: false as const, status: 500, error: 'boom' }));
    const later = new Date('2026-07-28T12:00:00.000Z');
    await ensureTypeHistorySynced(db as Db, FORGE, TRITANIUM, { fetchHistory: failing, now: later });
    expect(syncRow()?.last_synced_at).toBe(T0.toISOString());
    expect(syncRow()?.status).toBe('error');
    expect(historyCount()).toBe(1); // previous rows keep serving
  });
});

describe('nextDailyDueUtc', () => {
  it('points to 11:20 UTC the same day before the rebuild buffer elapses', () => {
    expect(nextDailyDueUtc(new Date('2026-07-27T10:00:00.000Z')).toISOString()).toBe('2026-07-27T11:20:00.000Z');
    expect(nextDailyDueUtc(new Date('2026-07-27T00:00:00.000Z')).toISOString()).toBe('2026-07-27T11:20:00.000Z');
  });

  it('re-checks at 11:20 when the sync lands inside the rebuild window', () => {
    expect(nextDailyDueUtc(new Date('2026-07-27T11:10:00.000Z')).toISOString()).toBe('2026-07-27T11:20:00.000Z');
  });

  it('rolls to the next day once the buffer passed', () => {
    expect(nextDailyDueUtc(new Date('2026-07-27T11:20:00.000Z')).toISOString()).toBe('2026-07-28T11:20:00.000Z');
    expect(nextDailyDueUtc(new Date('2026-07-27T23:30:00.000Z')).toISOString()).toBe('2026-07-28T11:20:00.000Z');
  });

  it('rolls across month and year boundaries', () => {
    expect(nextDailyDueUtc(new Date('2026-07-31T12:00:00.000Z')).toISOString()).toBe('2026-08-01T11:20:00.000Z');
    expect(nextDailyDueUtc(new Date('2026-12-31T23:00:00.000Z')).toISOString()).toBe('2027-01-01T11:20:00.000Z');
  });
});

describe('computeHistoryStats', () => {
  it('returns all-null stats for an empty series', () => {
    expect(computeHistoryStats([])).toEqual({
      mean_average: null,
      median_average: null,
      daily_log_return_stddev_percent: null,
      change_7d_percent: null,
      change_30d_percent: null,
      change_90d_percent: null,
      mean_daily_volume: null,
      trend_slope_per_day: null,
    });
  });

  it('marks windowed changes null when the series is shorter than the window', () => {
    const stats = computeHistoryStats(makePoints(4, 100));
    expect(stats.change_7d_percent).toBeNull();
    expect(stats.change_30d_percent).toBeNull();
    expect(stats.change_90d_percent).toBeNull();
    expect(stats.mean_average).toBe(100);
    expect(stats.median_average).toBe(100);
    // A flat price has zero log-return spread and zero slope.
    expect(stats.daily_log_return_stddev_percent).toBe(0);
    expect(stats.trend_slope_per_day).toBe(0);
  });

  it('computes mean, trend, windowed change and volatility over a growing series', () => {
    // Eight days, average climbing exactly 1 ISK/day from 100 to 107.
    const stats = computeHistoryStats(makePoints(8, 100, 1));
    expect(stats.mean_average).toBe(103.5);
    expect(stats.median_average).toBe(103.5);
    expect(stats.trend_slope_per_day).toBe(1);
    // Last point 107 versus the point at last-7d (the first, 100).
    expect(stats.change_7d_percent).toBe(7);
    expect(stats.change_30d_percent).toBeNull();
    expect(stats.change_90d_percent).toBeNull();
    expect(stats.mean_daily_volume).toBe(4_500);
    expect(stats.daily_log_return_stddev_percent).toBeGreaterThan(0);
  });

  it('handles a single point without crashing', () => {
    const stats = computeHistoryStats(makePoints(1, 42));
    expect(stats.mean_average).toBe(42);
    expect(stats.median_average).toBe(42);
    expect(stats.daily_log_return_stddev_percent).toBeNull();
    expect(stats.trend_slope_per_day).toBeNull();
    expect(stats.change_7d_percent).toBeNull();
  });
});

describe('getTypeHistory', () => {
  it('backfills from ESI on first read and serves repeats from storage', async () => {
    const fetchHistory = okFetcher([
      makeEsiRow('2026-07-26', 100),
      makeEsiRow('2026-07-27', 110),
    ]);
    const first = await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(first.region_id).toBe(FORGE);
    expect(first.type_id).toBe(TRITANIUM);
    expect(first.series.map((point) => point.date)).toEqual(['2026-07-26', '2026-07-27']);
    expect(first.stats.mean_average).toBe(105);
    expect(first.freshness).toEqual({
      last_synced_at: T0.toISOString(),
      next_due_at: '2026-07-27T11:20:00.000Z',
      status: 'ok',
      error: null,
    });

    const second = await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    expect(fetchHistory).toHaveBeenCalledTimes(1); // not due yet: pure SQLite read
    expect(second.series).toHaveLength(2);
  });

  it('re-syncs once next_due_at passed', async () => {
    const fetchHistory = okFetcher([makeEsiRow('2026-07-27', 100)]);
    await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    await getTypeHistory(db as Db, FORGE, TRITANIUM, {
      deps: { fetchHistory, now: new Date('2026-07-28T12:00:00.000Z') },
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it('bounds the returned window with days', async () => {
    const fetchHistory = okFetcher([
      makeEsiRow('2026-07-01', 100),
      makeEsiRow('2026-07-02', 101),
      makeEsiRow('2026-07-03', 102),
    ]);
    const result = await getTypeHistory(db as Db, FORGE, TRITANIUM, { days: 2, deps: { fetchHistory, now: T0 } });
    expect(result.series.map((point) => point.date)).toEqual(['2026-07-02', '2026-07-03']);
  });

  it('answers with empty local data when the backfill fails', async () => {
    const failing: MarketHistoryFetcher = vi.fn(async () => ({ ok: false as const, status: 500, error: 'boom' }));
    const result = await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory: failing, now: T0 } });
    expect(result.series).toEqual([]);
    expect(result.stats.mean_average).toBeNull();
    expect(result.freshness.status).toBe('error');
    expect(result.freshness.error).toContain('500');
  });

  it('treats an empty ESI payload as a successful sync', async () => {
    const fetchHistory = okFetcher([]);
    const result = await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    expect(result.series).toEqual([]);
    expect(result.freshness.status).toBe('ok');
  });

  it('keeps an empty-success pair parked until next_due_at instead of re-fetching', async () => {
    const fetchHistory = okFetcher([]);
    await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    // Still before the 11:20 UTC due time: no rows, but the sync row rules.
    const parked = await getTypeHistory(db as Db, FORGE, TRITANIUM, {
      deps: { fetchHistory, now: new Date('2026-07-27T11:00:00.000Z') },
    });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(parked.series).toEqual([]);

    // Once next_due_at passed the pair re-fetches.
    await getTypeHistory(db as Db, FORGE, TRITANIUM, {
      deps: { fetchHistory, now: new Date('2026-07-27T11:30:00.000Z') },
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it('honors the 1-hour error backoff before re-fetching a failed pair', async () => {
    const failing: MarketHistoryFetcher = vi.fn(async () => ({ ok: false as const, status: 503, error: 'down' }));
    await getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory: failing, now: T0 } });
    expect(failing).toHaveBeenCalledTimes(1);

    // Thirty minutes into the backoff: the pair must not hit ESI again.
    await getTypeHistory(db as Db, FORGE, TRITANIUM, {
      deps: { fetchHistory: failing, now: new Date(T0.getTime() + 30 * 60_000) },
    });
    expect(failing).toHaveBeenCalledTimes(1);

    // Past the backoff hour the pair retries.
    await getTypeHistory(db as Db, FORGE, TRITANIUM, {
      deps: { fetchHistory: failing, now: new Date(T0.getTime() + 61 * 60_000) },
    });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent syncs of the same pair into one ESI request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchHistory: MarketHistoryFetcher = vi.fn(async () => {
      await gate;
      return { ok: true as const, status: 200, data: [makeEsiRow('2026-07-27', 100)], cached: false, headers: {} };
    });
    const first = getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    const second = getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } });
    await new Promise((resolve) => setImmediate(resolve)); // let both callers reach the sync
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(firstResult.series).toHaveLength(1);
    expect(secondResult.series).toHaveLength(1);
  });

  it('does not deduplicate concurrent syncs of different pairs', async () => {
    const fetchHistory = okFetcher([makeEsiRow('2026-07-27', 100)]);
    await Promise.all([
      getTypeHistory(db as Db, FORGE, TRITANIUM, { deps: { fetchHistory, now: T0 } }),
      getTypeHistory(db as Db, FORGE, PYERITE, { deps: { fetchHistory, now: T0 } }),
    ]);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });
});
