import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  getMarketSnapshotRegionStates,
  getMarketSnapshotState,
  type MarketOrdersPageFetcher,
  type SnapshotRegion,
} from '../../src/eve/market-snapshot-loader.js';
import {
  runMarketSnapshotTick,
  stopMarketSnapshotWorker,
  type MarketSnapshotTickDeps,
} from '../../src/eve/market-snapshot.js';

const FORGE = 10000002;
const DOMAIN = 10000043;
const REGIONS: SnapshotRegion[] = [
  { region_id: FORGE, name: 'The Forge' },
  { region_id: DOMAIN, name: 'Domain' },
];
const T0 = new Date('2026-07-27T10:00:00Z');
const MINUTES = 60_000;

let db: Database.Database;

function makeOrder(orderId: number): Record<string, unknown> {
  return {
    duration: 90,
    is_buy_order: false,
    issued: '2026-07-27T09:55:00Z',
    location_id: 60003760,
    min_volume: 1,
    order_id: orderId,
    price: 100.5,
    range: 'region',
    system_id: 30000142,
    type_id: 34,
    volume_remain: 500,
    volume_total: 1000,
  };
}

function makeFetcher(failRegions: Set<number> = new Set()) {
  const calls: number[] = [];
  const fetchPage: MarketOrdersPageFetcher = async (regionId) => {
    calls.push(regionId);
    if (failRegions.has(regionId)) throw new Error(`region ${regionId} down`);
    return {
      orders: [makeOrder(regionId * 10 + 1), makeOrder(regionId * 10 + 2)],
      pages: 1,
      expires: null,
      lastModified: null,
    };
  };
  return { fetchPage, calls };
}

function makeDeps(
  fetchPage: MarketOrdersPageFetcher,
  overrides: Partial<MarketSnapshotTickDeps> = {},
): MarketSnapshotTickDeps {
  return { regions: REGIONS, fetchPage, minRows: 1, now: T0, ...overrides };
}

function tableCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM market_orders').get() as { c: number }).c;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('runMarketSnapshotTick', () => {
  it('sweeps due regions and records the committed snapshot', async () => {
    const { fetchPage } = makeFetcher();
    await runMarketSnapshotTick(db as Db, makeDeps(fetchPage));

    expect(tableCount()).toBe(4);
    const state = getMarketSnapshotState(db as Db);
    expect(state).toMatchObject({
      status: 'idle',
      snapshot_time: T0.toISOString(),
      rows_loaded: 4,
      last_error: null,
    });
    expect(getMarketSnapshotRegionStates(db as Db)).toHaveLength(2);
  });

  it('makes zero ESI calls when no region is due', async () => {
    const { fetchPage, calls } = makeFetcher();
    await runMarketSnapshotTick(db as Db, makeDeps(fetchPage));
    expect(tableCount()).toBe(4);

    calls.length = 0;
    await runMarketSnapshotTick(db as Db, makeDeps(fetchPage, {
      now: new Date(T0.getTime() + 10 * MINUTES),
    }));

    expect(calls).toEqual([]);
    expect(tableCount()).toBe(4);
    expect(getMarketSnapshotState(db as Db)?.status).toBe('idle');
  });

  it('records an error and keeps serving the previous snapshot when the sweep aborts', async () => {
    const { fetchPage } = makeFetcher();
    await runMarketSnapshotTick(db as Db, makeDeps(fetchPage));
    expect(tableCount()).toBe(4);

    // The sweep commits only complete books: an impossible floor forces an abort.
    await runMarketSnapshotTick(db as Db, makeDeps(fetchPage, {
      minRows: 1_000_000,
      now: new Date(T0.getTime() + 400 * MINUTES),
    }));

    expect(tableCount()).toBe(4); // old snapshot still serving
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'market_orders_next'").get()).toBeUndefined();
    const state = getMarketSnapshotState(db as Db);
    expect(state?.status).toBe('error');
    expect(state?.last_error).toContain('sanity floor');
    expect(state?.snapshot_time).toBe(T0.toISOString()); // provenance of the serving snapshot preserved
  });

  it('records an error instead of sweeping when no trade regions are available', async () => {
    const { fetchPage, calls } = makeFetcher();
    await runMarketSnapshotTick(db as Db, makeDeps(fetchPage, { regions: [] }));

    expect(calls).toEqual([]);
    expect(tableCount()).toBe(0);
    const state = getMarketSnapshotState(db as Db);
    expect(state?.status).toBe('error');
    expect(state?.last_error).toContain('stargate geography');
  });

  it('keeps a warm region on its previous rows when its refetch fails', async () => {
    const first = makeFetcher();
    await runMarketSnapshotTick(db as Db, makeDeps(first.fetchPage));

    const later = new Date(T0.getTime() + 400 * MINUTES);
    const second = makeFetcher(new Set([FORGE]));
    // Must not reject: the rest of the book still commits.
    await runMarketSnapshotTick(db as Db, makeDeps(second.fetchPage, { now: later }));

    expect(tableCount()).toBe(4);
    const state = getMarketSnapshotState(db as Db);
    expect(state?.status).toBe('idle');
    // The failed Forge keeps its T0 rows in the book, so the snapshot's honest
    // age is Forge's age — not the moment of this tick.
    expect(state?.snapshot_time).toBe(T0.toISOString());
    // The partial failure stays visible instead of being wiped by the commit.
    expect(state?.last_error).toContain(String(FORGE));

    const regions = getMarketSnapshotRegionStates(db as Db);
    const forge = regions.find((row) => row.region_id === FORGE);
    const domain = regions.find((row) => row.region_id === DOMAIN);
    expect(forge?.last_error).toContain('down');
    expect(forge?.fetched_at).toBe(T0.toISOString()); // stays due for the next tick
    expect(domain?.last_error).toBeNull();
    expect(domain?.fetched_at).toBe(later.toISOString());
  });
});

