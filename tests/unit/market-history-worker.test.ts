import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import type { MarketHistoryFetcher } from '../../src/eve/market-history.js';
import {
  runMarketHistoryTick,
  stopMarketHistoryWorker,
  type MarketHistoryTickDeps,
} from '../../src/eve/market-history-worker.js';

const FORGE = 10000002;
const DOMAIN = 10000043;
const TRITANIUM = 34;
const PYERITE = 35;
const MEXALLON = 36;
const T0 = new Date('2026-07-27T10:00:00.000Z');
const MINUTE_MS = 60_000;

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
let orderId = 1;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(MARKET_HISTORY_DDL);
});

afterEach(async () => {
  await stopMarketHistoryWorker();
  db.close();
});

function makeEsiRow(date: string, average: number) {
  return {
    date,
    average,
    highest: average + 5,
    lowest: average - 5,
    order_count: 120,
    volume: 50_000,
  };
}

function recordingFetcher(rows: unknown[] = [makeEsiRow('2026-07-27', 100)]) {
  const calls: Array<{ regionId: number; typeId: number }> = [];
  const fetchHistory: MarketHistoryFetcher = async (regionId, typeId) => {
    calls.push({ regionId, typeId });
    return { ok: true, status: 200, data: rows, cached: false, headers: {} };
  };
  return { fetchHistory, calls };
}

function makeDeps(overrides: Partial<MarketHistoryTickDeps> = {}): Partial<MarketHistoryTickDeps> {
  return {
    now: T0,
    maxPerTick: 100,
    concurrency: 2,
    seedTopTypes: 0,
    defaultRegionId: FORGE,
    majorMinPages: 100,
    ...overrides,
  };
}

function addWatchlist(userId: number, typeId: number, regionId: number | null) {
  db.prepare(
    'INSERT INTO market_watchlist (user_id, type_id, region_id) VALUES (?, ?, ?)',
  ).run(userId, typeId, regionId);
}

function addSyncPair(regionId: number, typeId: number, nextDueAt: string) {
  db.prepare(
    'INSERT INTO market_history_sync (region_id, type_id, next_due_at) VALUES (?, ?, ?)',
  ).run(regionId, typeId, nextDueAt);
}

