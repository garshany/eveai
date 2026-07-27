import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { acquireRuntimeLock } from '../../src/runtime/process-lock.js';
import {
  acquireMarketSnapshotLoaderLock,
  createEsiOrdersPageFetcher,
  getMarketSnapshotMeta,
  getMarketSnapshotRegionStates,
  getMarketSnapshotState,
  loadMarketSnapshotFromEsi,
  type LoadMarketSnapshotOptions,
  type MarketOrdersPageFetcher,
  type SnapshotRegion,
} from '../../src/eve/market-snapshot-loader.js';

const FORGE = 10000002;
const DOMAIN = 10000043;
const REGIONS: SnapshotRegion[] = [
  { region_id: FORGE, name: 'The Forge' },
  { region_id: DOMAIN, name: 'Domain' },
];
const T0 = new Date('2026-07-27T10:00:00Z');
const MINUTES = 60_000;

let db: Database.Database;

function makeOrder(orderId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

type BookSpec = {
  /** Static x-pages, or per-page for books whose page count grows mid-walk. */
  pages: number | ((page: number) => number);
  orders?: (regionId: number, page: number) => unknown[];
  expires?: string | null;
  lastModified?: string | null | ((page: number) => string | null);
  failOnPage?: number;
};

function makeFetcher(books: Record<number, BookSpec>) {
  const calls: Array<{ regionId: number; page: number }> = [];
  const maxReportedPages: Record<number, number> = {};
  const fetchPage: MarketOrdersPageFetcher = async (regionId, page) => {
    calls.push({ regionId, page });
    const book = books[regionId];
    if (!book) throw new Error(`no stub for region ${regionId}`);
    if (book.failOnPage === page) throw new Error(`page ${page} exploded`);
    const reported = typeof book.pages === 'function' ? book.pages(page) : book.pages;
    maxReportedPages[regionId] = Math.max(maxReportedPages[regionId] ?? 0, reported);
    if (page > maxReportedPages[regionId]) throw new Error(`unexpected page ${page} for region ${regionId}`);
    const lastModified = typeof book.lastModified === 'function'
      ? book.lastModified(page)
      : book.lastModified ?? null;
    return {
      orders: book.orders?.(regionId, page) ?? [makeOrder(regionId * 1000 + page)],
      pages: reported,
      expires: book.expires ?? null,
      lastModified,
    };
  };
  return { fetchPage, calls };
}

function baseOptions(
  fetchPage: MarketOrdersPageFetcher,
  overrides: Partial<LoadMarketSnapshotOptions> = {},
): LoadMarketSnapshotOptions {
  return { regions: REGIONS, fetchPage, minRows: 1, now: T0, ...overrides };
}

function tableCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM market_orders').get() as { c: number }).c;
}

function stagingExists(): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'market_orders_next'",
  ).get() !== undefined;
}

function orderIdsFor(regionId: number): number[] {
  const rows = db.prepare('SELECT order_id FROM market_orders WHERE region_id = ? ORDER BY order_id')
    .all(regionId) as Array<{ order_id: number }>;
  return rows.map((row) => row.order_id);
}

