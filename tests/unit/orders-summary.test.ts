import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: mocks.callEsiOperation }));

import {
  CHARACTER_ORDERS_SUMMARY_TOOL,
  executeCharacterOrdersSummary,
  isCharacterOrdersSummaryTool,
} from '../../src/eve/orders-summary.js';

let db: Database.Database;
const ctx = { userId: 1, chatId: 1 };

const ORDER_ROWS = [
  {
    order_id: 1, type_id: 34, region_id: 10000002, location_id: 60003760,
    price: 10, volume_remain: 500, volume_total: 1000, is_buy_order: false,
    issued: new Date(Date.now() - 10 * 86_400_000).toISOString(), duration: 90,
  },
  {
    order_id: 2, type_id: 35, region_id: 10000002, location_id: 60003760,
    price: 20, volume_remain: 100, volume_total: 100, is_buy_order: false,
    issued: new Date(Date.now() - 89 * 86_400_000).toISOString(), duration: 90,
  },
  {
    order_id: 3, type_id: 36, region_id: 10000043, location_id: 60008494,
    price: 50, volume_remain: 40, volume_total: 40, is_buy_order: true, escrow: 2000,
    issued: new Date(Date.now() - 5 * 86_400_000).toISOString(), duration: 30,
  },
];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sde_types (type_id INTEGER PRIMARY KEY, name TEXT NOT NULL, group_id INTEGER, data_json TEXT NOT NULL);
    CREATE TABLE sde_regions (region_id INTEGER PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL);
  `);
  const insertType = db.prepare('INSERT INTO sde_types (type_id, name, data_json) VALUES (?, ?, ?)');
  insertType.run(34, 'Tritanium', '{}');
  insertType.run(35, 'Pyerite', '{}');
  insertType.run(36, 'Megacyte', '{}');
  const insertRegion = db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)');
  insertRegion.run(10000002, 'The Forge', '{}');
  insertRegion.run(10000043, 'Domain', '{}');
  mocks.callEsiOperation.mockReset();
  mocks.callEsiOperation.mockResolvedValue({ ok: true, status: 200, data: ORDER_ROWS, cached: false, headers: {} });
});

afterEach(() => db.close());

describe('character_orders_summary facade', () => {
  it('declares the strict tool contract', () => {
    expect(CHARACTER_ORDERS_SUMMARY_TOOL).toMatchObject({
      name: 'character_orders_summary',
      strict: true,
      parameters: { required: ['top'], additionalProperties: false },
    });
    expect(isCharacterOrdersSummaryTool('character_orders_summary')).toBe(true);
    expect(isCharacterOrdersSummaryTool('get_characters_character_id_orders')).toBe(false);
  });

  it('aggregates sell value, buy escrow, regions, and expiry deterministically', async () => {
    const result = await executeCharacterOrdersSummary(db as never, { top: null }, ctx as never);

    expect(mocks.callEsiOperation).toHaveBeenCalledWith(
      db, 'get_characters_character_id_orders', {}, ctx, {},
    );
    expect(result).toMatchObject({
      ok: true,
      totals: {
        orders: 3,
        sell_orders: 2,
        buy_orders: 1,
        sell_value_isk: 7000,
        buy_escrow_isk: 2000,
        expiring_soon_count: 1,
      },
    });

    const topSell = result.top_sell_orders as Array<Record<string, unknown>>;
    expect(topSell.map((order) => order.order_id)).toEqual([1, 2]);
    expect(topSell[0]).toMatchObject({ name: 'Tritanium', remaining_value: 5000 });

    const expiring = result.expiring_soon as Array<Record<string, unknown>>;
    expect(expiring).toHaveLength(1);
    expect(expiring[0]?.order_id).toBe(2);
    expect(typeof expiring[0]?.expires_at).toBe('string');

    const regions = result.regions as Array<Record<string, unknown>>;
    expect(regions[0]).toMatchObject({ region_id: 10000002, name: 'The Forge', orders: 2, sell_value: 7000 });
    expect(regions[1]).toMatchObject({ region_id: 10000043, name: 'Domain', orders: 1, escrow: 2000 });
  });

  it('surfaces ESI failures unchanged', async () => {
    mocks.callEsiOperation.mockResolvedValue({ ok: false, status: 403, error: 'Missing scopes: esi-markets.read_character_orders.v1' });
    const result = await executeCharacterOrdersSummary(db as never, { top: null }, ctx as never);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects invalid top values without calling ESI', async () => {
    for (const top of [0, 21, -1, '5']) {
      const result = await executeCharacterOrdersSummary(db as never, { top }, ctx as never);
      expect(result.ok).toBe(false);
    }
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });
});
