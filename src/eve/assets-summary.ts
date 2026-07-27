import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { UserContext } from '../auth/user-resolver.js';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation, type EsiExecutionGuard } from './esi-client.js';

const ASSETS_SUMMARY_TOOL_NAME = 'assets_summary';
const DEFAULT_TOP = 10;
const MAX_TOP = 20;
const TOP_LOCATIONS = 10;
const MAX_ASSET_ROWS = 200_000;
const SDE_IN_CHUNK = 500;

export const ASSETS_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: ASSETS_SUMMARY_TOOL_NAME,
  description:
    'Summarize the linked character\'s private ESI assets server-side: fetches ALL asset pages, '
    + 'aggregates stacks per item type, resolves names via the local SDE, values everything with '
    + 'ESI global market prices, and returns total value, the most valuable item types, and a '
    + 'per-location breakdown. Use for "what is my most expensive item", "what do I own", or '
    + '"where is my stuff" questions instead of raw get_characters_character_id_assets pages.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      top: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: MAX_TOP,
        description: `How many most valuable item types to list. Default ${DEFAULT_TOP}, max ${MAX_TOP}.`,
      },
    },
    required: ['top'],
    additionalProperties: false,
  },
};

export function isAssetsSummaryTool(name: string): boolean {
  return name === ASSETS_SUMMARY_TOOL_NAME;
}

type AssetRow = {
  type_id: number;
  location_id: number;
  quantity: number;
  is_singleton: boolean;
};

type GlobalPrice = {
  type_id: number;
  average_price?: number;
  adjusted_price?: number;
};

type PriceKind = 'average' | 'adjusted';

type Failure = {
  ok: false;
  source: 'CCP ESI (private)';
  authoritative: true;
  error: string;
  status: number | null;
  blocked: boolean;
};

function failure(error: string, status: number | null = null): Failure {
  return {
    ok: false,
    source: 'CCP ESI (private)',
    authoritative: true,
    error,
    status,
    blocked: false,
  };
}

export async function executeAssetsSummary(
  db: Db,
  rawArgs: Record<string, unknown>,
  ctx: UserContext,
  guard: EsiExecutionGuard = {},
): Promise<Record<string, unknown>> {
  const top = parseTop(rawArgs.top);
  if (top === null) {
    return failure(`Invalid assets_summary arguments: top must be null or an integer 1-${MAX_TOP}.`);
  }

  // Private assets routinely exceed the generic ESI_MAX_PAGES budget (1k rows
  // per page); this tool gets its own, larger budget so "all pages" is honest.
  const assetsGuard: EsiExecutionGuard = { ...guard, maxPages: config.esi.assetsMaxPages };
  const assetsResult = await callEsiOperation<unknown>(
    db,
    'get_characters_character_id_assets',
    {},
    ctx,
    assetsGuard,
  );
  if (!assetsResult.ok) {
    const isPageBudget = assetsResult.status === 422;
    return failure(
      isPageBudget
        ? `${assetsResult.error} Assets were NOT fully covered; raise ESI_ASSETS_MAX_PAGES to widen this tool's page budget.`
        : assetsResult.error,
      assetsResult.status,
    );
  }

  let rows: AssetRow[];
  try {
    rows = parseAssets(assetsResult.data);
  } catch {
    return failure('CCP ESI returned an invalid assets response.', assetsResult.status);
  }

  const pricesResult = await callEsiOperation<GlobalPrice[]>(
    db,
    'get_markets_prices',
    {},
    null,
    guard,
  );
  const prices = new Map<number, { unit: number; kind: PriceKind }>();
  if (pricesResult.ok && Array.isArray(pricesResult.data)) {
    for (const row of pricesResult.data) {
      if (!row || typeof row !== 'object') continue;
      const typeId = row.type_id;
      if (typeof typeId !== 'number' || !Number.isSafeInteger(typeId) || typeId <= 0) continue;
      if (typeof row.average_price === 'number' && row.average_price > 0) {
        prices.set(typeId, { unit: row.average_price, kind: 'average' });
      } else if (typeof row.adjusted_price === 'number' && row.adjusted_price > 0) {
        prices.set(typeId, { unit: row.adjusted_price, kind: 'adjusted' });
      }
    }
  }

  const byType = new Map<number, { quantity: number; stacks: number }>();
  const byLocation = new Map<number, { quantity: number; stacks: number; value: number }>();
  let unpricedQuantity = 0;

  for (const row of rows) {
    const typeAgg = byType.get(row.type_id) ?? { quantity: 0, stacks: 0 };
    typeAgg.quantity += row.quantity;
    typeAgg.stacks += 1;
    byType.set(row.type_id, typeAgg);

    const price = prices.get(row.type_id) ?? null;
    const locationAgg = byLocation.get(row.location_id) ?? { quantity: 0, stacks: 0, value: 0 };
    locationAgg.quantity += row.quantity;
    locationAgg.stacks += 1;
    if (price) {
      locationAgg.value += price.unit * row.quantity;
    } else {
      unpricedQuantity += row.quantity;
    }
    byLocation.set(row.location_id, locationAgg);
  }

  const typeNames = lookupTypeNames(db, [...byType.keys()]);
  const locationNames = lookupLocationNames(db, [...byLocation.keys()]);

  const items = [...byType.entries()].map(([typeId, agg]) => {
    const price = prices.get(typeId) ?? null;
    return {
      type_id: typeId,
      name: typeNames.get(typeId) ?? null,
      quantity: agg.quantity,
      stacks: agg.stacks,
      unit_price: price ? roundIsk(price.unit) : null,
      price_kind: price?.kind ?? null,
      total_value: price ? roundIsk(price.unit * agg.quantity) : null,
    };
  });

  const valuedItems = items
    .filter((item): item is typeof item & { total_value: number } => item.total_value !== null)
    .sort((a, b) => b.total_value - a.total_value);

  const totalValue = valuedItems.reduce((sum, item) => sum + item.total_value, 0);
  const averagePricedTypes = items.filter((item) => item.price_kind === 'average').length;
  const adjustedPricedTypes = items.filter((item) => item.price_kind === 'adjusted').length;

  const topLocations = [...byLocation.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, TOP_LOCATIONS)
    .map(([locationId, agg]) => ({
      location_id: locationId,
      name: locationNames.get(locationId) ?? null,
      quantity: agg.quantity,
      stacks: agg.stacks,
      total_value: roundIsk(agg.value),
    }));

  return {
    ok: true,
    source: 'CCP ESI (private)',
    authoritative: true,
    freshness: {
      retrieved_at: new Date().toISOString(),
      data_through: null,
      cache_max_age_seconds: null,
    },
    coverage: {
      complete: true,
      asset_rows: rows.length,
      page_budget: config.esi.assetsMaxPages,
    },
    totals: {
      distinct_types: items.length,
      total_quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
      valued_types: valuedItems.length,
      unvalued_types: items.length - valuedItems.length,
      unvalued_quantity: unpricedQuantity,
      total_value_isk: roundIsk(totalValue),
      average_priced_types: averagePricedTypes,
      adjusted_priced_types: adjustedPricedTypes,
    },
    price_note:
      'average = ESI global trade average; adjusted = CCP internal estimate used only when no market average exists. Items without either are excluded from values.',
    top_items: valuedItems.slice(0, top),
    top_locations: topLocations,
  };
}

