import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  getMarketGroupTree,
  getMarketGroupTypes,
  getRegionalComparison,
  getTypeOrders,
  getTypeOverview,
  searchMarketTypes,
} from '../../src/eve/market-queries.js';

const FORGE = 10000002;
const DOMAIN = 10000043;
const JITA = 30000142;
const AMARR = 30002187;
const JITA_STATION = 60003760;
const AMARR_STATION = 60008494;

const TRITANIUM = 34;
const PYERITE = 35;
const MEXALLON = 36;
const TRITANIUM_BARS = 1234;
const COMPRESSED_TRITANIUM = 5678;
const UNPUBLISHED_WIDGET = 9999;
const LOOSE_WIDGET = 9998;

let db: Database.Database;

function insertType(
  typeId: number,
  name: string,
  groupId: number | null,
  data: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(typeId, name, groupId, JSON.stringify(data));
}

function insertMarketGroup(groupId: number, name: string, parentGroupId: number | null): void {
  db.prepare('INSERT INTO sde_market_groups (market_group_id, name, parent_group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(groupId, name, parentGroupId, '{}');
}

function insertOrder(overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    order_id: 1,
    type_id: TRITANIUM,
    region_id: FORGE,
    system_id: JITA,
    station_id: JITA_STATION,
    location_id: JITA_STATION,
    is_buy_order: 0,
    price: 5.5,
    volume_remain: 1000,
    volume_total: 1000,
    min_volume: 1,
    duration: 90,
    range: 'region',
    issued: '2026-07-27T09:55:00Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.order_id, row.type_id, row.region_id, row.system_id, row.station_id, row.location_id,
    row.is_buy_order, row.price, row.volume_remain, row.volume_total, row.min_volume,
    row.duration, row.range, row.issued,
  );
}

function seedSde(): void {
  db.prepare("INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (18, 'Mineral', 3, '{}')").run();
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'The Forge', '{}')").run(FORGE);
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'Domain', '{}')").run(DOMAIN);
  db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, 'Jita', NULL, '{}')").run(JITA);
  db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, 'Amarr', NULL, '{}')").run(AMARR);
  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(JITA_STATION, 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', JITA, '{}');
  db.prepare('INSERT INTO sde_stations (station_id, name, system_id, data_json) VALUES (?, ?, ?, ?)')
    .run(AMARR_STATION, 'Amarr VIII (Oris) - Emperor Family Academy', AMARR, '{}');

  insertType(TRITANIUM, 'Tritanium', 18, { published: true, marketGroupID: 5 });
  insertType(TRITANIUM_BARS, 'Tritanium Bars', 18, { published: true, marketGroupID: 5 });
  insertType(COMPRESSED_TRITANIUM, 'Compressed Tritanium', 18, { published: true, marketGroupID: 6 });
  insertType(PYERITE, 'Pyerite', 18, { published: true, marketGroupID: 5 });
  insertType(MEXALLON, 'Mexallon', 18, { published: true, marketGroupID: 6 });
  insertType(UNPUBLISHED_WIDGET, 'Unpublished Widget', 18, { published: false, marketGroupID: 5 });
  insertType(LOOSE_WIDGET, 'Loose Widget', 18, { published: true });

  insertMarketGroup(200, 'Materials', null);
  insertMarketGroup(100, 'Ships', null);
  insertMarketGroup(201, 'Minerals', 200);
  insertMarketGroup(202, 'Veldspar', 201);
}

function seedOrders(): void {
  // Tritanium in The Forge: three sells (one anchored in a player structure),
  // three buys.
  insertOrder({ order_id: 1, price: 5.5, volume_remain: 1000 });
  insertOrder({ order_id: 2, price: 5.1, volume_remain: 500 });
  insertOrder({
    order_id: 3, price: 6.0, volume_remain: 250,
    station_id: null, location_id: 1_039_000_000_001,
  });
  insertOrder({ order_id: 4, is_buy_order: 1, price: 4.9, volume_remain: 2000 });
  insertOrder({ order_id: 5, is_buy_order: 1, price: 4.5, volume_remain: 100 });
  insertOrder({ order_id: 6, is_buy_order: 1, price: 4.95, volume_remain: 300 });

  // Tritanium in Domain.
  insertOrder({
    order_id: 7, region_id: DOMAIN, system_id: AMARR, station_id: AMARR_STATION,
    location_id: AMARR_STATION, price: 7.0, volume_remain: 100,
  });
  insertOrder({
    order_id: 8, region_id: DOMAIN, system_id: AMARR, station_id: AMARR_STATION,
    location_id: AMARR_STATION, is_buy_order: 1, price: 6.5, volume_remain: 50,
  });

  // Pyerite: buy-only in The Forge, both sides in Domain.
  insertOrder({ order_id: 9, type_id: PYERITE, is_buy_order: 1, price: 8.0, volume_remain: 400 });
  insertOrder({
    order_id: 10, type_id: PYERITE, region_id: DOMAIN, system_id: AMARR,
    station_id: AMARR_STATION, location_id: AMARR_STATION, price: 9.0, volume_remain: 60,
  });
  insertOrder({
    order_id: 11, type_id: PYERITE, region_id: DOMAIN, system_id: AMARR,
    station_id: AMARR_STATION, location_id: AMARR_STATION, is_buy_order: 1,
    price: 8.5, volume_remain: 70,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  seedSde();
  seedOrders();
});

afterEach(() => {
  db.close();
});

describe('market schema tables', () => {
  it('creates the phase-1 tables and indexes', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'market_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'market_price_history',
      'market_history_sync',
      'market_watchlist',
      'market_price_alerts',
      'market_alert_events',
    ]));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_market_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = indexes.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      'idx_market_history_sync_due',
      'idx_market_price_alerts_user_status',
      'idx_market_alert_events_user',
    ]));
    // Dropped indexes: history reads all go through the (region_id, type_id,
    // date) PK, and alert claims/lookups use the PK and (user_id, status).
    expect(names).not.toContain('idx_market_price_history_type_date');
    expect(names).not.toContain('idx_market_alerts_active');
  });
});

