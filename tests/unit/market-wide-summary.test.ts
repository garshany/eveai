import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the ESI transport so the test never touches the network. The aggregator
// calls get_markets_prices once, then get_markets_region_id_orders per SDE-derived
// k-space trade region (regions with at least one stargate).
const mocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: mocks.callEsiOperation }));

import {
  executeMarketWideSummary,
  isMarketWideSummaryTool,
  MARKET_WIDE_SUMMARY_TOOL,
} from '../../src/eve/market-wide-summary.js';
// Budgets are read from config rather than restated here: these cases assert
// that the cap and the concurrency ceiling are enforced, not what today's
// numbers happen to be. Hardcoding them made the suite fail the moment the
// defaults were raised, which is churn, not coverage.
import { config } from '../../src/config.js';

const GILA = 17715;

let db: Database.Database;

function createSchema(): void {
  db.exec(`
    CREATE TABLE sde_regions (region_id INTEGER PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT NOT NULL, region_id INTEGER NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE sde_systems (system_id INTEGER PRIMARY KEY, name TEXT NOT NULL, constellation_id INTEGER NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER NOT NULL, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT NOT NULL);
    CREATE TABLE sde_stations (station_id INTEGER PRIMARY KEY, name TEXT NOT NULL, system_id INTEGER NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE sde_types (type_id INTEGER PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL);
  `);
}

let syntheticId = 1;

/** Register a k-space trade region (has stargates) with optional named stations. */
function addRegion(
  regionId: number,
  name: string,
  options: { stargates?: number; stations?: Array<{ station_id: number; name: string; system_id: number }>; system_name?: string } = {},
): void {
  const constellationId = 2_000_000 + syntheticId;
  const systemId = 3_000_000 + syntheticId;
  syntheticId += 1;
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)').run(regionId, name, '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
    .run(constellationId, `${name} constellation`, regionId, '{}');
  db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
    .run(systemId, options.system_name ?? `${name} system`, constellationId, '{}');
  const stargates = options.stargates ?? 1;
  for (let index = 0; index < stargates; index += 1) {
    db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, data_json) VALUES (?, ?, ?)')
      .run(5_000_000 + syntheticId * 100 + index, systemId, '{}');
  }
  for (const station of options.stations ?? []) {
    db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
      .run(station.station_id, station.name, station.system_id, '{}');
  }
}

/** Register a wormhole-like region (no stargates): must be excluded from the sweep. */
function addStargatelessRegion(regionId: number, name: string): void {
  const constellationId = 2_000_000 + syntheticId;
  const systemId = 3_100_000 + syntheticId;
  syntheticId += 1;
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)').run(regionId, name, '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
    .run(constellationId, `${name} constellation`, regionId, '{}');
  db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
    .run(systemId, `${name} system`, constellationId, '{}');
}

function order(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    order_id: Math.floor(Math.random() * 1e9),
    location_id: 60003760,
    system_id: 30000142,
    price: 100,
    volume_remain: 1,
    is_buy_order: false,
    ...overrides,
  };
}

type SummaryResult = {
  ok: boolean;
  error?: string;
  type_name?: string | null;
  global_reference?: { average_price?: number; adjusted_price?: number } | null;
  global_reference_error?: string | null;
  totals?: { sell_orders: number; buy_orders: number; sell_volume: number; buy_volume: number; regions_with_orders: number };
  best_sell?: {
    price: number; region_id: number; region_name: string; station_id: number;
    station_name: string | null; system_name: string | null; location_kind: string;
  } | null;
  best_buy?: {
    price: number; region_id: number; station_name: string | null; location_kind: string;
  } | null;
  regions?: Array<{ region_id: number; min_sell: number | null; max_buy: number | null }>;
  market_note?: string | null;
  coverage?: {
    complete: boolean;
    trade_regions_total: number;
    regions_queried: number;
    regions_failed: number;
    regions_skipped: number;
    failed_regions: Array<{ region_id: number; status: number | null }>;
    skipped_regions: Array<{ region_id: number }>;
    note: string | null;
  };
};

beforeEach(() => {
  db = new Database(':memory:');
  createSchema();
  syntheticId = 1;
  db.prepare('INSERT INTO sde_types (type_id, name, data_json) VALUES (?, ?, ?)').run(GILA, 'Gila', '{}');
  mocks.callEsiOperation.mockReset();
});

afterEach(() => db.close());

