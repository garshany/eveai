import type { Db } from '../db/sqlite.js';

/**
 * Read-only query layer over the local market snapshot (market_orders, filled
 * by the snapshot loader) joined with SDE reference tables for names. Nothing
 * here writes to the database; the web market routes call these functions and
 * serialize the rows as-is.
 *
 * Player structures have no station_id (the loader can only resolve NPC
 * stations from sde_stations), so location_name is NULL for them and the
 * client renders "player structure".
 */

export type MarketTypeSearchRow = {
  type_id: number;
  name: string;
  group_id: number | null;
  market_group_id: number | null;
};

export type MarketTypeOverview = {
  type_id: number;
  type_name: string | null;
  group_id: number | null;
  group_name: string | null;
  market_group_id: number | null;
  region_id: number;
  best_sell: number | null;
  best_buy: number | null;
  sell_volume: number;
  buy_volume: number;
  sell_orders: number;
  buy_orders: number;
  spread_abs: number | null;
  spread_pct: number | null;
};

export type MarketOrderSide = 'sell' | 'buy';

export type MarketTypeOrdersParams = {
  typeId: number;
  regionId: number;
  side: MarketOrderSide;
  limit: number;
  offset: number;
};

export type MarketOrderRow = {
  order_id: number;
  type_id: number;
  region_id: number;
  is_buy_order: boolean;
  price: number;
  volume_remain: number;
  volume_total: number;
  min_volume: number;
  duration: number;
  range: string;
  issued: string;
  system_id: number;
  system_name: string | null;
  station_id: number | null;
  location_id: number;
  location_name: string | null;
};

export type MarketRegionComparisonRow = {
  region_id: number;
  region_name: string | null;
  min_sell: number | null;
  max_buy: number | null;
  sell_volume: number;
  buy_volume: number;
  sell_orders: number;
  buy_orders: number;
};

export type MarketGroupTreeRow = {
  market_group_id: number;
  name: string;
  parent_group_id: number | null;
  has_children: boolean;
};

export type MarketGroupTypeRow = {
  type_id: number;
  name: string;
  group_id: number | null;
  market_group_id: number | null;
};

const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Search-as-you-type over tradeable SDE types (published and attached to a
 * market group). Exact matches rank first, then prefix matches, then plain
 * substring matches; ties break by shorter name so the canonical item beats
 * its variants. Case-insensitive via the sde_types NOCASE index collation.
 */
export function searchMarketTypes(db: Db, q: string, limit = DEFAULT_SEARCH_LIMIT): MarketTypeSearchRow[] {
  const needle = q.trim();
  if (needle.length === 0 || limit <= 0) return [];
  const escaped = escapeLike(needle);
  return db.prepare(`
    SELECT type_id, name, group_id,
      json_extract(data_json, '$.marketGroupID') AS market_group_id
    FROM sde_types
    WHERE json_extract(data_json, '$.published') = 1
      AND json_extract(data_json, '$.marketGroupID') IS NOT NULL
      AND name LIKE '%' || ? || '%' COLLATE NOCASE ESCAPE '\\'
    ORDER BY
      CASE
        WHEN name = ? COLLATE NOCASE THEN 0
        WHEN name LIKE ? || '%' COLLATE NOCASE ESCAPE '\\' THEN 1
        ELSE 2
      END,
      LENGTH(name),
      name COLLATE NOCASE
    LIMIT ?
  `).all(escaped, needle, escaped, limit) as MarketTypeSearchRow[];
}

/**
 * Aggregate quote for one type in one region: best sell/buy, remaining
 * volumes, order counts and the absolute/relative spread (relative to the
 * best sell, as in the in-game market window). Returns null when the type is
 * not in the local SDE at all; an existing type with an empty book returns
 * null prices and zero counts.
 */
