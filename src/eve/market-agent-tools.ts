/**
 * Local market tools for the chat agent, answered from the local SDE and the
 * whole-New-Eden market snapshot (market_orders) with zero ESI calls:
 *
 * - resolve_items: item names (English or Russian, pilot slang, typos) to
 *   tradeable type_ids, so a price question no longer costs a hand-written
 *   sde_sql round trip that only knows exact English names;
 * - hub_prices: best sell/buy AT the trade-hub station (Jita 4-4, Amarr VIII,
 *   ...), not the region-wide extreme that mixes in every structure and
 *   low-sec station of the region, plus the cost of filling N units.
 */

import type { Db } from '../db/sqlite.js';
import type { NativeFunctionTool } from '../agent/native-responses.js';

export const RESOLVE_ITEMS_TOOL_NAME = 'resolve_items';
export const HUB_PRICES_TOOL_NAME = 'hub_prices';

export const RESOLVE_ITEMS_TOOL: NativeFunctionTool = {
  type: 'function',
  name: RESOLVE_ITEMS_TOOL_NAME,
  description: 'Resolve item names to tradeable type_ids from the local SDE. Understands English and Russian names, common pilot slang ("плекс", "трит", "инжектор") and small typos. Use it before any price tool instead of writing sde_sql for names. Returns up to `limit` ranked matches per name with how each matched.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: { type: 'string' },
        description: 'Item names as the pilot wrote them, 1-30.',
      },
      limit: { type: ['integer', 'null'], minimum: 1, maximum: 5, description: 'Matches per name, default 3.' },
    },
    required: ['names', 'limit'],
    additionalProperties: false,
  },
};

export const HUB_PRICES_TOOL: NativeFunctionTool = {
  type: 'function',
  name: HUB_PRICES_TOOL_NAME,
  description: 'Prices AT the main trade-hub stations (jita = Jita IV-4 CNAP, amarr = Amarr VIII, dodixie, rens, hek) from the local market snapshot, no ESI calls: best sell / best buy at the station, volumes, spread, and — when quantity is given — the average price to buy or sell that many units against the order book and whether the book can fill it. Use for "сколько стоит X в Жите/Амарре", hub comparisons and multibuy costs. Region-wide prices (batch_market_prices) include every station and structure of the region; this does not.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      type_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: { type: 'integer', minimum: 1 },
        description: 'Unique type_ids (resolve names with resolve_items).',
      },
      hubs: {
        type: ['array', 'null'],
        items: { type: 'string', enum: ['jita', 'amarr', 'dodixie', 'rens', 'hek'] },
        description: 'Hubs to price at. Null = all five.',
      },
      quantity: { type: ['integer', 'null'], minimum: 1, description: 'Units to buy/sell for the order-book fill estimate. Null = best prices only.' },
    },
    required: ['type_ids', 'hubs', 'quantity'],
    additionalProperties: false,
  },
};

export const MARKET_AGENT_TOOLS: NativeFunctionTool[] = [RESOLVE_ITEMS_TOOL, HUB_PRICES_TOOL];

export function isMarketAgentToolName(name: string): boolean {
  return name === RESOLVE_ITEMS_TOOL_NAME || name === HUB_PRICES_TOOL_NAME;
}

// ---------------------------------------------------------------------------
// resolve_items
// ---------------------------------------------------------------------------

/** Pilot slang → canonical English type name. Keys are normalized. */
const ITEM_ALIASES: Readonly<Record<string, string>> = {
  'плекс': 'PLEX',
  'плекса': 'PLEX',
  'трит': 'Tritanium',
  'тритан': 'Tritanium',
  'тританиум': 'Tritanium',
  'пиер': 'Pyerite',
  'пирит': 'Pyerite',
  'мех': 'Mexallon',
  'мекс': 'Mexallon',
  'мексалон': 'Mexallon',
  'изо': 'Isogen',
  'изоген': 'Isogen',
  'нокс': 'Nocxium',
  'ноксиум': 'Nocxium',
  'зайд': 'Zydrine',
  'зидрин': 'Zydrine',
  'мега': 'Megacyte',
  'мегасайт': 'Megacyte',
  'морф': 'Morphite',
  'морфит': 'Morphite',
  'инжектор': 'Large Skill Injector',
  'инжа': 'Large Skill Injector',
  'большой инжектор': 'Large Skill Injector',
  'малый инжектор': 'Small Skill Injector',
  'экстрактор': 'Skill Extractor',
  'экстрактор навыков': 'Skill Extractor',
  'нанит': 'Nanite Repair Paste',
  'наниты': 'Nanite Repair Paste',
  'пасту': 'Nanite Repair Paste',
  'стронций': 'Strontium Clathrates',
  'озон': 'Liquid Ozone',
  'ctrl': 'Capital Tractor Unit',
};

