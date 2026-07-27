import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation, type EsiCallResult, type EsiExecutionGuard } from './esi-client.js';

const MARKET_WIDE_SUMMARY_TOOL_NAME = 'market_wide_summary';
const MAX_ORDER_ROWS_PER_REGION = 100_000;
const MAX_LISTED_COVERAGE_ENTRIES = 10;
const PLAYER_STRUCTURE_ID_THRESHOLD = 1_000_000_000_000;

export const MARKET_WIDE_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: MARKET_WIDE_SUMMARY_TOOL_NAME,
  description:
    'Answer "whole market" questions for ONE item type across all of New Eden. Sweeps every '
    + 'k-space trade region\'s live ESI order book server-side (bounded concurrency, TTL-cached) '
    + 'and returns: the cheapest sell order and highest buy order with exact region/system/station, '
    + 'total order counts and volumes, a per-region breakdown sorted by price, the ESI global '
    + 'average/adjusted price reference, and an explicit coverage report (regions queried, failed, '
    + 'skipped). Use for "весь рынок", "whole market", "где дешевле всего", "сколько всего продают" '
    + 'questions. For a point comparison of a few named regions use batch_market_prices instead. '
    + 'Resolve type_id via sde_sql first.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      type_id: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: 'Resolved item type_id (via sde_sql).',
      },
    },
    required: ['type_id'],
    additionalProperties: false,
  },
};

export function isMarketWideSummaryTool(name: string): boolean {
  return name === MARKET_WIDE_SUMMARY_TOOL_NAME;
}

/**
 * Wrapper applied around every individual ESI leaf call. In production the
 * executor passes its shared ESI-leaf admission controller (bounded global
 * concurrency); tests inject their own to observe the fan-out.
 */
export type MarketWideLeafRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const directLeafRunner: MarketWideLeafRunner = (operation) => operation();

export type TradeRegion = {
  region_id: number;
  name: string;
  stargates: number;
};

type RegionOrder = {
  order_id: number;
  location_id: number;
  system_id: number | null;
  price: number;
  volume_remain: number;
  is_buy_order: boolean;
};

type RegionFailure = {
  region: TradeRegion;
  status: number | null;
  error: string;
};

type Failure = {
  ok: false;
  source: 'CCP ESI';
  authoritative: true;
  error: string;
  status: number | null;
  blocked: boolean;
};

function failure(error: string, status: number | null = null): Failure {
  return {
    ok: false,
    source: 'CCP ESI',
    authoritative: true,
    error,
    status,
    blocked: false,
  };
}