export function getTypeOverview(db: Db, typeId: number, regionId: number): MarketTypeOverview | null {
  const typeRow = db.prepare(`
    SELECT t.type_id AS type_id, t.name AS type_name, t.group_id AS group_id,
      g.name AS group_name,
      json_extract(t.data_json, '$.marketGroupID') AS market_group_id
    FROM sde_types t
    LEFT JOIN sde_groups g ON g.group_id = t.group_id
    WHERE t.type_id = ?
  `).get(typeId) as {
    type_id: number;
    type_name: string;
    group_id: number | null;
    group_name: string | null;
    market_group_id: number | null;
  } | undefined;
  if (!typeRow) return null;

  const book = db.prepare(`
    SELECT
      MIN(CASE WHEN is_buy_order = 0 THEN price END) AS best_sell,
      MAX(CASE WHEN is_buy_order = 1 THEN price END) AS best_buy,
      COALESCE(SUM(CASE WHEN is_buy_order = 0 THEN volume_remain ELSE 0 END), 0) AS sell_volume,
      COALESCE(SUM(CASE WHEN is_buy_order = 1 THEN volume_remain ELSE 0 END), 0) AS buy_volume,
      COALESCE(SUM(CASE WHEN is_buy_order = 0 THEN 1 ELSE 0 END), 0) AS sell_orders,
      COALESCE(SUM(CASE WHEN is_buy_order = 1 THEN 1 ELSE 0 END), 0) AS buy_orders
    FROM market_orders
    WHERE type_id = ? AND region_id = ?
  `).get(typeId, regionId) as {
    best_sell: number | null;
    best_buy: number | null;
    sell_volume: number;
    buy_volume: number;
    sell_orders: number;
    buy_orders: number;
  };

  const spreadAbs = book.best_sell !== null && book.best_buy !== null
    ? book.best_sell - book.best_buy
    : null;
  const spreadPct = spreadAbs !== null && book.best_sell !== null && book.best_sell > 0
    ? (spreadAbs / book.best_sell) * 100
    : null;

  return {
    type_id: typeRow.type_id,
    type_name: typeRow.type_name,
    group_id: typeRow.group_id,
    group_name: typeRow.group_name,
    market_group_id: typeRow.market_group_id,
    region_id: regionId,
    best_sell: book.best_sell,
    best_buy: book.best_buy,
    sell_volume: book.sell_volume,
    buy_volume: book.buy_volume,
    sell_orders: book.sell_orders,
    buy_orders: book.buy_orders,
    spread_abs: spreadAbs,
    spread_pct: spreadPct,
  };
}

/**
 * One side of the order book, cheapest sell first / highest buy first.
 * Station and system names come from the SDE; orders anchored in player
 * structures have station_id NULL and therefore location_name NULL.
 */
export function getTypeOrders(db: Db, params: MarketTypeOrdersParams): MarketOrderRow[] {
  const { typeId, regionId, side, limit, offset } = params;
  const isBuy = side === 'buy';
  const rows = db.prepare(`
    SELECT
      o.order_id AS order_id,
      o.type_id AS type_id,
      o.region_id AS region_id,
      o.is_buy_order AS is_buy_order,
      o.price AS price,
      o.volume_remain AS volume_remain,
      o.volume_total AS volume_total,
      o.min_volume AS min_volume,
      o.duration AS duration,
      o.range AS range,
      o.issued AS issued,
      o.system_id AS system_id,
      sys.name AS system_name,
      o.station_id AS station_id,
      o.location_id AS location_id,
      st.name AS location_name
    FROM market_orders o
    LEFT JOIN sde_stations st ON st.station_id = o.station_id
    LEFT JOIN sde_systems sys ON sys.system_id = o.system_id
    WHERE o.type_id = ? AND o.region_id = ? AND o.is_buy_order = ?
    ORDER BY o.price ${isBuy ? 'DESC' : 'ASC'}, o.order_id ASC
    LIMIT ? OFFSET ?
  `).all(typeId, regionId, isBuy ? 1 : 0, limit, offset) as Array<Omit<MarketOrderRow, 'is_buy_order'> & { is_buy_order: number }>;
  return rows.map((row) => ({ ...row, is_buy_order: row.is_buy_order === 1 }));
}