export type ItemMatch = {
  type_id: number;
  name_en: string;
  name_ru: string | null;
  match: 'exact' | 'alias' | 'prefix' | 'substring' | 'fuzzy';
  score: number;
};

type CatalogEntry = {
  typeId: number;
  nameEn: string;
  nameRu: string | null;
  normEn: string;
  normRu: string | null;
  gramsEn: Set<string>;
  gramsRu: Set<string> | null;
};

let catalogCache: { key: string; entries: CatalogEntry[] } | null = null;

export function normalizeItemName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let index = 0; index < padded.length - 2; index += 1) grams.add(padded.slice(index, index + 3));
  return grams;
}

function similarity(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared || 1);
}

/**
 * Tradeable types (published, on the market tree) with both names, loaded once
 * per SDE build — the one JSON pass over sde_types is paid on first use, not
 * on every question.
 */
function loadCatalog(db: Db): CatalogEntry[] {
  const meta = db.prepare('SELECT build_number FROM sde_meta ORDER BY loaded_at DESC LIMIT 1').get() as
    { build_number: string } | undefined;
  const count = db.prepare('SELECT COUNT(*) AS n FROM sde_types WHERE published = 1 AND market_group_id IS NOT NULL')
    .get() as { n: number };
  const key = `${meta?.build_number ?? 'none'}:${count.n}`;
  if (catalogCache?.key === key) return catalogCache.entries;
  const rows = db.prepare(`
    SELECT type_id, name, json_extract(data_json, '$.name.ru') AS name_ru
    FROM sde_types
    WHERE published = 1 AND market_group_id IS NOT NULL
  `).all() as Array<{ type_id: number; name: string; name_ru: unknown }>;
  const entries = rows.map((row) => {
    const nameRu = typeof row.name_ru === 'string' && row.name_ru.trim() ? row.name_ru : null;
    const normEn = normalizeItemName(row.name);
    const normRu = nameRu ? normalizeItemName(nameRu) : null;
    return {
      typeId: row.type_id, nameEn: row.name, nameRu, normEn, normRu,
      gramsEn: trigrams(normEn), gramsRu: normRu ? trigrams(normRu) : null,
    };
  });
  catalogCache = { key, entries };
  return entries;
}

export function resetMarketAgentToolCacheForTests(): void {
  catalogCache = null;
}

const FUZZY_MIN_SIMILARITY = 0.3;

export function resolveItems(db: Db, names: string[], limit = 3): Array<{ query: string; matches: ItemMatch[] }> {
  const catalog = loadCatalog(db);
  const byEn = new Map(catalog.map((entry) => [entry.normEn, entry]));
  return names.map((query) => {
    const needle = normalizeItemName(query);
    if (!needle) return { query, matches: [] };
    const toMatch = (entry: CatalogEntry, match: ItemMatch['match'], score: number): ItemMatch => ({
      type_id: entry.typeId, name_en: entry.nameEn, name_ru: entry.nameRu, match, score: Math.round(score * 100) / 100,
    });

    const alias = ITEM_ALIASES[needle];
    const aliasEntry = alias ? byEn.get(normalizeItemName(alias)) : undefined;
    if (aliasEntry) return { query, matches: [toMatch(aliasEntry, 'alias', 1)] };

    const exact = catalog.filter((entry) => entry.normEn === needle || entry.normRu === needle);
    if (exact.length > 0) return { query, matches: exact.slice(0, limit).map((entry) => toMatch(entry, 'exact', 1)) };

    // Prefix, then substring, on either name; shorter names first so the
    // canonical item beats its variants ("Tritanium" before "Compressed ...").
    const ranked: ItemMatch[] = [];
    const seen = new Set<number>();
    const push = (entries: CatalogEntry[], match: ItemMatch['match'], score: number) => {
      for (const entry of entries.sort((left, right) => left.nameEn.length - right.nameEn.length)) {
        if (ranked.length >= limit) return;
        if (seen.has(entry.typeId)) continue;
        seen.add(entry.typeId);
        ranked.push(toMatch(entry, match, score));
      }
    };
    push(catalog.filter((entry) => entry.normEn.startsWith(needle) || entry.normRu?.startsWith(needle)), 'prefix', 0.9);
    if (ranked.length < limit && needle.length >= 3) {
      push(catalog.filter((entry) => entry.normEn.includes(needle) || entry.normRu?.includes(needle)), 'substring', 0.8);
    }
    if (ranked.length > 0) return { query, matches: ranked };

    // Typos: trigram similarity over both names.
    const grams = trigrams(needle);
    const fuzzy = catalog
      .map((entry) => ({
        entry,
        score: Math.max(similarity(grams, entry.gramsEn), entry.gramsRu ? similarity(grams, entry.gramsRu) : 0),
      }))
      .filter((candidate) => candidate.score >= FUZZY_MIN_SIMILARITY)
      .sort((left, right) => right.score - left.score || left.entry.nameEn.length - right.entry.nameEn.length)
      .slice(0, limit)
      .map((candidate) => toMatch(candidate.entry, 'fuzzy', candidate.score));
    return { query, matches: fuzzy };
  });
}