function indexNamesFor(table: string): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
  ).all(table) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('loadMarketSnapshotFromEsi', () => {
  it('sweeps every due region page by page and commits the atomic swap', async () => {
    const { fetchPage, calls } = makeFetcher({
      [FORGE]: {
        pages: 2,
        orders: (_region, page) => [0, 1, 2].map((i) => makeOrder(page * 100 + i)),
      },
      [DOMAIN]: { pages: 1, orders: () => [makeOrder(900), makeOrder(901)] },
    });

    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, { batchSize: 2 }));

    expect(result).toMatchObject({
      swept: true,
      rowsLoaded: 8,
      malformedRows: 0,
      regionsFetched: 2,
      regionsCarriedOver: 0,
      regionErrors: [],
    });
    // Page-by-page walk, region by region, exactly up to x-pages.
    expect(calls).toEqual([
      { regionId: FORGE, page: 1 },
      { regionId: FORGE, page: 2 },
      { regionId: DOMAIN, page: 1 },
    ]);
    expect(tableCount()).toBe(8);
    expect(stagingExists()).toBe(false);

    const row = db.prepare('SELECT * FROM market_orders WHERE order_id = 100').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      type_id: 34,
      region_id: FORGE, // from the walk itself, ESI does not send it
      system_id: 30000142,
      station_id: null, // no sde_stations rows in this db
      location_id: 60003760,
      is_buy_order: 0,
      price: 100.5,
      volume_remain: 500,
      volume_total: 1000,
      min_volume: 1,
      duration: 90,
      range: 'region',
      issued: '2026-07-27T09:55:00Z',
    });

    // Indexes are built on the staging table before the swap and carried through
    // the rename, so their names are unique per pass instead of canonical.
    const indexes = indexNamesFor('market_orders');
    expect(indexes).toHaveLength(3);
    for (const name of indexes) {
      expect(name).toMatch(/^idx_market_orders_(region|type|type_region)_[0-9a-z]+_[0-9a-z]+$/);
    }

    const state = getMarketSnapshotState(db as Db);
    expect(state).toMatchObject({
      status: 'idle',
      snapshot_url: 'esi:/markets/{region_id}/orders',
      snapshot_etag: null,
      snapshot_time: T0.toISOString(),
      rows_loaded: 8,
      last_error: null,
    });

    const regionStates = getMarketSnapshotRegionStates(db as Db);
    expect(regionStates).toEqual([
      {
        region_id: FORGE,
        pages: 2,
        rows_loaded: 6,
        fetched_at: T0.toISOString(),
        expires_at: null,
        last_error: null,
      },
      {
        region_id: DOMAIN,
        pages: 1,
        rows_loaded: 2,
        fetched_at: T0.toISOString(),
        expires_at: null,
        last_error: null,
      },
    ]);
  });

  it('classifies tiers by page count and refetches only the due major region', async () => {
    const first = makeFetcher({
      [FORGE]: { pages: 150 }, // >= majorMinPages: major tier
      [DOMAIN]: { pages: 5, orders: (_region, page) => [makeOrder(43_000 + page)] }, // minor tier
    });
    const intervals = { majorMinPages: 100, majorIntervalMinutes: 30, minorIntervalMinutes: 360 };
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, intervals));
    expect(orderIdsFor(DOMAIN)).toEqual([43001, 43002, 43003, 43004, 43005]);

    // 31 minutes later: the 150-page region is due again, the 5-page one is not.
    const second = makeFetcher({
      [FORGE]: { pages: 150, orders: (_region, page) => [makeOrder(500_000 + page)] },
    });
    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, {
      ...intervals,
      now: new Date(T0.getTime() + 31 * MINUTES),
    }));

    expect(result).toMatchObject({
      swept: true,
      rowsLoaded: 155,
      regionsFetched: 1,
      regionsCarriedOver: 1,
    });
    expect(second.calls).toHaveLength(150); // The Forge refetched page by page...
    expect(second.calls.every((call) => call.regionId === FORGE)).toBe(true);
    expect(orderIdsFor(DOMAIN)).toEqual([43001, 43002, 43003, 43004, 43005]); // ...Domain carried over untouched
    expect(orderIdsFor(FORGE)[0]).toBe(500_001);
  });

  it('yields to the event loop between region carry-overs instead of one synchronous block', async () => {
    // The minor tier carries over with one synchronous INSERT SELECT per
    // region (~40ms each; the whole tier measured ~2.6s). Run back to back
    // that is a single multi-second event-loop block every major tick, so the
    // loader yields after every carried region. Measured here with a gate
    // counter on setImmediate: carrying N regions means >= N-1 yields.
    const minorIds = Array.from({ length: 11 }, (_, i) => 20000000 + i);
    const regions: SnapshotRegion[] = [
      { region_id: FORGE, name: 'The Forge' },
      ...minorIds.map((id) => ({ region_id: id, name: `Region ${id}` })),
    ];
    const books: Record<number, BookSpec> = { [FORGE]: { pages: 100 } };
    for (const id of minorIds) books[id] = { pages: 1 };
    const intervals = { majorMinPages: 100, majorIntervalMinutes: 30, minorIntervalMinutes: 360 };

    const first = makeFetcher(books);
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, { regions, ...intervals }));

    // 31 minutes later only the 100-page region is due; the 11 minor regions
    // carry over. The fetch stub itself never touches setImmediate.
    const second = makeFetcher({ [FORGE]: { pages: 100 } });
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate');
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, {
      regions,
      ...intervals,
      now: new Date(T0.getTime() + 31 * MINUTES),
    }));

    expect(immediateSpy.mock.calls.length).toBeGreaterThanOrEqual(minorIds.length - 1);
  });

  it('keeps a region that legitimately holds zero orders when its refetch fails', async () => {
    // Domain commits an EMPTY book: zero rows is a legal state. A later ESI
    // failure on it carries zero rows over, and reading that as a cold region
    // would abort every sweep until the endpoint recovered.
    const first = makeFetcher({
      [FORGE]: { pages: 1, orders: () => [makeOrder(1)] },
      [DOMAIN]: { pages: 1, orders: () => [] },
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage));
    expect(tableCount()).toBe(1);

    const later = new Date(T0.getTime() + 400 * MINUTES);
    const second = makeFetcher({
      [FORGE]: { pages: 1, orders: () => [makeOrder(2)] },
      [DOMAIN]: { pages: 1, failOnPage: 1 },
    });
    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, { now: later }));

    expect(result.swept).toBe(true);
    expect(result.regionErrors).toHaveLength(1);
    expect(result.regionErrors[0].regionId).toBe(DOMAIN);
    expect(result.regionErrors[0].error).toContain('exploded');
    expect(orderIdsFor(FORGE)).toEqual([2]); // the rest of the book still committed
    expect(orderIdsFor(DOMAIN)).toEqual([]); // zero rows, as legitimately committed

    const domain = getMarketSnapshotRegionStates(db as Db).find((row) => row.region_id === DOMAIN);
    expect(domain?.last_error).toContain('exploded');
    expect(domain?.fetched_at).toBe(T0.toISOString()); // stays due on the next tick
  });

  it('returns swept:false and makes zero ESI calls when no region is due', async () => {
    const first = makeFetcher({ [FORGE]: { pages: 1 }, [DOMAIN]: { pages: 1 } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage));

    const second = makeFetcher({});
    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, {
      now: new Date(T0.getTime() + 10 * MINUTES),
    }));

    expect(result.swept).toBe(false);
    expect(second.calls).toEqual([]);
    expect(tableCount()).toBe(2);
  });

  it('never refetches a region before its ESI Expires even when the tier interval elapsed', async () => {
    const expires = new Date(T0.getTime() + 40 * MINUTES).toUTCString();
    const { fetchPage, calls } = makeFetcher({
      [FORGE]: { pages: 150, expires },
      [DOMAIN]: { pages: 5 },
    });
    const intervals = { majorMinPages: 100, majorIntervalMinutes: 30, minorIntervalMinutes: 360 };
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, intervals));

    // Tier interval (30m) elapsed, but the ESI cache entry is still valid.
    calls.length = 0;
    const early = await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, {
      ...intervals,
      now: new Date(T0.getTime() + 31 * MINUTES),
    }));
    expect(early.swept).toBe(false);
    expect(calls).toEqual([]);

    // Once Expires passed too, the major region is refetched.
    const late = await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, {
      ...intervals,
      now: new Date(T0.getTime() + 41 * MINUTES),
    }));
    expect(late.swept).toBe(true);
    expect(calls.length).toBe(150);
    expect(calls.every((call) => call.regionId === FORGE)).toBe(true);
  });

  it('falls back to previous rows when a warm region fails and keeps it due', async () => {
    const first = makeFetcher({
      [FORGE]: { pages: 2, orders: (_region, page) => [makeOrder(page * 111)] },
      [DOMAIN]: { pages: 1, orders: () => [makeOrder(333)] },
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage));
    expect(orderIdsFor(FORGE)).toEqual([111, 222]);

    const later = new Date(T0.getTime() + 400 * MINUTES);
    const second = makeFetcher({
      [FORGE]: { pages: 2, orders: () => [makeOrder(999)], failOnPage: 2 },
      [DOMAIN]: { pages: 1, orders: () => [makeOrder(444)] },
    });
    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, { now: later }));

    expect(result).toMatchObject({ swept: true, regionsFetched: 1, regionsCarriedOver: 1 });
    expect(result.regionErrors).toHaveLength(1);
    expect(result.regionErrors[0].regionId).toBe(FORGE);
    expect(result.regionErrors[0].error).toContain('exploded');
    expect(orderIdsFor(FORGE)).toEqual([111, 222]); // previous rows kept serving
    expect(orderIdsFor(DOMAIN)).toEqual([444]);

    const regionStates = getMarketSnapshotRegionStates(db as Db);
    const forge = regionStates.find((row) => row.region_id === FORGE);
    const domain = regionStates.find((row) => row.region_id === DOMAIN);
    expect(forge?.last_error).toContain('exploded');
    expect(forge?.fetched_at).toBe(T0.toISOString()); // still due on the next tick
    expect(domain?.fetched_at).toBe(later.toISOString());
    expect(getMarketSnapshotState(db as Db)?.status).toBe('idle');
  });

  it('aborts the whole sweep when a region with no prior rows fails', async () => {
    const { fetchPage } = makeFetcher({
      [FORGE]: { pages: 2, failOnPage: 2 },
      [DOMAIN]: { pages: 1 },
    });

    await expect(loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage)))
      .rejects.toThrow(/no prior rows/);

    expect(tableCount()).toBe(0);
    expect(stagingExists()).toBe(false);
    expect(getMarketSnapshotRegionStates(db as Db)).toEqual([]);
    expect(getMarketSnapshotState(db as Db)).toBeNull();
  });

  it('aborts the whole sweep when the book keeps changing across the re-walk (last-modified mismatch)', async () => {
    // Every walk straddles a flip (page 1 LM-A, later pages LM-B): one re-walk
    // is granted, the second consecutive drift is fatal for the region — and a
    // cold region still aborts the swap instead of serving a stitched book.
    const { fetchPage, calls } = makeFetcher({
      [FORGE]: {
        pages: 2,
        lastModified: (page) => (page === 1 ? 'Wed, 27 Jul 2026 10:00:00 GMT' : 'Wed, 27 Jul 2026 10:05:00 GMT'),
      },
      [DOMAIN]: { pages: 1 },
    });

    await expect(loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage)))
      .rejects.toThrow(/changed mid-sweep/);
    expect(tableCount()).toBe(0);
    expect(stagingExists()).toBe(false);
    // Exactly one re-walk was attempted before giving up: p1,p2 then p1,p2.
    expect(calls).toEqual([
      { regionId: FORGE, page: 1 },
      { regionId: FORGE, page: 2 },
      { regionId: FORGE, page: 1 },
      { regionId: FORGE, page: 2 },
    ]);
  });

  it('cold start keeps committing across ticks even when the 5-minute cache window flips mid-walk', async () => {
    // Production failure mode (2026-07-27): a sequential walk of a large
    // region outlives ESI's 5-minute order-book cache, last-modified flips
    // mid-walk, the cold region aborts every swap, and the next tick is cold
    // again — forever. Simulated here with a virtual wall clock: each page
    // takes latencyMs, pages in flight together complete at the same virtual
    // instant (a pool of N is N times faster), and last-modified follows the
    // virtual 5-minute window. 40 pages x 8s/page models The Forge's 409
    // pages at ~800ms/page: sequential = 320s > window, pool of 8 = ~48s.
    const WINDOW_MS = 300_000;
    const LATENCY_MS = 8_000;
    const PAGES = 40;
    let virtualNow = new Date('2026-07-27T10:04:40Z').getTime(); // 20s before a window flip
    const windowOf = (ms: number) => new Date(Math.floor(ms / WINDOW_MS) * WINDOW_MS).toUTCString();
    const fetchPage: MarketOrdersPageFetcher = async (regionId, page) => {
      const started = virtualNow;
      await new Promise((resolve) => { setImmediate(resolve); });
      virtualNow = Math.max(virtualNow, started + LATENCY_MS);
      return {
        orders: [makeOrder(regionId * 1000 + page)],
        pages: PAGES,
        expires: new Date(Math.ceil(virtualNow / WINDOW_MS) * WINDOW_MS).toUTCString(),
        lastModified: windowOf(virtualNow),
      };
    };

    // Tick after tick the sweep must commit: no drift abort, no eternal refusal.
    for (let tick = 0; tick < 3; tick += 1) {
      const tickStart = virtualNow;
      const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, {
        regions: [REGIONS[0]],
        now: new Date(T0.getTime() + tick * 400 * MINUTES),
      }));
      expect(result.swept).toBe(true);
      expect(result.regionErrors).toEqual([]);
      expect(tableCount()).toBe(PAGES);
      // The pooled walk itself fits well inside the cache window.
      expect(virtualNow - tickStart).toBeLessThan(WINDOW_MS);
    }
  });

  it('fetches region pages through a bounded pool instead of strictly sequentially', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchPage: MarketOrdersPageFetcher = async (regionId, page) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => { setImmediate(resolve); });
      active -= 1;
      return {
        orders: [makeOrder(regionId * 1000 + page)],
        pages: 12,
        expires: null,
        lastModified: 'Wed, 27 Jul 2026 10:00:00 GMT',
      };
    };

    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, {
      regions: [REGIONS[0]],
      pageConcurrency: 4,
    }));

    expect(result.rowsLoaded).toBe(12);
    expect(maxActive).toBeGreaterThan(1); // actually parallel...
    expect(maxActive).toBeLessThanOrEqual(4); // ...but never above the pool size
  });

  it('re-walks once on a mid-walk cache flip and commits the fresh book instead of falling back', async () => {
    const LM_A = 'Wed, 27 Jul 2026 10:00:00 GMT';
    const LM_B = 'Wed, 27 Jul 2026 10:05:00 GMT';
    const first = makeFetcher({
      [FORGE]: { pages: 5, orders: (_region, page) => [makeOrder(1000 + page)], lastModified: LM_A },
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, { regions: [REGIONS[0]] }));
    expect(orderIdsFor(FORGE)).toEqual([1001, 1002, 1003, 1004, 1005]);

    // The next sweep straddles a cache flip on its first walk (page 3+ carry
    // the new last-modified); the re-walk sees a consistent book again.
    let walks = 0;
    const flipFetch: MarketOrdersPageFetcher = async (regionId, page) => {
      if (page === 1) walks += 1;
      return {
        orders: [makeOrder(2000 + page)],
        pages: 5,
        expires: null,
        lastModified: walks === 1 && page >= 3 ? LM_B : LM_A,
      };
    };
    const later = new Date(T0.getTime() + 400 * MINUTES);
    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(flipFetch, {
      regions: [REGIONS[0]],
      now: later,
    }));

    expect(walks).toBe(2); // one re-walk, no fallback
    expect(result.regionErrors).toEqual([]);
    expect(orderIdsFor(FORGE)).toEqual([2001, 2002, 2003, 2004, 2005]); // fresh rows, not previous
    const forge = getMarketSnapshotRegionStates(db as Db).find((row) => row.region_id === FORGE);
    expect(forge?.fetched_at).toBe(later.toISOString());
    expect(forge?.last_error).toBeNull();
  });

  it('extends the walk when a later page reports more x-pages without an LM signal', async () => {
    // The pool sizes the walk from page 1's x-pages, but the book can still
    // grow mid-walk when ESI omits Last-Modified: a later page reporting more
    // pages extends the walk (capped), it must not strand the extra pages.
    const { fetchPage, calls } = makeFetcher({
      [FORGE]: { pages: (page) => (page === 1 ? 2 : 3), lastModified: null },
    });

    const result = await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, {
      regions: [REGIONS[0]],
    }));

    expect(result.rowsLoaded).toBe(3);
    expect(calls).toEqual([
      { regionId: FORGE, page: 1 },
      { regionId: FORGE, page: 2 },
      { regionId: FORGE, page: 3 },
    ]);
    const forge = getMarketSnapshotRegionStates(db as Db).find((row) => row.region_id === FORGE);
    expect(forge?.pages).toBe(3);
  });

  it('skips malformed rows within budget and aborts beyond it', async () => {
    const tolerant = makeFetcher({
      [DOMAIN]: {
        pages: 1,
        orders: () => [makeOrder(1), { order_id: 'not-a-number' }, makeOrder(2)],
      },
    });
    const ok = await loadMarketSnapshotFromEsi(db as Db, baseOptions(tolerant.fetchPage, {
      regions: [REGIONS[1]],
    }));
    expect(ok.rowsLoaded).toBe(2);
    expect(ok.malformedRows).toBe(1);

    const hostile = makeFetcher({
      [DOMAIN]: { pages: 1, orders: () => [{ bad: 1 }, { bad: 2 }, { bad: 3 }] },
    });
    await expect(loadMarketSnapshotFromEsi(db as Db, baseOptions(hostile.fetchPage, {
      regions: [REGIONS[1]],
      maxMalformedRows: 2,
      now: new Date(T0.getTime() + 400 * MINUTES),
    }))).rejects.toThrow(/Too many malformed rows/);
    expect(tableCount()).toBe(2); // the earlier good snapshot survived
    expect(stagingExists()).toBe(false);
  });

  it('refuses to swap when the row count is below the sanity floor', async () => {
    const first = makeFetcher({ [DOMAIN]: { pages: 1, orders: () => [makeOrder(1), makeOrder(2)] } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, { regions: [REGIONS[1]] }));

    const second = makeFetcher({ [DOMAIN]: { pages: 1 } });
    await expect(loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, {
      regions: [REGIONS[1]],
      minRows: 1_000_000,
      now: new Date(T0.getTime() + 400 * MINUTES),
    }))).rejects.toThrow(/below the sanity floor/);

    expect(tableCount()).toBe(2);
    expect(stagingExists()).toBe(false);
  });

  it('derives station_id from sde_stations and leaves player structures NULL', async () => {
    db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
      .run(60003760, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', 30000142, '{}');

    const { fetchPage } = makeFetcher({
      [DOMAIN]: {
        pages: 1,
        orders: () => [
          makeOrder(1, { location_id: 60003760 }),
          makeOrder(2, { location_id: 1_039_000_000_000 }),
        ],
      },
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(fetchPage, { regions: [REGIONS[1]] }));

    const rows = db.prepare('SELECT order_id, station_id, location_id FROM market_orders ORDER BY order_id')
      .all() as Array<{ order_id: number; station_id: number | null; location_id: number }>;
    expect(rows).toEqual([
      { order_id: 1, station_id: 60003760, location_id: 60003760 },
      { order_id: 2, station_id: null, location_id: 1_039_000_000_000 },
    ]);
  });

  it('atomically replaces the previous snapshot, removing disappeared orders', async () => {
    const first = makeFetcher({ [DOMAIN]: { pages: 1, orders: () => [makeOrder(1), makeOrder(2)] } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, { regions: [REGIONS[1]] }));
    expect(orderIdsFor(DOMAIN)).toEqual([1, 2]);

    const second = makeFetcher({ [DOMAIN]: { pages: 1, orders: () => [makeOrder(3)] } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, {
      regions: [REGIONS[1]],
      now: new Date(T0.getTime() + 400 * MINUTES),
    }));

    // The entire previous generation is gone, not upserted over.
    expect(orderIdsFor(DOMAIN)).toEqual([3]);
  });

  it('builds the indexes on the staging table under per-pass names, so the swap only renames', async () => {
    // The schema creates the serving table without indexes: the loader owns
    // them. Canonical names could not be created on staging while the old
    // table held them, and rebuilding 1.6M-row indexes inside the swap
    // transaction stalled the whole process behind DROP+RENAME.
    expect(indexNamesFor('market_orders')).toEqual([]);

    const first = makeFetcher({ [DOMAIN]: { pages: 1, orders: () => [makeOrder(1), makeOrder(2)] } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, { regions: [REGIONS[1]] }));

    const passOne = indexNamesFor('market_orders');
    expect(passOne).toHaveLength(3);
    for (const name of passOne) {
      expect(name).toMatch(/^idx_market_orders_(region|type|type_region)_[0-9a-z]+_[0-9a-z]+$/);
    }

    // The carried-through indexes are functional, not decorative.
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM market_orders WHERE type_id = 34 AND region_id = ? LIMIT 1',
    ).all(DOMAIN) as Array<{ detail: string }>;
    expect(plan[0]?.detail).toContain('USING INDEX');

    // A second pass must not collide with the names the serving table still
    // holds from the first one (fixed staging names would).
    const second = makeFetcher({ [DOMAIN]: { pages: 1, orders: () => [makeOrder(3)] } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, {
      regions: [REGIONS[1]],
      now: new Date(T0.getTime() + 400 * MINUTES),
    }));
    const passTwo = indexNamesFor('market_orders');
    expect(passTwo).toHaveLength(3);
    expect(passTwo.filter((name) => passOne.includes(name))).toEqual([]);
    expect(orderIdsFor(DOMAIN)).toEqual([3]);
  });
});