function insertOrder(regionId: number, typeId: number, price: number, volumeRemain: number) {
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, 30000142, 60003760, 60003760, 0, ?, ?, ?, 1, 90, 'region', '2026-07-27T09:55:00Z')
  `).run(orderId, typeId, regionId, price, volumeRemain, volumeRemain);
  orderId += 1;
}

function syncRow(regionId: number, typeId: number) {
  return db.prepare(
    'SELECT last_synced_at, next_due_at, status, error FROM market_history_sync WHERE region_id = ? AND type_id = ?',
  ).get(regionId, typeId) as
    | { last_synced_at: string | null; next_due_at: string | null; status: string | null; error: string | null }
    | undefined;
}

describe('runMarketHistoryTick', () => {
  it('seeds watchlist pairs, falling back to the default region, and syncs them due', async () => {
    addWatchlist(1, TRITANIUM, null); // NULL region -> default region
    addWatchlist(1, PYERITE, DOMAIN);
    addWatchlist(2, TRITANIUM, null); // same pair as user 1: seeds once
    const { fetchHistory, calls } = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory }));

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ regionId: FORGE, typeId: TRITANIUM });
    expect(calls).toContainEqual({ regionId: DOMAIN, typeId: PYERITE });
    expect(syncRow(FORGE, TRITANIUM)).toMatchObject({ status: 'ok', last_synced_at: T0.toISOString() });
    expect(syncRow(DOMAIN, PYERITE)?.status).toBe('ok');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM market_price_history').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('makes zero ESI calls on the next tick when nothing is due', async () => {
    addWatchlist(1, TRITANIUM, null);
    const first = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: first.fetchHistory }));
    expect(first.calls).toHaveLength(1);
    expect(syncRow(FORGE, TRITANIUM)?.next_due_at).toBe('2026-07-27T11:20:00.000Z');

    const second = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: second.fetchHistory }));
    expect(second.calls).toHaveLength(0);
  });

  it('processes only pairs whose next_due_at passed', async () => {
    addSyncPair(FORGE, TRITANIUM, new Date(T0.getTime() - MINUTE_MS).toISOString()); // due
    addSyncPair(FORGE, PYERITE, new Date(T0.getTime() + 60 * MINUTE_MS).toISOString()); // future
    const { fetchHistory, calls } = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory }));

    expect(calls).toEqual([{ regionId: FORGE, typeId: TRITANIUM }]);
    expect(syncRow(FORGE, PYERITE)?.next_due_at).toBe(new Date(T0.getTime() + 60 * MINUTE_MS).toISOString());
  });

  it('bounds the tick to maxPerTick, oldest due first', async () => {
    addSyncPair(FORGE, TRITANIUM, new Date(T0.getTime() - 30 * MINUTE_MS).toISOString());
    addSyncPair(FORGE, PYERITE, new Date(T0.getTime() - 20 * MINUTE_MS).toISOString());
    addSyncPair(FORGE, MEXALLON, new Date(T0.getTime() - 10 * MINUTE_MS).toISOString());
    const { fetchHistory, calls } = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory, maxPerTick: 2 }));

    expect(calls).toEqual([
      { regionId: FORGE, typeId: TRITANIUM },
      { regionId: FORGE, typeId: PYERITE },
    ]);
    // The pair that did not fit stays due for a later tick and was never synced.
    expect(syncRow(FORGE, MEXALLON)?.next_due_at).toBe(new Date(T0.getTime() - 10 * MINUTE_MS).toISOString());
    expect(syncRow(FORGE, MEXALLON)?.last_synced_at).toBeNull();
  });

  it('seeds top-value types from major snapshot regions only', async () => {
    db.prepare('INSERT INTO market_snapshot_regions (region_id, pages) VALUES (?, ?)').run(FORGE, 409);
    db.prepare('INSERT INTO market_snapshot_regions (region_id, pages) VALUES (?, ?)').run(DOMAIN, 3);
    insertOrder(FORGE, TRITANIUM, 10, 100); // listed value 1000
    insertOrder(FORGE, PYERITE, 5, 100); // listed value 500
    insertOrder(DOMAIN, MEXALLON, 1_000_000, 10); // huge, but Domain is not major
    const { fetchHistory, calls } = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory, seedTopTypes: 1 }));

    expect(calls).toEqual([{ regionId: FORGE, typeId: TRITANIUM }]);
    expect(syncRow(FORGE, TRITANIUM)?.status).toBe('ok');
    expect(syncRow(FORGE, PYERITE)).toBeUndefined(); // beyond the top-1 cut
    expect(syncRow(DOMAIN, MEXALLON)).toBeUndefined(); // minor region excluded
  });

  it('keeps the tick alive when one pair fails', async () => {
    addWatchlist(1, TRITANIUM, null);
    addWatchlist(1, PYERITE, null);
    const fetchHistory: MarketHistoryFetcher = async (_regionId, typeId) => {
      if (typeId === TRITANIUM) return { ok: false, status: 500, error: 'boom' };
      return { ok: true, status: 200, data: [makeEsiRow('2026-07-27', 100)], cached: false, headers: {} };
    };
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory }));

    expect(syncRow(FORGE, TRITANIUM)?.status).toBe('error');
    expect(syncRow(FORGE, TRITANIUM)?.next_due_at).toBe(new Date(T0.getTime() + 60 * MINUTE_MS).toISOString());
    expect(syncRow(FORGE, PYERITE)?.status).toBe('ok');
  });
});

describe('worker concurrency and shutdown', () => {
  // A fetcher parked on a gate stands in for a slow ESI call: the first tick
  // blocks inside the pool until the test releases it.
  function makeGatedFetcher() {
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchHistory: MarketHistoryFetcher = async () => {
      signalEntered();
      await gate;
      return { ok: true, status: 200, data: [makeEsiRow('2026-07-27', 100)], cached: false, headers: {} };
    };
    return { fetchHistory, entered, release };
  }

  it('serializes overlapping entry points: a second tick skips instead of pooling concurrently', async () => {
    addWatchlist(1, TRITANIUM, null);
    const gated = makeGatedFetcher();
    const first = runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: gated.fetchHistory }));
    await gated.entered;

    const second = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: second.fetchHistory }));
    expect(second.calls).toHaveLength(0);

    gated.release();
    await first;
    expect(syncRow(FORGE, TRITANIUM)?.status).toBe('ok');
  });

  it('stopMarketHistoryWorker waits for the in-flight tick before returning', async () => {
    addWatchlist(1, TRITANIUM, null);
    const gated = makeGatedFetcher();
    const first = runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: gated.fetchHistory }));
    await gated.entered;

    let stopped = false;
    const stopPromise = Promise.resolve(stopMarketHistoryWorker()).then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false); // a parked tick must hold the stop open

    gated.release();
    await first;
    await stopPromise;
    expect(stopped).toBe(true);
  });
});

describe('top-types seed throttle', () => {
  function seedMajorRegionOrders() {
    db.prepare('INSERT INTO market_snapshot_regions (region_id, pages) VALUES (?, ?)').run(FORGE, 409);
    insertOrder(FORGE, TRITANIUM, 10, 100);
  }

  it('runs the heavy top-types seed only once per interval across ticks', async () => {
    seedMajorRegionOrders();
    const prepareSpy = vi.spyOn(db, 'prepare');
    const topTypesSelects = () => prepareSpy.mock.calls
      .filter(([sql]) => String(sql).includes('SUM(o.volume_remain * o.price)')).length;

    const first = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: first.fetchHistory, seedTopTypes: 5 }));
    expect(topTypesSelects()).toBe(1);

    // The next hourly tick skips the scan: same day, same orders.
    const second = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: second.fetchHistory, seedTopTypes: 5 }));
    expect(topTypesSelects()).toBe(1);
    prepareSpy.mockRestore();
  });

  it('re-runs the top-types seed once the interval elapsed', async () => {
    seedMajorRegionOrders();
    const prepareSpy = vi.spyOn(db, 'prepare');
    const topTypesSelects = () => prepareSpy.mock.calls
      .filter(([sql]) => String(sql).includes('SUM(o.volume_remain * o.price)')).length;

    const first = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: first.fetchHistory, seedTopTypes: 5 }));
    expect(topTypesSelects()).toBe(1);

    const later = new Date(T0.getTime() + 25 * 60 * MINUTE_MS);
    const second = recordingFetcher();
    await runMarketHistoryTick(db as Db, makeDeps({ fetchHistory: second.fetchHistory, seedTopTypes: 5, now: later }));
    expect(topTypesSelects()).toBe(2);
    prepareSpy.mockRestore();
  });
});