// ---------------------------------------------------------------------------
// hub_prices
// ---------------------------------------------------------------------------

export type HubId = 'jita' | 'amarr' | 'dodixie' | 'rens' | 'hek';

export const TRADE_HUBS: Readonly<Record<HubId, { stationId: number; regionId: number; label: string }>> = {
  jita: { stationId: 60003760, regionId: 10000002, label: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
  amarr: { stationId: 60008494, regionId: 10000043, label: 'Amarr VIII (Oris) - Emperor Family Academy' },
  dodixie: { stationId: 60011866, regionId: 10000032, label: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant' },
  rens: { stationId: 60004588, regionId: 10000030, label: 'Rens VI - Moon 8 - Brutor Tribe Treasury' },
  hek: { stationId: 60005686, regionId: 10000042, label: 'Hek VIII - Moon 12 - Boundless Creation Factory' },
};

type Fill = { average_price: number | null; filled: number; fillable: boolean; total_isk: number | null };

type HubQuote = {
  hub: HubId;
  station_id: number;
  sell: { best: number | null; volume: number; orders: number };
  buy: { best: number | null; volume: number; orders: number };
  spread_percent: number | null;
  buy_fill?: Fill;
  sell_fill?: Fill;
};

function fill(orders: Array<{ price: number; volume_remain: number }>, quantity: number): Fill {
  let remaining = quantity;
  let isk = 0;
  for (const order of orders) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, order.volume_remain);
    isk += take * order.price;
    remaining -= take;
  }
  const filled = quantity - remaining;
  return {
    average_price: filled > 0 ? Math.round((isk / filled) * 100) / 100 : null,
    filled,
    fillable: remaining <= 0,
    total_isk: filled > 0 ? Math.round(isk * 100) / 100 : null,
  };
}

export function hubPrices(
  db: Db,
  typeIds: number[],
  hubs: HubId[] | null,
  quantity: number | null,
): { items: Array<{ type_id: number; name: string | null; hubs: HubQuote[] }> } {
  const selected = (hubs && hubs.length > 0 ? [...new Set(hubs)] : (Object.keys(TRADE_HUBS) as HubId[]));
  const sellStmt = db.prepare(`
    SELECT price, volume_remain FROM market_orders
    WHERE type_id = ? AND region_id = ? AND is_buy_order = 0 AND location_id = ?
    ORDER BY price ASC
  `);
  const buyStmt = db.prepare(`
    SELECT price, volume_remain FROM market_orders
    WHERE type_id = ? AND region_id = ? AND is_buy_order = 1 AND location_id = ?
    ORDER BY price DESC
  `);
  const nameStmt = db.prepare('SELECT name FROM sde_types WHERE type_id = ?');
  const items = [...new Set(typeIds)].map((typeId) => {
    const name = (nameStmt.get(typeId) as { name: string } | undefined)?.name ?? null;
    const quotes = selected.map((hub): HubQuote => {
      const { stationId, regionId } = TRADE_HUBS[hub];
      const sells = sellStmt.all(typeId, regionId, stationId) as Array<{ price: number; volume_remain: number }>;
      const buys = buyStmt.all(typeId, regionId, stationId) as Array<{ price: number; volume_remain: number }>;
      const bestSell = sells[0]?.price ?? null;
      const bestBuy = buys[0]?.price ?? null;
      const quote: HubQuote = {
        hub,
        station_id: stationId,
        sell: { best: bestSell, volume: sells.reduce((sum, order) => sum + order.volume_remain, 0), orders: sells.length },
        buy: { best: bestBuy, volume: buys.reduce((sum, order) => sum + order.volume_remain, 0), orders: buys.length },
        spread_percent: bestSell !== null && bestBuy !== null && bestSell > 0
          ? Math.round(((bestSell - bestBuy) / bestSell) * 10_000) / 100
          : null,
      };
      if (quantity !== null) {
        quote.buy_fill = fill(sells, quantity);
        quote.sell_fill = fill(buys, quantity);
      }
      return quote;
    });
    return { type_id: typeId, name, hubs: quotes };
  });
  return { items };
}