/**
 * Per-region quote comparison for one type across every region present in the
 * local snapshot. Regions offering the item for sale sort first by cheapest
 * sell; buy-only regions trail, ordered by their best buy.
 */
export function getRegionalComparison(db: Db, typeId: number): MarketRegionComparisonRow[] {
  return db.prepare(`
    SELECT
      o.region_id AS region_id,
      r.name AS region_name,
      MIN(CASE WHEN o.is_buy_order = 0 THEN o.price END) AS min_sell,
      MAX(CASE WHEN o.is_buy_order = 1 THEN o.price END) AS max_buy,
      COALESCE(SUM(CASE WHEN o.is_buy_order = 0 THEN o.volume_remain ELSE 0 END), 0) AS sell_volume,
      COALESCE(SUM(CASE WHEN o.is_buy_order = 1 THEN o.volume_remain ELSE 0 END), 0) AS buy_volume,
      COALESCE(SUM(CASE WHEN o.is_buy_order = 0 THEN 1 ELSE 0 END), 0) AS sell_orders,
      COALESCE(SUM(CASE WHEN o.is_buy_order = 1 THEN 1 ELSE 0 END), 0) AS buy_orders
    FROM market_orders o
    LEFT JOIN sde_regions r ON r.region_id = o.region_id
    WHERE o.type_id = ?
    GROUP BY o.region_id
    ORDER BY min_sell IS NULL, min_sell ASC, max_buy DESC
  `).all(typeId) as MarketRegionComparisonRow[];
}

/**
 * One level of the market group tree. Pass null for the root level; the
 * has_children flag lets the client render expand arrows without an extra
 * round trip per node.
 */
export function getMarketGroupTree(db: Db, parentGroupId: number | null): MarketGroupTreeRow[] {
  const rows = parentGroupId === null
    ? db.prepare(`
        SELECT
          g.market_group_id AS market_group_id,
          g.name AS name,
          g.parent_group_id AS parent_group_id,
          EXISTS(
            SELECT 1 FROM sde_market_groups c WHERE c.parent_group_id = g.market_group_id
          ) AS has_children
        FROM sde_market_groups g
        WHERE g.parent_group_id IS NULL
        ORDER BY g.name COLLATE NOCASE
      `).all() as Array<Omit<MarketGroupTreeRow, 'has_children'> & { has_children: number }>
    : db.prepare(`
        SELECT
          g.market_group_id AS market_group_id,
          g.name AS name,
          g.parent_group_id AS parent_group_id,
          EXISTS(
            SELECT 1 FROM sde_market_groups c WHERE c.parent_group_id = g.market_group_id
          ) AS has_children
        FROM sde_market_groups g
        WHERE g.parent_group_id = ?
        ORDER BY g.name COLLATE NOCASE
      `).all(parentGroupId) as Array<Omit<MarketGroupTreeRow, 'has_children'> & { has_children: number }>;
  return rows.map((row) => ({ ...row, has_children: row.has_children === 1 }));
}

/** Published tradeable types of one market group, alphabetical. */
export function getMarketGroupTypes(db: Db, groupId: number, limit: number): MarketGroupTypeRow[] {
  if (limit <= 0) return [];
  return db.prepare(`
    SELECT type_id, name, group_id,
      json_extract(data_json, '$.marketGroupID') AS market_group_id
    FROM sde_types
    WHERE json_extract(data_json, '$.marketGroupID') = ?
      AND json_extract(data_json, '$.published') = 1
    ORDER BY name COLLATE NOCASE
    LIMIT ?
  `).all(groupId, limit) as MarketGroupTypeRow[];
}

/** Escape user input for a LIKE pattern with ESCAPE '\'. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