function parseTop(value: unknown): number | null {
  if (value === null || value === undefined) return DEFAULT_TOP;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TOP) {
    return null;
  }
  return value;
}

function parseAssets(value: unknown): AssetRow[] {
  if (!Array.isArray(value)) throw new Error('assets must be an array');
  if (value.length > MAX_ASSET_ROWS) throw new Error('assets exceed row limit');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid asset row');
    const record = entry as Record<string, unknown>;
    const typeId = record.type_id;
    const locationId = record.location_id;
    const quantity = record.quantity;
    if (typeof typeId !== 'number' || !Number.isSafeInteger(typeId) || typeId <= 0) {
      throw new Error('invalid asset type_id');
    }
    if (typeof locationId !== 'number' || !Number.isSafeInteger(locationId)) {
      throw new Error('invalid asset location_id');
    }
    const safeQuantity = typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity > 0
      ? quantity
      : 1;
    return {
      type_id: typeId,
      location_id: locationId,
      quantity: safeQuantity,
      is_singleton: record.is_singleton === true,
    };
  });
}

function lookupTypeNames(db: Db, typeIds: number[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const chunk of chunks(typeIds, SDE_IN_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT type_id, name FROM sde_types WHERE type_id IN (${placeholders})`,
    ).all(...chunk) as Array<{ type_id: number; name: string }>;
    for (const row of rows) names.set(row.type_id, row.name);
  }
  return names;
}

function lookupLocationNames(db: Db, locationIds: number[]): Map<number, string> {
  const names = new Map<number, string>();
  const unresolved: number[] = [];
  for (const chunk of chunks(locationIds, SDE_IN_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const stations = db.prepare(
      `SELECT station_id, name FROM sde_stations WHERE station_id IN (${placeholders})`,
    ).all(...chunk) as Array<{ station_id: number; name: string }>;
    for (const row of stations) names.set(row.station_id, row.name);
    for (const id of chunk) {
      if (!names.has(id)) unresolved.push(id);
    }
  }
  // Assets floating in space are keyed by solar system, not station.
  for (const chunk of chunks(unresolved, SDE_IN_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const systems = db.prepare(
      `SELECT system_id, name FROM sde_systems WHERE system_id IN (${placeholders})`,
    ).all(...chunk) as Array<{ system_id: number; name: string }>;
    for (const row of systems) names.set(row.system_id, row.name);
  }
  // Player structures (>1e12) stay nameless: resolving them needs an extra
  // private ESI call per structure, which this summary deliberately avoids.
  return names;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function roundIsk(value: number): number {
  return Math.round(value * 100) / 100;
}
