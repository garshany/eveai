import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { parseItemLines, appraiseLocally, fetchJaniceAppraisal } from '../../src/community/appraise.js';
import {
  fetchIndustryCost,
  fetchZkillStats,
  fetchAbyssalListings,
  resetCommunityCacheForTests,
} from '../../src/community/clients.js';
import { COMMUNITY_TOOLS, isCommunityToolName } from '../../src/community/tools.js';
import { getToolPolicy } from '../../src/agent/tools.js';
import { config } from '../../src/config.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetCommunityCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseItemLines', () => {
  it('parses inventory copies, xN suffixes, bare names and merges duplicates', () => {
    const parsed = parseItemLines([
      'Tritanium\t1 200\tMineral',
      'Rifter x3',
      'Hobgoblin II',
      'rifter', // merges with "Rifter x3" case-insensitively
      'Warp Scrambler II 2',
    ].join('\n'));
    const byKey = new Map(parsed.map((line) => [line.name.toLowerCase(), line.quantity]));
    expect(byKey.get('tritanium')).toBe(1200);
    expect(byKey.get('rifter')).toBe(4);
    expect(byKey.get('hobgoblin ii')).toBe(1);
    expect(byKey.get('warp scrambler ii')).toBe(2);
    // Original casing survives for SDE resolution.
    expect(parsed.find((line) => line.name.toLowerCase() === 'tritanium')?.name).toBe('Tritanium');
  });

  it('supports leading-quantity formats "1200 Tritanium" and "3x Rifter"', () => {
    const parsed = parseItemLines('1200 Tritanium\n3x Rifter\n3 x Ibis');
    const byKey = new Map(parsed.map((line) => [line.name.toLowerCase(), line.quantity]));
    expect(byKey.get('tritanium')).toBe(1200);
    expect(byKey.get('rifter')).toBe(3);
    expect(byKey.get('ibis')).toBe(3);
  });

  it('does not mistake fractions or shifted columns for quantities', () => {
    // "1.5" is a volume, not a quantity — must not become 15.
    expect(parseItemLines('Veldspar 1.5')).toEqual([{ name: 'Veldspar 1.5', quantity: 1 }]);
    // Inventory copy with an EMPTY quantity cell: the volume column must not
    // shift into the quantity slot.
    expect(parseItemLines('Damage Control II\t\t0.05\tModule'))
      .toEqual([{ name: 'Damage Control II', quantity: 1 }]);
  });

  it('keeps a trailing token as part of the name when the name ends with a digit', () => {
    const parsed = parseItemLines('Item Mk2 5');
    expect(parsed).toEqual([{ name: 'Item Mk2 5', quantity: 1 }]);
  });

  it('caps input at 200 lines', () => {
    const text = Array.from({ length: 300 }, (_, i) => `Unique Item ${'X'.repeat((i % 5) + 1)}${i}`).join('\n');
    expect(parseItemLines(text).length).toBeLessThanOrEqual(200);
  });
});

describe('appraiseLocally', () => {
  function seedDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO sde_types (type_id, name, data_json) VALUES (34, 'Tritanium', '{\"published\": true}')").run();
    return db;
  }

  it('prices resolved items from the market book and reports unresolved names', () => {
    const db = seedDb();
    db.prepare(`INSERT INTO market_orders
      (order_id, region_id, type_id, location_id, system_id, station_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, issued, range)
      VALUES (1, 10000002, 34, 60003760, 30000142, 60003760, 0, 4.0, 1000, 1000, 1, 90, '2026-07-27T00:00:00Z', 'region')`).run();
    db.prepare(`INSERT INTO market_orders
      (order_id, region_id, type_id, location_id, system_id, station_id, is_buy_order, price, volume_remain, volume_total, min_volume, duration, issued, range)
      VALUES (2, 10000002, 34, 60003760, 30000142, 60003760, 1, 3.5, 1000, 1000, 1, 90, '2026-07-27T00:00:00Z', 'region')`).run();

    const result = appraiseLocally(db, parseItemLines('tritanium x100\nNonexistent Junk'), 10000002);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ typeId: 34, name: 'Tritanium', quantity: 100, bestSell: 4.0, bestBuy: 3.5 });
    expect(result.totals.sell).toBeCloseTo(400);
    expect(result.totals.buy).toBeCloseTo(350);
    expect(result.unresolved).toEqual(['Nonexistent Junk']);
    db.close();
  });

  it('resolves case-insensitively via the NOCASE index and prefers published types', () => {
    const db = seedDb();
    // Same name, unpublished duplicate with a lower type_id.
    db.prepare("INSERT INTO sde_types (type_id, name, data_json) VALUES (33, 'Tritanium', '{\"published\": false}')").run();
    const result = appraiseLocally(db, parseItemLines('TRITANIUM'), 10000002);
    expect(result.items[0]?.typeId).toBe(34);
    db.close();
  });

  it('returns null prices for items with no orders instead of fake zeros', () => {
    const db = seedDb();
    db.prepare("INSERT INTO sde_types (type_id, name, data_json) VALUES (587, 'Rifter', '{\"published\": true}')").run();
    const result = appraiseLocally(db, parseItemLines('Rifter'), 10000002);
    expect(result.items[0].bestSell).toBeNull();
    expect(result.items[0].sellTotal).toBeNull();
    expect(result.totals.itemsPriced).toBe(0);
    db.close();
  });
});