describe('worker concurrency and shutdown', () => {
  // A fetcher parked on a gate stands in for the minutes-long cold sweep: the
  // first tick blocks inside the loader until the test releases it.
  function makeGatedFetcher() {
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchPage: MarketOrdersPageFetcher = async (regionId, page) => {
      signalEntered();
      await gate;
      return {
        orders: [makeOrder(regionId * 10 + page)],
        pages: 1,
        expires: null,
        lastModified: null,
      };
    };
    return { fetchPage, entered, release };
  }

  it('serializes overlapping entry points: a second tick skips instead of sweeping concurrently', async () => {
    const gated = makeGatedFetcher();
    const first = runMarketSnapshotTick(db as Db, makeDeps(gated.fetchPage));
    await gated.entered; // the cold-style sweep is now in flight

    // The cron tick firing mid-sweep must return immediately, not queue and
    // definitely not run a second sweep over the same staging table.
    const secondFetcher = vi.fn(makeFetcher().fetchPage);
    await runMarketSnapshotTick(db as Db, makeDeps(secondFetcher));
    expect(secondFetcher).not.toHaveBeenCalled();

    gated.release();
    await first;
    expect(tableCount()).toBe(2);

    // The lock left with the sweep: the next tick sweeps normally.
    const third = makeFetcher();
    await runMarketSnapshotTick(db as Db, makeDeps(third.fetchPage, {
      now: new Date(T0.getTime() + 400 * MINUTES),
    }));
    expect(third.calls).toEqual([FORGE, DOMAIN]);
    expect(tableCount()).toBe(4);
  });

  it('stopMarketSnapshotWorker waits for the in-flight sweep before returning', async () => {
    const gated = makeGatedFetcher();
    const first = runMarketSnapshotTick(db as Db, makeDeps(gated.fetchPage));
    await gated.entered;

    let stopped = false;
    const stopPromise = Promise.resolve(stopMarketSnapshotWorker()).then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false); // a parked sweep must hold the stop open

    gated.release();
    await first;
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