describe('snapshot freshness and meta', () => {
  // Mirrors the loader defaults used by sweeps that pass no explicit intervals.
  const DEFAULT_FRESHNESS = {
    staleMinutes: 75,
    majorMinPages: 100,
    majorIntervalMinutes: 30,
    minorIntervalMinutes: 360,
  };

  async function sweepPartialFailure(): Promise<Date> {
    const first = makeFetcher({
      [FORGE]: { pages: 2, orders: (_region, page) => [makeOrder(page * 111)] },
      [DOMAIN]: { pages: 1, orders: () => [makeOrder(333)] },
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage));

    const later = new Date(T0.getTime() + 400 * MINUTES);
    const second = makeFetcher({
      [FORGE]: { pages: 2, orders: () => [makeOrder(999)], failOnPage: 2 },
      [DOMAIN]: { pages: 1, orders: () => [makeOrder(444)] },
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, { now: later }));
    return later;
  }

  it('ages the committed snapshot by its oldest region, not by the tick time', async () => {
    const intervals = { majorMinPages: 100, majorIntervalMinutes: 30, minorIntervalMinutes: 360 };
    const first = makeFetcher({
      [FORGE]: { pages: 150 }, // major tier
      [DOMAIN]: { pages: 5, orders: (_region, page) => [makeOrder(43_000 + page)] }, // minor tier
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, intervals));

    // 31 minutes later only the major region is due; Domain is carried over
    // with its T0 rows still in the swapped book.
    const later = new Date(T0.getTime() + 31 * MINUTES);
    const second = makeFetcher({ [FORGE]: { pages: 150 } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, { ...intervals, now: later }));

    expect(getMarketSnapshotState(db as Db)?.snapshot_time).toBe(T0.toISOString());

    const meta = getMarketSnapshotMeta(db as Db, { staleMinutes: 75, ...intervals }, later);
    expect(meta.snapshot_time).toBe(T0.toISOString());
    expect(meta.age_minutes).toBe(31);
    // 31-minute-old minor rows sit far inside their 360-minute tier interval
    // plus the grace allowance: the age is reported, but the book is not stale.
    expect(meta.stale).toBe(false);
  });

  it('keeps partial-sweep region errors visible in the committed snapshot state and meta', async () => {
    const later = await sweepPartialFailure();

    // The book committed (Domain fresh, Forge carried over): the status stays
    // idle, but the partial failure must not be wiped by the commit.
    const state = getMarketSnapshotState(db as Db);
    expect(state?.status).toBe('idle');
    expect(state?.last_error).toContain(String(FORGE));
    expect(state?.last_error).toContain('exploded');
    // Forge's rows in the book are the T0 fetch: the snapshot's age is Forge's age.
    expect(state?.snapshot_time).toBe(T0.toISOString());

    const meta = getMarketSnapshotMeta(db as Db, DEFAULT_FRESHNESS, later);
    expect(meta.last_error).toContain('exploded');
    expect(meta.age_minutes).toBe(400);
    // Forge is 400 minutes old and failing, but still inside its 360-minute
    // tier interval plus the 75-minute grace: overdue, not yet stale. The
    // failure stays visible through last_error regardless.
    expect(meta.stale).toBe(false);
  });

  it('exposes per-region freshness in the meta so tool answers can cite the data age', async () => {
    const later = await sweepPartialFailure();

    const meta = getMarketSnapshotMeta(db as Db, DEFAULT_FRESHNESS, later);
    expect(meta.regions).toHaveLength(2);
    const forge = meta.regions.find((row) => row.region_id === FORGE);
    const domain = meta.regions.find((row) => row.region_id === DOMAIN);
    // Forge: 400 minutes old, inside its minor-tier 360 + 75 grace — not stale.
    expect(forge).toMatchObject({ fetched_at: T0.toISOString(), age_minutes: 400, stale: false });
    expect(forge?.last_error).toContain('exploded');
    expect(domain).toMatchObject({
      fetched_at: later.toISOString(),
      age_minutes: 0,
      stale: false,
      last_error: null,
    });
  });

  it('marks a region stale only past its own tier interval plus the grace allowance', async () => {
    const intervals = { majorMinPages: 100, majorIntervalMinutes: 30, minorIntervalMinutes: 360 };
    const freshness = { staleMinutes: 75, ...intervals };
    const first = makeFetcher({
      [FORGE]: { pages: 150 }, // major tier
      [DOMAIN]: { pages: 5, orders: (_region, page) => [makeOrder(43_000 + page)] }, // minor tier
    });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(first.fetchPage, intervals));

    // +300 minutes: the major region refetches, the minor one carries over —
    // a fully healthy book whose oldest rows are a 5-hour-old minor region,
    // exactly what the two-tier schedule is designed to serve.
    const fiveHours = new Date(T0.getTime() + 300 * MINUTES);
    const second = makeFetcher({ [FORGE]: { pages: 150 } });
    await loadMarketSnapshotFromEsi(db as Db, baseOptions(second.fetchPage, { ...intervals, now: fiveHours }));

    const healthy = getMarketSnapshotMeta(db as Db, freshness, fiveHours);
    expect(healthy.stale).toBe(false);
    const healthyDomain = healthy.regions.find((row) => row.region_id === DOMAIN);
    expect(healthyDomain).toMatchObject({ age_minutes: 300, stale: false });

    // Minor interval (360) + grace (75) + 1 minute of Domain age: past both,
    // and one stale region marks the whole book stale.
    const pastGrace = new Date(T0.getTime() + 436 * MINUTES);
    const aged = getMarketSnapshotMeta(db as Db, freshness, pastGrace);
    const agedDomain = aged.regions.find((row) => row.region_id === DOMAIN);
    expect(agedDomain).toMatchObject({ age_minutes: 436, stale: true });
    // The major tier's own deadline is 30 + 75: Forge went stale long before.
    const agedForge = aged.regions.find((row) => row.region_id === FORGE);
    expect(agedForge?.stale).toBe(true);
    expect(aged.stale).toBe(true);
  });
});

