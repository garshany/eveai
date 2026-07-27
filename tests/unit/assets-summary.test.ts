import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: mocks.callEsiOperation }));

import {
  ASSETS_SUMMARY_TOOL,
  executeAssetsSummary,
  isAssetsSummaryTool,
} from '../../src/eve/assets-summary.js';

let db: Database.Database;
const ctx = { userId: 1, chatId: 1 };

const ASSET_ROWS = [
  { type_id: 34, location_id: 60003760, quantity: 1000, item_id: 1, is_singleton: false },
  { type_id: 35, location_id: 60003760, quantity: 100, item_id: 2, is_singleton: false },
  { type_id: 36, location_id: 30000142, quantity: 50, item_id: 3, is_singleton: false },
];

const MARKET_PRICES = [
  { type_id: 34, average_price: 5, adjusted_price: 4 },
  { type_id: 35, adjusted_price: 10 },
];

function mockEsi(): void {
  mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string) => {
    if (operation === 'get_characters_character_id_assets') {
      return { ok: true, status: 200, data: ASSET_ROWS, cached: false, headers: {} };
    }
    if (operation === 'get_markets_prices') {
      return { ok: true, status: 200, data: MARKET_PRICES, cached: false, headers: {} };
    }
    throw new Error(`unexpected operation ${operation}`);
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sde_types (type_id INTEGER PRIMARY KEY, name TEXT NOT NULL, group_id INTEGER, data_json TEXT NOT NULL);
    CREATE TABLE sde_stations (station_id INTEGER PRIMARY KEY, name TEXT NOT NULL, system_id INTEGER, data_json TEXT NOT NULL);
    CREATE TABLE sde_systems (system_id INTEGER PRIMARY KEY, name TEXT NOT NULL, constellation_id INTEGER, data_json TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO sde_types (type_id, name, data_json) VALUES (?, ?, ?)').run(34, 'Tritanium', '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, data_json) VALUES (?, ?, ?)').run(35, 'Pyerite', '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, data_json) VALUES (?, ?, ?)').run(36, 'Megacyte', '{}');
  db.prepare('INSERT INTO sde_stations (station_id, name, data_json) VALUES (?, ?, ?)')
    .run(60003760, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', '{}');
  db.prepare('INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)').run(30000142, 'Jita', '{}');
  mocks.callEsiOperation.mockReset();
});

afterEach(() => db.close());

describe('assets_summary facade', () => {
  it('declares the strict tool contract', () => {
    expect(ASSETS_SUMMARY_TOOL).toMatchObject({
      name: 'assets_summary',
      strict: true,
      parameters: { required: ['top'], additionalProperties: false },
    });
    expect(isAssetsSummaryTool('assets_summary')).toBe(true);
    expect(isAssetsSummaryTool('get_characters_character_id_assets')).toBe(false);
  });

  it('aggregates stacks, values items, and ranks the most expensive first', async () => {
    mockEsi();
    const result = await executeAssetsSummary(db as never, { top: null }, ctx as never);

    expect(result).toMatchObject({
      ok: true,
      coverage: { complete: true, asset_rows: 3 },
      totals: {
        distinct_types: 3,
        total_quantity: 1150,
        valued_types: 2,
        unvalued_types: 1,
        unvalued_quantity: 50,
        total_value_isk: 6000,
        average_priced_types: 1,
        adjusted_priced_types: 1,
      },
    });

    const topItems = result.top_items as Array<Record<string, unknown>>;
    expect(topItems).toHaveLength(2);
    expect(topItems[0]).toMatchObject({
      type_id: 34,
      name: 'Tritanium',
      quantity: 1000,
      unit_price: 5,
      price_kind: 'average',
      total_value: 5000,
    });
    expect(topItems[1]).toMatchObject({ type_id: 35, price_kind: 'adjusted', total_value: 1000 });

    const locations = result.top_locations as Array<Record<string, unknown>>;
    expect(locations[0]).toMatchObject({
      location_id: 60003760,
      name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
      total_value: 6000,
    });
    expect(locations[1]).toMatchObject({ location_id: 30000142, name: 'Jita', total_value: 0 });
  });

  it('widens the pagination budget for the private assets call only', async () => {
    mockEsi();
    await executeAssetsSummary(db as never, { top: null }, ctx as never);

    expect(mocks.callEsiOperation).toHaveBeenCalledWith(
      db,
      'get_characters_character_id_assets',
      {},
      ctx,
      expect.objectContaining({ maxPages: expect.any(Number) as number }),
    );
    const assetsGuard = mocks.callEsiOperation.mock.calls[0]?.[4] as { maxPages: number };
    expect(assetsGuard.maxPages).toBeGreaterThan(5);
    // The global price lookup keeps the generic guard (no page override).
    const pricesGuard = mocks.callEsiOperation.mock.calls[1]?.[4] as { maxPages?: number };
    expect(pricesGuard?.maxPages).toBeUndefined();
  });

  it('reports honestly when assets exceed the page budget', async () => {
    mocks.callEsiOperation.mockResolvedValue({
      ok: false,
      status: 422,
      error: 'ESI pagination requires 30 pages, exceeds configured per-call page budget=25.',
    });
    const result = await executeAssetsSummary(db as never, { top: null }, ctx as never);

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('ESI_ASSETS_MAX_PAGES');
    expect(String(result.error)).toContain('30 pages');
  });

  it('surfaces private ESI auth failures unchanged', async () => {
    mocks.callEsiOperation.mockResolvedValue({ ok: false, status: 401, error: 'No linked EVE character.' });
    const result = await executeAssetsSummary(db as never, { top: null }, ctx as never);

    expect(result).toMatchObject({ ok: false, status: 401, error: 'No linked EVE character.' });
  });

  it('rejects invalid top values without calling ESI', async () => {
    for (const top of [0, 21, 1.5, '10']) {
      const result = await executeAssetsSummary(db as never, { top }, ctx as never);
      expect(result.ok).toBe(false);
    }
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });

  it('caps the returned top list at the requested size', async () => {
    mocks.callEsiOperation.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_characters_character_id_assets') {
        return {
          ok: true,
          status: 200,
          data: Array.from({ length: 15 }, (_, index) => ({
            type_id: 100 + index,
            location_id: 60003760,
            quantity: 10,
            item_id: index,
            is_singleton: false,
          })),
          cached: false,
          headers: {},
        };
      }
      return {
        ok: true,
        status: 200,
        data: Array.from({ length: 15 }, (_, index) => ({ type_id: 100 + index, average_price: index + 1 })),
        cached: false,
        headers: {},
      };
    });

    const result = await executeAssetsSummary(db as never, { top: 3 }, ctx as never);
    const topItems = result.top_items as Array<{ type_id: number; total_value: number }>;
    expect(topItems).toHaveLength(3);
    expect(topItems[0]?.type_id).toBe(114);
    expect(topItems.map((item) => item.total_value)).toEqual([150, 140, 130]);
  });
});