describe('fetchJaniceAppraisal', () => {
  it('returns null without a configured key and never calls the network', async () => {
    const result = await fetchJaniceAppraisal('Tritanium x100', 10000002);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('community clients', () => {
  it('industry cost passes through the EVE Ref payload and caches it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ manufacturing: { '587': { product_id: 587 } } }));
    const first = await fetchIndustryCost({ productId: 587, runs: 1 });
    const second = await fetchIndustryCost({ productId: 587, runs: 1 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second hit came from cache
  });

  it('industry cost rejects non-finite runs and drops NaN me/te instead of sending them upstream', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const bad = await fetchIndustryCost({ productId: 587, runs: Number.NaN });
    expect(bad.ok).toBe(false);
    await fetchIndustryCost({ productId: 587, runs: 1, meLevel: Number.NaN, teLevel: Number.NaN });
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).not.toContain('NaN');
  });

  it('zkill stats: activity is keyed by DAY of week, hours come from the inner keys', async () => {
    // Shape cut from the live /api/stats/ payload (2026-07-27): outer keys of
    // `activity` are days 0..6 (+max/days), inner keys are hours of day.
    fetchMock.mockResolvedValue(jsonResponse({
      dangerRatio: 87,
      gangRatio: 40,
      shipsDestroyed: 6433,
      shipsLost: 20,
      topAllTime: [
        { type: 'ship', data: [{ shipTypeID: 17738, kills: 900 }, { shipTypeID: 587, kills: 400 }] },
      ],
      topLists: [
        { type: 'shipType', values: [{ shipTypeID: 11987, shipName: 'Guardian', kills: 21 }] },
      ],
      activity: {
        '0': { '18': 11, '19': 5, '20': 11, '21': 1 },
        '1': { '18': 7, '19': 9 },
        '5': { '20': 4 },
        max: 11,
        days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      },
    }));
    const result = await fetchZkillStats('character', 93245637);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dangerRatio).toBe(87);
      // All-time favourites win over the weekly list.
      expect(result.data.topShips[0]).toEqual({ shipTypeId: 17738, shipName: null, kills: 900 });
      // Hours of day, not day indices: 18 has 11+7=18 kills, 19 has 14, 20 has 15.
      expect(result.data.activeHoursUtc).toEqual([18, 20, 19]);
      // Day indices 0..6 must never leak through as "hours".
      expect(result.data.activeHoursUtc.every((hour) => hour >= 18 && hour <= 21)).toBe(true);
    }
  });

  it('zkill falls back to the weekly ship list when topAllTime is absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      dangerRatio: 10,
      topLists: [{ type: 'shipType', values: [{ shipTypeID: 11987, shipName: 'Guardian', kills: 21 }] }],
      activity: { '0': { '18': 2 } },
    }));
    const result = await fetchZkillStats('character', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.topShips).toEqual([{ shipTypeId: 11987, shipName: 'Guardian', kills: 21 }]);
    }
  });

  it('zkill empty payload becomes an explicit error, not fake stats', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const result = await fetchZkillStats('character', 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('empty');
  });

  it('mutamarket: price comes from the contract, unsold rows are dropped, cheapest first', async () => {
    // Shape cut from the live /api/modules/type/47820 payload (2026-07-27):
    // price lives in contract.price, attributes are FLAT rows.
    fetchMock.mockResolvedValue(jsonResponse({
      data: [
        {
          id: 1054986512847,
          type: { id: 47820, name: 'Large Abyssal Armor Plates' },
          contract: { price: 250_000_000, type: 'item_exchange' },
          estimated_value: 180_000_000,
          mutated_attributes: [
            { id: 796, name: 'armorHP', display_name: 'Armor Hitpoints', value: 6000, base_value: 5250 },
          ],
        },
        {
          id: 2,
          type: { id: 47820, name: 'Large Abyssal Armor Plates' },
          contract: null, // not for sale — must be dropped
          mutated_attributes: [],
        },
        {
          id: 3,
          type: { id: 47820, name: 'Large Abyssal Armor Plates' },
          contract: { price: 100_000_000, type: 'auction' },
          mutated_attributes: [],
        },
      ],
    }));
    const result = await fetchAbyssalListings(47820);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].price).toBe(100_000_000); // cheapest first
      expect(result.data[1]).toMatchObject({
        itemId: 1054986512847,
        price: 250_000_000,
        contractType: 'item_exchange',
        estimatedValue: 180_000_000,
        attributes: [{ name: 'Armor Hitpoints', value: 6000, baseValue: 5250 }],
      });
    }
  });

  it('an upstream 500 degrades to ok:false and is negative-cached', async () => {
    fetchMock.mockResolvedValue(new Response('oops', { status: 500 }));
    const first = await fetchIndustryCost({ productId: 34, runs: 1 });
    const second = await fetchIndustryCost({ productId: 34, runs: 1 });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // The dead upstream is not re-probed with the full retry budget per call.
    expect(fetchMock).toHaveBeenCalledTimes(config.community.retryMaxAttempts);
  });

  it('caps oversized responses instead of buffering them', async () => {
    const huge = '{"data": "' + 'x'.repeat(3 * 1024 * 1024) + '"}';
    fetchMock.mockResolvedValue(new Response(huge, { status: 200 }));
    const result = await fetchIndustryCost({ productId: 35, runs: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/size cap|too large/);
  });
});

describe('tool declarations and policy', () => {
  it('declares all four community tools with strict schemas', () => {
    expect(COMMUNITY_TOOLS.map((tool) => tool.name)).toEqual([
      'industry_cost', 'appraise_items', 'pilot_intel', 'abyssal_market',
    ]);
    for (const tool of COMMUNITY_TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(isCommunityToolName('industry_cost')).toBe(true);
    expect(isCommunityToolName('sde_sql')).toBe(false);
  });

  it('community tools are read-policy tools: admitted and budgeted like every other read', async () => {
    for (const tool of COMMUNITY_TOOLS) {
      expect(await getToolPolicy(tool.name)).toBe('read');
    }
  });
});

