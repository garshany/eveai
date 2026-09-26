import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  hubPrices,
  resetMarketAgentToolCacheForTests,
  resolveItems,
  TRADE_HUBS,
} from '../../src/eve/market-agent-tools.js';

let db: Database.Database;

function type(typeId: number, en: string, ru: string | null, marketGroupId: number | null = 18, published = 1): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, 18, ?)').run(
    typeId,
    en,
    JSON.stringify({ name: ru ? { en, ru } : en, marketGroupID: marketGroupId, published }),
  );
}

function order(orderId: number, typeId: number, hub: keyof typeof TRADE_HUBS | 'structure', isBuy: boolean, price: number, volume: number): void {
  const station = hub === 'structure' ? { stationId: 1_030_000_000_000, regionId: 10000002 } : TRADE_HUBS[hub];
  db.prepare(`
    INSERT INTO market_orders (order_id, type_id, region_id, system_id, station_id, location_id, is_buy_order,
      price, volume_remain, volume_total, min_volume, duration, range, issued)
    VALUES (?, ?, ?, 30000142, ?, ?, ?, ?, ?, ?, 1, 90, 'region', '2026-09-26T00:00:00Z')
  `).run(orderId, typeId, station.regionId, station.stationId, station.stationId, isBuy ? 1 : 0, price, volume, volume);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  resetMarketAgentToolCacheForTests();
  type(34, 'Tritanium', 'Тританиум');
  type(62568, 'Compressed Tritanium', 'Сжатый тританиум');
  type(44992, 'PLEX', 'PLEX');
  type(40520, 'Large Skill Injector', 'Большой инжектор нейронавыков');
  type(587, 'Rifter', 'Рифтер');
  type(999, 'Unpublished Rifter', null, 18, 0);
  type(998, 'Rifter Blueprint Thing', null, null);
});

afterEach(() => db.close());

describe('resolve_items', () => {
  it('resolves English and Russian names, slang and typos to tradeable types', () => {
    const [english, russian, slang, typo, prefix] = resolveItems(db, ['tritanium', 'Рифтер', 'плекс', 'Tritanuim', 'трит']);
    expect(english.matches[0]).toMatchObject({ type_id: 34, match: 'exact' });
    expect(russian.matches[0]).toMatchObject({ type_id: 587, match: 'exact', name_ru: 'Рифтер' });
    expect(slang.matches[0]).toMatchObject({ type_id: 44992, match: 'alias' });
    expect(typo.matches[0]).toMatchObject({ type_id: 34, match: 'fuzzy' });
    expect(prefix.matches[0]).toMatchObject({ type_id: 34, match: 'alias' });
  });

  it('ranks the canonical item first and never returns unpublished or off-market types', () => {
    const [rifter] = resolveItems(db, ['rifter'], 5);
    expect(rifter.matches.map((match) => match.type_id)).toEqual([587]);
    const [partial] = resolveItems(db, ['tritan'], 5);
    expect(partial.matches.map((match) => match.type_id)).toEqual([34, 62568]);
    expect(resolveItems(db, ['zzzzqqq'])[0].matches).toEqual([]);
  });
});

describe('hub_prices', () => {
  it('prices at the hub station only, ignoring other stations of the region', () => {
    order(1, 34, 'jita', false, 4.2, 1000);
    order(2, 34, 'jita', false, 4.5, 5000);
    order(3, 34, 'structure', false, 3.1, 1_000_000); // cheaper, but not at Jita 4-4
    order(4, 34, 'jita', true, 4.0, 2000);
    order(5, 34, 'amarr', false, 4.8, 300);

    const { items } = hubPrices(db, [34], ['jita', 'amarr'], null);
    const [jita, amarr] = items[0].hubs;
    expect(items[0].name).toBe('Tritanium');
    expect(jita).toMatchObject({
      hub: 'jita',
      sell: { best: 4.2, volume: 6000, orders: 2 },
      buy: { best: 4.0, volume: 2000, orders: 1 },
      spread_percent: 4.76,
    });
    expect(amarr).toMatchObject({ hub: 'amarr', sell: { best: 4.8 }, buy: { best: null }, spread_percent: null });
  });

  it('walks the book for a quantity and says when it cannot fill', () => {
    order(1, 34, 'jita', false, 4.0, 1000);
    order(2, 34, 'jita', false, 5.0, 1000);
    order(3, 34, 'jita', true, 3.0, 500);

    const [jita] = hubPrices(db, [34], ['jita'], 1500).items[0].hubs;
    expect(jita.buy_fill).toEqual({ average_price: 4.33, filled: 1500, fillable: true, total_isk: 6500 });
    expect(jita.sell_fill).toEqual({ average_price: 3, filled: 500, fillable: false, total_isk: 1500 });
  });
});