export async function executeMarketWideSummary(
  db: Db,
  rawArgs: Record<string, unknown>,
  guard: EsiExecutionGuard = {},
  runLeaf: MarketWideLeafRunner = directLeafRunner,
): Promise<Record<string, unknown>> {
  if (Object.keys(rawArgs).some((key) => key !== 'type_id')) {
    return failure('Invalid market_wide_summary arguments: only type_id is accepted.');
  }
  const typeId = rawArgs.type_id;
  if (typeof typeId !== 'number' || !Number.isSafeInteger(typeId) || typeId <= 0) {
    return failure('Invalid market_wide_summary arguments: type_id must be a positive safe integer.');
  }

  // Ordered by size so a truncated sweep keeps the biggest markets.
  const tradeRegions = loadTradeRegions(db);
  if (tradeRegions.length === 0) {
    return failure('Local SDE has no stargate geography; cannot determine k-space trade regions.');
  }

  const selected = tradeRegions.slice(0, config.esi.marketWideMaxRegions);
  const skipped = tradeRegions.slice(config.esi.marketWideMaxRegions);

  // One cheap global reference call first, in parallel with the regional sweep.
  // It is ETag/TTL-cached, so repeat questions about any type reuse it.
  const globalPromise = runLeaf(() => callEsiOperation<unknown>(db, 'get_markets_prices', {}, null, guard));

  const regionGuard: EsiExecutionGuard = { ...guard, maxPages: config.esi.marketWideMaxPages };
  const settled = await mapPool(selected, config.esi.marketWideConcurrency, async (region) => {
    const result = await runLeaf(() => callEsiOperation<unknown>(
      db,
      'get_markets_region_id_orders',
      { region_id: region.region_id, order_type: 'all', type_id: typeId },
      null,
      regionGuard,
    ));
    if (!result.ok) {
      return { region, orders: null, error: { status: result.status, error: result.error } };
    }
    try {
      return { region, orders: parseOrders(result.data), error: null };
    } catch {
      return { region, orders: null, error: { status: result.status, error: 'invalid orders response' } };
    }
  });

  const globalResult = await globalPromise;
  const { reference: globalReference, error: globalReferenceError } = extractGlobalReference(globalResult, typeId);

  const regionSummaries: Array<Record<string, unknown>> = [];
  const failedRegions: RegionFailure[] = [];
  let totalSellOrders = 0;
  let totalBuyOrders = 0;
  let totalSellVolume = 0;
  let totalBuyVolume = 0;
  let bestSell: { price: number; region: TradeRegion; order: RegionOrder } | null = null;
  let bestBuy: { price: number; region: TradeRegion; order: RegionOrder } | null = null;

  for (const entry of settled) {
    if (entry.orders === null) {
      failedRegions.push({
        region: entry.region,
        status: entry.error?.status ?? null,
        error: entry.error?.error ?? 'unknown error',
      });
      continue;
    }
    const sell = entry.orders.filter((order) => !order.is_buy_order);
    const buy = entry.orders.filter((order) => order.is_buy_order);
    if (sell.length === 0 && buy.length === 0) continue;

    const minSell = sell.length > 0 ? Math.min(...sell.map((order) => order.price)) : null;
    const maxBuy = buy.length > 0 ? Math.max(...buy.map((order) => order.price)) : null;
    const sellVolume = sell.reduce((sum, order) => sum + order.volume_remain, 0);
    const buyVolume = buy.reduce((sum, order) => sum + order.volume_remain, 0);
    totalSellOrders += sell.length;
    totalBuyOrders += buy.length;
    totalSellVolume += sellVolume;
    totalBuyVolume += buyVolume;

    regionSummaries.push({
      region_id: entry.region.region_id,
      name: entry.region.name,
      sell_orders: sell.length,
      buy_orders: buy.length,
      sell_volume: sellVolume,
      buy_volume: buyVolume,
      min_sell: minSell,
      max_buy: maxBuy,
    });

    for (const order of sell) {
      if (bestSell === null || order.price < bestSell.price) {
        bestSell = { price: order.price, region: entry.region, order };
      }
    }
    for (const order of buy) {
      if (bestBuy === null || order.price > bestBuy.price) {
        bestBuy = { price: order.price, region: entry.region, order };
      }
    }
  }

  // Cheapest sell first; regions with only buy orders trail, best buy first.
  regionSummaries.sort((a, b) => {
    const aSell = a.min_sell as number | null;
    const bSell = b.min_sell as number | null;
    if (aSell !== null && bSell !== null && aSell !== bSell) return aSell - bSell;
    if (aSell !== null && bSell === null) return -1;
    if (aSell === null && bSell !== null) return 1;
    return ((b.max_buy as number | null) ?? 0) - ((a.max_buy as number | null) ?? 0);
  });

  const locationNames = lookupLocationNames(
    db,
    [bestSell, bestBuy]
      .filter((best): best is { price: number; region: TradeRegion; order: RegionOrder } => best !== null)
      .map((best) => best.order.location_id),
  );
  const systemNames = lookupSystemNames(
    db,
    [bestSell, bestBuy]
      .filter((best): best is { price: number; region: TradeRegion; order: RegionOrder } => best !== null)
      .flatMap((best) => (best.order.system_id !== null ? [best.order.system_id] : [])),
  );

  const typeName = lookupTypeName(db, typeId);
  const regionsFailed = failedRegions.length;
  const regionsSkipped = skipped.length;
  const complete = regionsFailed === 0 && regionsSkipped === 0;
  const hasOrders = totalSellOrders + totalBuyOrders > 0;

  return {
    ok: true,
    source: 'CCP ESI',
    authoritative: true,
    freshness: {
      retrieved_at: new Date().toISOString(),
      data_through: null,
      cache_max_age_seconds: null,
    },
    type_id: typeId,
    type_name: typeName,
    global_reference: globalReference,
    global_reference_error: globalReferenceError,
    totals: {
      sell_orders: totalSellOrders,
      buy_orders: totalBuyOrders,
      sell_volume: totalSellVolume,
      buy_volume: totalBuyVolume,
      regions_with_orders: regionSummaries.length,
    },
    best_sell: bestSell === null ? null : decorateBest(bestSell, locationNames, systemNames),
    best_buy: bestBuy === null ? null : decorateBest(bestBuy, locationNames, systemNames),
    regions: regionSummaries,
    market_note: hasOrders
      ? null
      : 'No live orders found in any successfully queried region. global_reference (when present) is the ESI universe-wide average, not a live quote.',
    coverage: {
      complete,
      trade_regions_total: tradeRegions.length,
      regions_queried: selected.length,
      regions_succeeded: selected.length - regionsFailed,
      regions_failed: regionsFailed,
      regions_skipped: regionsSkipped,
      regions_with_orders: regionSummaries.length,
      failed_regions: failedRegions.slice(0, MAX_LISTED_COVERAGE_ENTRIES).map((entry) => ({
        region_id: entry.region.region_id,
        name: entry.region.name,
        status: entry.status,
        error: entry.error,
      })),
      skipped_regions: skipped.slice(0, MAX_LISTED_COVERAGE_ENTRIES).map((region) => ({
        region_id: region.region_id,
        name: region.name,
      })),
      note: complete
        ? null
        : `PARTIAL COVERAGE: ${regionsFailed} region(s) failed (ESI error/timeout/validation), `
          + `${regionsSkipped} skipped by the ESI_MARKET_WIDE_MAX_REGIONS cap. `
          + 'The figures above cover only successfully queried regions and are a lower bound, '
          + 'not a full New Eden picture. State this explicitly in the answer.',
    },
  };
}

