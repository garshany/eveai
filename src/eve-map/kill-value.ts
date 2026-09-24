/**
 * Local ISK estimate for a killmail that arrives without a value.
 *
 * The global feed carries ESI-shaped killmails, and ESI killmails have no
 * value — so without this every live kill indexed at 0 ISK: `value_spike`
 * could never fire and the map's "ISK destroyed" read zero. The estimate is
 * the cheapest sell price of the hull and of every item (dropped + destroyed)
 * in the operator's home market region, from the local market snapshot. It is
 * an estimate and never overrides a value the source did provide.
 *
 * One indexed lookup per distinct type (idx_market_orders_type_region), with a
 * short in-memory cache: the feed repeats the same hulls and modules all day.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import type { NormalizedKillmail } from '../eve-kill/types.js';

const PRICE_TTL_MS = 10 * 60_000;
const MAX_CACHED_TYPES = 20_000;
const MAX_ITEMS_PRICED = 200;

const priceCache = new Map<number, { price: number | null; atMs: number }>();

function cheapestSell(db: Db, typeId: number, now: number): number | null {
  const cached = priceCache.get(typeId);
  if (cached && now - cached.atMs < PRICE_TTL_MS) return cached.price;
  let price: number | null = null;
  try {
    const row = db.prepare(`
      SELECT MIN(price) AS price FROM market_orders
      WHERE type_id = ? AND region_id = ? AND is_buy_order = 0
    `).get(typeId, config.market.defaultRegionId) as { price: number | null } | undefined;
    price = typeof row?.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : null;
  } catch {
    // No market snapshot table yet (fresh install): no estimate, not an error.
    price = null;
  }
  if (priceCache.size >= MAX_CACHED_TYPES) priceCache.clear();
  priceCache.set(typeId, { price, atMs: now });
  return price;
}

/** Hull + items at local cheapest-sell prices; null when nothing could be priced. */
export function estimateKillValue(db: Db, killmail: NormalizedKillmail, now = Date.now()): number | null {
  let total = 0;
  let priced = false;
  const hull = killmail.victim.shipTypeId;
  if (typeof hull === 'number' && hull > 0) {
    const price = cheapestSell(db, hull, now);
    if (price !== null) {
      total += price;
      priced = true;
    }
  }
  for (const item of killmail.items.slice(0, MAX_ITEMS_PRICED)) {
    const quantity = (item.quantityDropped ?? 0) + (item.quantityDestroyed ?? 0);
    if (!(quantity > 0) || !(item.typeId > 0)) continue;
    const price = cheapestSell(db, item.typeId, now);
    if (price === null) continue;
    total += price * quantity;
    priced = true;
  }
  return priced ? Math.round(total) : null;
}

export function resetKillValueCacheForTests(): void {
  priceCache.clear();
}