describe('searchMarketTypes', () => {
  it('ranks exact matches first, then prefix, then substring', () => {
    const rows = searchMarketTypes(db as Db, 'tritanium');
    expect(rows.map((row) => row.type_id)).toEqual([TRITANIUM, TRITANIUM_BARS, COMPRESSED_TRITANIUM]);
    expect(rows[0]).toEqual({
      type_id: TRITANIUM,
      name: 'Tritanium',
      group_id: 18,
      market_group_id: 5,
    });
  });

  it('matches case-insensitively', () => {
    const rows = searchMarketTypes(db as Db, 'TRITANIUM');
    expect(rows.map((row) => row.type_id)).toEqual([TRITANIUM, TRITANIUM_BARS, COMPRESSED_TRITANIUM]);
  });

  it('excludes unpublished types and types without a market group', () => {
    expect(searchMarketTypes(db as Db, 'widget')).toEqual([]);
  });

  it('respects the limit', () => {
    const rows = searchMarketTypes(db as Db, 'tritanium', 2);
    expect(rows.map((row) => row.type_id)).toEqual([TRITANIUM, TRITANIUM_BARS]);
  });

  it('returns nothing for empty queries and unknown names', () => {
    expect(searchMarketTypes(db as Db, '')).toEqual([]);
    expect(searchMarketTypes(db as Db, '   ')).toEqual([]);
    expect(searchMarketTypes(db as Db, 'no such item')).toEqual([]);
  });

  it('treats LIKE wildcards as literal characters', () => {
    expect(searchMarketTypes(db as Db, '%')).toEqual([]);
    expect(searchMarketTypes(db as Db, '_')).toEqual([]);
  });
});

describe('getTypeOverview', () => {
  it('aggregates best prices, volumes, order counts and the spread', () => {
    const overview = getTypeOverview(db as Db, TRITANIUM, FORGE);
    expect(overview).toMatchObject({
      type_id: TRITANIUM,
      type_name: 'Tritanium',
      group_id: 18,
      group_name: 'Mineral',
      market_group_id: 5,
      region_id: FORGE,
      best_sell: 5.1,
      best_buy: 4.95,
      sell_volume: 1750,
      buy_volume: 2400,
      sell_orders: 3,
      buy_orders: 3,
    });
    expect(overview?.spread_abs).toBeCloseTo(0.15, 6);
    expect(overview?.spread_pct).toBeCloseTo(2.94, 2);
  });

  it('reports a buy-only book with a null sell side and no spread', () => {
    const overview = getTypeOverview(db as Db, PYERITE, FORGE);
    expect(overview).toMatchObject({
      type_id: PYERITE,
      best_sell: null,
      best_buy: 8.0,
      sell_volume: 0,
      buy_volume: 400,
      sell_orders: 0,
      buy_orders: 1,
      spread_abs: null,
      spread_pct: null,
    });
  });

  it('returns zeroed aggregates for a known type with an empty book', () => {
    const overview = getTypeOverview(db as Db, MEXALLON, FORGE);
    expect(overview).toMatchObject({
      type_id: MEXALLON,
      type_name: 'Mexallon',
      best_sell: null,
      best_buy: null,
      sell_volume: 0,
      buy_volume: 0,
      sell_orders: 0,
      buy_orders: 0,
      spread_abs: null,
      spread_pct: null,
    });
  });

  it('returns null for a type missing from the local SDE', () => {
    expect(getTypeOverview(db as Db, 424242, FORGE)).toBeNull();
  });
});