function decorateBest(
  best: { price: number; region: TradeRegion; order: RegionOrder },
  locationNames: Map<number, string>,
  systemNames: Map<number, string>,
): Record<string, unknown> {
  const stationName = locationNames.get(best.order.location_id) ?? null;
  return {
    price: roundIsk(best.price),
    volume_remain: best.order.volume_remain,
    region_id: best.region.region_id,
    region_name: best.region.name,
    system_id: best.order.system_id,
    system_name: best.order.system_id !== null ? systemNames.get(best.order.system_id) ?? null : null,
    station_id: best.order.location_id,
    station_name: stationName,
    location_kind: stationName !== null
      ? 'npc_station'
      : best.order.location_id >= PLAYER_STRUCTURE_ID_THRESHOLD
        ? 'player_structure'
        : 'unknown',
  };
}

/**
 * Any region containing at least one stargate is k-space (wormhole and abyssal
 * regions have none), and k-space regions expose a public regional order book
 * on ESI. Shared by market_wide_summary and the market snapshot sweep, which
 * walks every one of these regions.
 */
export function loadTradeRegions(db: Db): TradeRegion[] {
  return db.prepare(`
    SELECT r.region_id AS region_id, r.name AS name, COUNT(g.stargate_id) AS stargates
    FROM sde_regions r
    JOIN sde_constellations c ON c.region_id = r.region_id
    JOIN sde_systems s ON s.constellation_id = c.constellation_id
    JOIN sde_stargates g ON g.system_id = s.system_id
    GROUP BY r.region_id, r.name
    ORDER BY stargates DESC, r.region_id ASC
  `).all() as TradeRegion[];
}