describe('createEsiOrdersPageFetcher', () => {
  it('requests the regional order book page and surfaces pagination headers', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify([{ order_id: 1 }]), {
        status: 200,
        headers: {
          'x-pages': '7',
          expires: new Date('2026-07-27T10:05:00Z').toUTCString(),
          'last-modified': new Date('2026-07-27T10:00:00Z').toUTCString(),
        },
      });
    }));

    const fetchPage = createEsiOrdersPageFetcher();
    const page = await fetchPage(FORGE, 3);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://esi.evetech.net/latest/markets/10000002/orders/?order_type=all&page=3');
    expect(seen[0].headers.get('user-agent')).toContain('EVEAI');
    expect(seen[0].headers.get('accept')).toBe('application/json');
    expect(page.pages).toBe(7);
    expect(Date.parse(page.expires ?? '')).toBe(Date.parse('2026-07-27T10:05:00Z'));
    expect(Date.parse(page.lastModified ?? '')).toBe(Date.parse('2026-07-27T10:00:00Z'));
    expect(page.orders).toEqual([{ order_id: 1 }]);
  });

  it('throws on a terminal ESI error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const fetchPage = createEsiOrdersPageFetcher();
    await expect(fetchPage(FORGE, 1)).rejects.toThrow(/HTTP 404/);
  });

  it('paces itself when ESI reports the error budget nearly exhausted', async () => {
    // The pool fires pages in parallel, but every response still goes through
    // throttleIfNeeded: x-esi-error-limit-remain <= 1 must park the worker for
    // ESI's own reset window (5s here) instead of hammering on.
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // kill backoff jitter: exactly 5000ms
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200,
      headers: {
        'x-pages': '1',
        'x-esi-error-limit-remain': '1',
        'x-esi-error-limit-reset': '5',
      },
    })));

    const fetchPage = createEsiOrdersPageFetcher();
    let settled = false;
    const pending = fetchPage(FORGE, 1).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });
});

describe('manual loader runtime lock', () => {
  it('refuses to run next to the live bot with a message naming the owner', () => {
    // The manual entry point and the bot service rebuild the same staging
    // table; the loader takes the same runtime lock so a busy production DB
    // fails fast with the owner's identity instead of "no such table" errors.
    const dir = mkdtempSync(path.join(tmpdir(), 'market-snapshot-lock-'));
    try {
      const dbPath = path.join(dir, 'eve-agent.db');
      const botLock = acquireRuntimeLock(dbPath, 'bot service');
      try {
        expect(() => acquireMarketSnapshotLoaderLock(dbPath)).toThrowError(
          /already owned by bot service \(pid \d+\)\. Stop it before starting market snapshot loader\./,
        );
      } finally {
        botLock.release();
      }

      // Once the owner is gone the manual run takes the lock normally.
      const lock = acquireMarketSnapshotLoaderLock(dbPath);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