describe('getTypeOrders', () => {
  it('lists sells cheapest first with resolved location names', () => {
    const rows = getTypeOrders(db as Db, {
      typeId: TRITANIUM, regionId: FORGE, side: 'sell', limit: 10, offset: 0,
    });
    expect(rows.map((row) => row.order_id)).toEqual([2, 1, 3]);
    expect(rows.map((row) => row.price)).toEqual([5.1, 5.5, 6.0]);
    expect(rows.every((row) => row.is_buy_order === false)).toBe(true);

    expect(rows[0].location_name).toBe('Jita IV - Moon 4 - Caldari Navy Assembly Plant');
    expect(rows[0].system_name).toBe('Jita');

    // Player-structure order: no station row, so no resolvable name.
    expect(rows[2].station_id).toBeNull();
    expect(rows[2].location_id).toBe(1_039_000_000_001);
    expect(rows[2].location_name).toBeNull();
    expect(rows[2].system_name).toBe('Jita');
  });

  it('lists buys highest first', () => {
    const rows = getTypeOrders(db as Db, {
      typeId: TRITANIUM, regionId: FORGE, side: 'buy', limit: 10, offset: 0,
    });
    expect(rows.map((row) => row.order_id)).toEqual([6, 4, 5]);
    expect(rows.map((row) => row.price)).toEqual([4.95, 4.9, 4.5]);
    expect(rows.every((row) => row.is_buy_order === true)).toBe(true);
  });

  it('paginates with limit and offset', () => {
    const page = getTypeOrders(db as Db, {
      typeId: TRITANIUM, regionId: FORGE, side: 'sell', limit: 1, offset: 1,
    });
    expect(page.map((row) => row.order_id)).toEqual([1]);
  });

  it('scopes rows to the requested region and side', () => {
    const rows = getTypeOrders(db as Db, {
      typeId: PYERITE, regionId: DOMAIN, side: 'sell', limit: 10, offset: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe(10);
    expect(rows[0].location_name).toBe('Amarr VIII (Oris) - Emperor Family Academy');
  });

  it('returns an empty list for an empty book', () => {
    expect(getTypeOrders(db as Db, {
      typeId: MEXALLON, regionId: FORGE, side: 'sell', limit: 10, offset: 0,
    })).toEqual([]);
  });
});

describe('getRegionalComparison', () => {
  it('compares regions with aggregates, cheapest sell first', () => {
    const rows = getRegionalComparison(db as Db, TRITANIUM);
    expect(rows.map((row) => row.region_id)).toEqual([FORGE, DOMAIN]);
    expect(rows[0]).toEqual({
      region_id: FORGE,
      region_name: 'The Forge',
      min_sell: 5.1,
      max_buy: 4.95,
      sell_volume: 1750,
      buy_volume: 2400,
      sell_orders: 3,
      buy_orders: 3,
    });
    expect(rows[1]).toMatchObject({
      region_id: DOMAIN,
      region_name: 'Domain',
      min_sell: 7.0,
      max_buy: 6.5,
      sell_volume: 100,
      buy_volume: 50,
      sell_orders: 1,
      buy_orders: 1,
    });
  });

  it('sorts buy-only regions after regions with sell orders', () => {
    const rows = getRegionalComparison(db as Db, PYERITE);
    expect(rows.map((row) => row.region_id)).toEqual([DOMAIN, FORGE]);
    expect(rows[0].min_sell).toBe(9.0);
    expect(rows[1].min_sell).toBeNull();
    expect(rows[1].max_buy).toBe(8.0);
  });

  it('returns an empty list when no region lists the type', () => {
    expect(getRegionalComparison(db as Db, MEXALLON)).toEqual([]);
  });
});

describe('getMarketGroupTree', () => {
  it('lists root groups with a has_children flag', () => {
    expect(getMarketGroupTree(db as Db, null)).toEqual([
      { market_group_id: 200, name: 'Materials', parent_group_id: null, has_children: true },
      { market_group_id: 100, name: 'Ships', parent_group_id: null, has_children: false },
    ]);
  });

  it('lists the children of a group', () => {
    expect(getMarketGroupTree(db as Db, 200)).toEqual([
      { market_group_id: 201, name: 'Minerals', parent_group_id: 200, has_children: true },
    ]);
    expect(getMarketGroupTree(db as Db, 201)).toEqual([
      { market_group_id: 202, name: 'Veldspar', parent_group_id: 201, has_children: false },
    ]);
  });

  it('returns an empty list for a leaf or unknown group', () => {
    expect(getMarketGroupTree(db as Db, 202)).toEqual([]);
    expect(getMarketGroupTree(db as Db, 999)).toEqual([]);
  });
});

describe('getMarketGroupTypes', () => {
  it('lists published types of a group, alphabetical, case-insensitive', () => {
    const rows = getMarketGroupTypes(db as Db, 5, 20);
    expect(rows.map((row) => row.type_id)).toEqual([PYERITE, TRITANIUM, TRITANIUM_BARS]);
    expect(rows[0]).toEqual({
      type_id: PYERITE,
      name: 'Pyerite',
      group_id: 18,
      market_group_id: 5,
    });
  });

  it('excludes unpublished types from the listing', () => {
    const rows = getMarketGroupTypes(db as Db, 6, 20);
    expect(rows.map((row) => row.type_id)).toEqual([COMPRESSED_TRITANIUM, MEXALLON]);
  });

  it('respects the limit and returns nothing for empty groups', () => {
    expect(getMarketGroupTypes(db as Db, 5, 2).map((row) => row.type_id)).toEqual([PYERITE, TRITANIUM]);
    expect(getMarketGroupTypes(db as Db, 202, 20)).toEqual([]);
  });
});