function parseOrders(value: unknown): RegionOrder[] {
  if (!Array.isArray(value)) throw new Error('orders must be an array');
  if (value.length > MAX_ORDER_ROWS_PER_REGION) throw new Error('orders exceed row limit');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid order row');
    const record = entry as Record<string, unknown>;
    const orderId = safeInteger(record.order_id);
    const locationId = safeInteger(record.location_id);
    const price = finiteNumber(record.price);
    const volumeRemain = safeInteger(record.volume_remain);
    if (orderId === null || locationId === null || price === null || price < 0
      || volumeRemain === null || volumeRemain < 0) {
      throw new Error('invalid order row fields');
    }
    const systemId = record.system_id === null || record.system_id === undefined
      ? null
      : safeInteger(record.system_id);
    return {
      order_id: orderId,
      location_id: locationId,
      system_id: systemId,
      price,
      volume_remain: volumeRemain,
      is_buy_order: record.is_buy_order === true,
    };
  });
}

function extractGlobalReference(
  result: EsiCallResult<unknown>,
  typeId: number,
): { reference: Record<string, number> | null; error: string | null } {
  if (!result.ok) {
    return { reference: null, error: `get_markets_prices failed (status ${result.status}).` };
  }
  if (!Array.isArray(result.data)) {
    return { reference: null, error: 'get_markets_prices returned an invalid payload.' };
  }
  for (const row of result.data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record.type_id !== typeId) continue;
    const reference: Record<string, number> = {};
    if (typeof record.average_price === 'number' && Number.isFinite(record.average_price) && record.average_price > 0) {
      reference.average_price = roundIsk(record.average_price);
    }
    if (typeof record.adjusted_price === 'number' && Number.isFinite(record.adjusted_price) && record.adjusted_price > 0) {
      reference.adjusted_price = roundIsk(record.adjusted_price);
    }
    return { reference: Object.keys(reference).length > 0 ? reference : null, error: null };
  }
  return { reference: null, error: null };
}

/**
 * Bounded worker pool over a list: `concurrency` workers pull items in order
 * and results keep input positions. Shared by the market_wide_summary region
 * fan-out and the market snapshot loader's per-region page fan-out. Fail-fast:
 * the first rejection stops workers from pulling further items (in-flight ones
 * settle) and rejects the pool — walking on after a hard failure would just
 * burn the ESI error budget on pages whose region is already lost.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown = null;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index]);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

function lookupTypeName(db: Db, typeId: number): string | null {
  const row = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(typeId) as { name: string } | undefined;
  return row?.name ?? null;
}

function lookupLocationNames(db: Db, locationIds: number[]): Map<number, string> {
  const names = new Map<number, string>();
  const unique = [...new Set(locationIds)];
  if (unique.length === 0) return names;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT station_id, name FROM sde_stations WHERE station_id IN (${placeholders})`,
  ).all(...unique) as Array<{ station_id: number; name: string }>;
  for (const row of rows) names.set(row.station_id, row.name);
  // Player structures (>= 1e12) stay nameless: resolving them needs a private
  // ESI call per structure, which this public summary deliberately avoids.
  return names;
}

function lookupSystemNames(db: Db, systemIds: number[]): Map<number, string> {
  const names = new Map<number, string>();
  const unique = [...new Set(systemIds)];
  if (unique.length === 0) return names;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT system_id, name FROM sde_systems WHERE system_id IN (${placeholders})`,
  ).all(...unique) as Array<{ system_id: number; name: string }>;
  for (const row of rows) names.set(row.system_id, row.name);
  return names;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function roundIsk(value: number): number {
  return Math.round(value * 100) / 100;
}