describe('market_wide_summary facade', () => {
  it('declares the strict tool contract', () => {
    expect(MARKET_WIDE_SUMMARY_TOOL).toMatchObject({
      name: 'market_wide_summary',
      strict: true,
      parameters: { required: ['type_id'], additionalProperties: false },
    });
    expect(isMarketWideSummaryTool('market_wide_summary')).toBe(true);
    expect(isMarketWideSummaryTool('batch_market_prices')).toBe(false);
  });

  it('rejects invalid arguments before any ESI egress', async () => {
    const result = (await executeMarketWideSummary(db as never, { type_id: -5 })) as SummaryResult;
    expect(result.ok).toBe(false);
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });

  it('aggregates orders across regions into an honest whole-market summary', async () => {
    addRegion(10000002, 'The Forge', {
      stargates: 5,
      stations: [{ station_id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', system_id: 3_000_001 }],
      system_name: 'Jita',
    });
    addRegion(10000043, 'Domain', {
      stargates: 3,
      stations: [{ station_id: 60008494, name: 'Amarr VIII (Oris) - Emperor Family Academy', system_id: 3_000_002 }],
      system_name: 'Amarr',
    });
    addRegion(10000032, 'Sinq Laison', { stargates: 2, system_name: 'Dodixie' });
    addStargatelessRegion(11000001, 'A-R00001');

    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string, args: Record<string, unknown>) => {
      if (operation === 'get_markets_prices') {
        return { ok: true, status: 200, data: [{ type_id: GILA, average_price: 512_000_000, adjusted_price: 500_000_000 }], cached: false, headers: {} };
      }
      if (operation === 'get_markets_region_id_orders') {
        if (args.region_id === 10000002) {
          return {
            ok: true, status: 200, cached: false, headers: {},
            data: [
              order({ price: 500_000_000, volume_remain: 3, location_id: 60003760, system_id: 3_000_001 }),
              order({ price: 450_000_000, volume_remain: 2, is_buy_order: true, location_id: 60003760, system_id: 3_000_001 }),
            ],
          };
        }
        if (args.region_id === 10000043) {
          return {
            ok: true, status: 200, cached: false, headers: {},
            data: [order({ price: 480_000_000, volume_remain: 1, location_id: 60008494, system_id: 3_000_002 })],
          };
        }
        if (args.region_id === 10000032) {
          return {
            ok: true, status: 200, cached: false, headers: {},
            data: [order({ price: 470_000_000, volume_remain: 5, is_buy_order: true, location_id: 1_030_000_000_001, system_id: 3_000_003 })],
          };
        }
        return { ok: false, status: 500, error: `unexpected region ${args.region_id}` };
      }
      return { ok: false, status: 500, error: `unexpected op ${operation}` };
    });

    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;

    expect(result.ok).toBe(true);
    expect(result.type_name).toBe('Gila');
    expect(result.global_reference).toEqual({ average_price: 512_000_000, adjusted_price: 500_000_000 });
    expect(result.global_reference_error).toBeNull();
    expect(result.totals).toEqual({
      sell_orders: 2,
      buy_orders: 2,
      sell_volume: 4,
      buy_volume: 7,
      regions_with_orders: 3,
    });

    // Cheapest sell lives in Domain, on the resolved NPC station.
    expect(result.best_sell).toMatchObject({
      price: 480_000_000,
      region_id: 10000043,
      region_name: 'Domain',
      station_id: 60008494,
      station_name: 'Amarr VIII (Oris) - Emperor Family Academy',
      system_name: 'Amarr',
      location_kind: 'npc_station',
    });
    // Highest buy lives in a player structure in Sinq Laison: honestly nameless.
    expect(result.best_buy).toMatchObject({
      price: 470_000_000,
      region_id: 10000032,
      station_name: null,
      location_kind: 'player_structure',
    });

    // Region breakdown is sorted by min sell ascending, buy-only regions last.
    expect(result.regions!.map((entry) => entry.region_id)).toEqual([10000043, 10000002, 10000032]);
    expect(result.regions![2].min_sell).toBeNull();

    // Full coverage: the stargate-less wormhole region was never queried.
    expect(result.coverage).toMatchObject({
      complete: true,
      trade_regions_total: 3,
      regions_queried: 3,
      regions_failed: 0,
      regions_skipped: 0,
      note: null,
    });
    const queriedRegions = mocks.callEsiOperation.mock.calls
      .filter((call) => call[1] === 'get_markets_region_id_orders')
      .map((call) => (call[2] as Record<string, unknown>).region_id);
    expect(queriedRegions.sort()).toEqual([10000002, 10000032, 10000043]);
    expect(result.market_note).toBeNull();
  });

  it('marks partial coverage explicitly when a region fails', async () => {
    addRegion(10000002, 'The Forge');
    addRegion(10000043, 'Domain');
    addRegion(10000032, 'Sinq Laison');

    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string, args: Record<string, unknown>) => {
      if (operation === 'get_markets_prices') {
        return { ok: true, status: 200, data: [], cached: false, headers: {} };
      }
      if (operation === 'get_markets_region_id_orders') {
        if (args.region_id === 10000043) return { ok: false, status: 503, error: 'ESI backend unavailable' };
        return { ok: true, status: 200, data: [order({ price: 100, volume_remain: 10 })], cached: false, headers: {} };
      }
      return { ok: false, status: 500, error: `unexpected op ${operation}` };
    });

    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;

    expect(result.ok).toBe(true);
    expect(result.coverage).toMatchObject({
      complete: false,
      trade_regions_total: 3,
      regions_queried: 3,
      regions_failed: 1,
      regions_skipped: 0,
    });
    expect(result.coverage!.failed_regions).toEqual([
      { region_id: 10000043, name: 'Domain', status: 503, error: 'ESI backend unavailable' },
    ]);
    expect(result.coverage!.note).toContain('PARTIAL COVERAGE');
    // Successful regions still produce data, labelled as a lower bound.
    expect(result.totals!.sell_orders).toBe(2);
    expect(result.best_sell!.price).toBe(100);
  });

  it('reports regions skipped by the max-regions cap as incomplete coverage', async () => {
    // Overshoot whatever the configured cap is, so the skip path is exercised
    // regardless of the current ESI_MARKET_WIDE_MAX_REGIONS value.
    const cap = config.esi.marketWideMaxRegions;
    const overshoot = 4;
    const total = cap + overshoot;
    for (let index = 0; index < total; index += 1) {
      addRegion(10_000_100 + index, `Region ${index}`);
    }
    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_markets_prices') return { ok: true, status: 200, data: [], cached: false, headers: {} };
      return { ok: true, status: 200, data: [], cached: false, headers: {} };
    });

    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;

    expect(result.ok).toBe(true);
    expect(result.coverage).toMatchObject({
      complete: false,
      trade_regions_total: total,
      regions_queried: cap,
      regions_failed: 0,
      regions_skipped: overshoot,
    });
    expect(result.coverage!.note).toContain('PARTIAL COVERAGE');
    const queriedRegions = mocks.callEsiOperation.mock.calls
      .filter((call) => call[1] === 'get_markets_region_id_orders');
    expect(queriedRegions).toHaveLength(cap);
  });

  it('bounds the regional fan-out to the configured concurrency', async () => {
    // More regions than the ceiling, so a breach would actually show up.
    const limit = config.esi.marketWideConcurrency;
    const regionCount = limit * 3;
    for (let index = 0; index < regionCount; index += 1) {
      addRegion(10_000_100 + index, `Region ${index}`);
    }
    let active = 0;
    let peak = 0;
    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_markets_prices') return { ok: true, status: 200, data: [], cached: false, headers: {} };
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ok: true, status: 200, data: [order({})], cached: false, headers: {} };
    });

    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;

    expect(result.ok).toBe(true);
    expect(mocks.callEsiOperation.mock.calls.filter((call) => call[1] === 'get_markets_region_id_orders')).toHaveLength(regionCount);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(limit);
  });

  it('answers honestly when no region has live orders', async () => {
    addRegion(10000002, 'The Forge');
    addRegion(10000043, 'Domain');
    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_markets_prices') {
        return { ok: true, status: 200, data: [{ type_id: GILA, average_price: 512_000_000 }], cached: false, headers: {} };
      }
      return { ok: true, status: 200, data: [], cached: false, headers: {} };
    });

    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;

    expect(result.ok).toBe(true);
    expect(result.totals).toMatchObject({ sell_orders: 0, buy_orders: 0, regions_with_orders: 0 });
    expect(result.best_sell).toBeNull();
    expect(result.best_buy).toBeNull();
    expect(result.regions).toEqual([]);
    expect(result.global_reference).toEqual({ average_price: 512_000_000 });
    expect(result.market_note).toContain('No live orders');
    expect(result.coverage!.complete).toBe(true);
  });

  it('fails honestly when the SDE has no stargate geography', async () => {
    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('stargate');
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });

  it('surfaces a global price-list failure without failing the sweep', async () => {
    addRegion(10000002, 'The Forge');
    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_markets_prices') return { ok: false, status: 500, error: 'boom' };
      return { ok: true, status: 200, data: [order({ price: 42 })], cached: false, headers: {} };
    });

    const result = (await executeMarketWideSummary(db as never, { type_id: GILA })) as SummaryResult;

    expect(result.ok).toBe(true);
    expect(result.global_reference).toBeNull();
    expect(result.global_reference_error).toContain('get_markets_prices failed');
    expect(result.best_sell!.price).toBe(42);
  });
});
