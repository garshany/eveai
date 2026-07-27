import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { UserContext } from '../auth/user-resolver.js';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation, type EsiExecutionGuard } from './esi-client.js';

const ORDERS_SUMMARY_TOOL_NAME = 'character_orders_summary';
const DEFAULT_TOP = 10;
const MAX_TOP = 20;
const EXPIRING_SOON_HOURS = 48;
const MAX_ORDER_ROWS = 10_000;
const SDE_IN_CHUNK = 500;

export const CHARACTER_ORDERS_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: ORDERS_SUMMARY_TOOL_NAME,
  description:
    'Summarize the linked character\'s open private ESI market orders server-side: buy/sell counts, '
    + 'total sell value, total buy escrow, per-region split, soon-expiring orders, and the largest '
    + 'orders with SDE-resolved item names. Use for "what am I selling", "my orders", "how much is '
    + 'on the market" questions instead of raw get_characters_character_id_orders rows.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      top: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: MAX_TOP,
        description: `How many largest orders to list per side. Default ${DEFAULT_TOP}, max ${MAX_TOP}.`,
      },
    },
    required: ['top'],
    additionalProperties: false,
  },
};

export function isCharacterOrdersSummaryTool(name: string): boolean {
  return name === ORDERS_SUMMARY_TOOL_NAME;
}

type OrderRow = {
  order_id: number;
  type_id: number;
  region_id: number;
  location_id: number;
  price: number;
  volume_remain: number;
  is_buy_order: boolean;
  escrow: number | null;
  expires_at: string | null;
};

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

export async function executeCharacterOrdersSummary(
  db: Db,
  rawArgs: Record<string, unknown>,
  ctx: UserContext,
  guard: EsiExecutionGuard = {},
): Promise<Record<string, unknown>> {
  const top = parseTop(rawArgs.top);
  if (top === null) {
    return failure(`Invalid ${ORDERS_SUMMARY_TOOL_NAME} arguments: top must be null or an integer 1-${MAX_TOP}.`);
  }

  const result = await callEsiOperation<unknown>(
    db,
    'get_characters_character_id_orders',
    {},
    ctx,
    guard,
  );
  if (!result.ok) return failure(result.error, result.status);

  let orders: OrderRow[];
  try {
    orders = parseOrders(result.data);
  } catch {
    return failure('CCP ESI returned an invalid orders response.', result.status);
  }

  const typeNames = lookupTypeNames(db, [...new Set(orders.map((order) => order.type_id))]);
  const regionNames = lookupRegionNames(db, [...new Set(orders.map((order) => order.region_id))]);

  const nowMs = Date.now();
  const expiringThresholdMs = nowMs + EXPIRING_SOON_HOURS * 3_600_000;

  let sellValue = 0;
  let buyEscrow = 0;
  const byRegion = new Map<number, { orders: number; sell_value: number; escrow: number }>();
  const decorated = orders.map((order) => {
    const remainingValue = order.price * order.volume_remain;
    if (order.is_buy_order) {
      buyEscrow += order.escrow ?? remainingValue;
    } else {
      sellValue += remainingValue;
    }
    const regionAgg = byRegion.get(order.region_id) ?? { orders: 0, sell_value: 0, escrow: 0 };
    regionAgg.orders += 1;
    if (order.is_buy_order) {
      regionAgg.escrow += order.escrow ?? remainingValue;
    } else {
      regionAgg.sell_value += remainingValue;
    }
    byRegion.set(order.region_id, regionAgg);
    return {
      order_id: order.order_id,
      type_id: order.type_id,
      name: typeNames.get(order.type_id) ?? null,
      is_buy_order: order.is_buy_order,
      price: order.price,
      volume_remain: order.volume_remain,
      remaining_value: roundIsk(remainingValue),
      escrow: order.escrow === null ? null : roundIsk(order.escrow),
      expires_at: order.expires_at,
    };
  });

  const byRemainingValue = (a: { remaining_value: number }, b: { remaining_value: number }): number =>
    b.remaining_value - a.remaining_value;
  const sellOrders = decorated.filter((order) => !order.is_buy_order).sort(byRemainingValue);
  const buyOrders = decorated.filter((order) => order.is_buy_order).sort(byRemainingValue);
  const expiringSoon = decorated
    .filter((order) => order.expires_at !== null && Date.parse(order.expires_at) <= expiringThresholdMs)
    .sort((a, b) => Date.parse(a.expires_at as string) - Date.parse(b.expires_at as string))
    .slice(0, top);

  const regions = [...byRegion.entries()]
    .sort((a, b) => (b[1].sell_value + b[1].escrow) - (a[1].sell_value + a[1].escrow))
    .map(([regionId, agg]) => ({
      region_id: regionId,
      name: regionNames.get(regionId) ?? null,
      orders: agg.orders,
      sell_value: roundIsk(agg.sell_value),
      escrow: roundIsk(agg.escrow),
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
    totals: {
      orders: orders.length,
      sell_orders: sellOrders.length,
      buy_orders: buyOrders.length,
      sell_value_isk: roundIsk(sellValue),
      buy_escrow_isk: roundIsk(buyEscrow),
      expiring_within_hours: EXPIRING_SOON_HOURS,
      expiring_soon_count: decorated.filter(
        (order) => order.expires_at !== null && Date.parse(order.expires_at) <= expiringThresholdMs,
      ).length,
    },
    top_sell_orders: sellOrders.slice(0, top),
    top_buy_orders: buyOrders.slice(0, top),
    expiring_soon: expiringSoon,
    regions,
  };
}

function parseTop(value: unknown): number | null {
  if (value === null || value === undefined) return DEFAULT_TOP;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TOP) {
    return null;
  }
  return value;
}

function parseOrders(value: unknown): OrderRow[] {
  if (!Array.isArray(value)) throw new Error('orders must be an array');
  if (value.length > MAX_ORDER_ROWS) throw new Error('orders exceed row limit');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid order row');
    const record = entry as Record<string, unknown>;
    const orderId = finiteNumber(record.order_id);
    const typeId = finiteNumber(record.type_id);
    const regionId = finiteNumber(record.region_id);
    const locationId = finiteNumber(record.location_id);
    const price = finiteNumber(record.price);
    const volumeRemain = finiteNumber(record.volume_remain);
    if (orderId === null || typeId === null || typeId <= 0 || regionId === null || locationId === null
      || price === null || price < 0 || volumeRemain === null || volumeRemain < 0) {
      throw new Error('invalid order row fields');
    }
    const escrow = typeof record.escrow === 'number' && Number.isFinite(record.escrow)
      ? record.escrow
      : null;
    const expiresAt = parseExpiry(record);
    return {
      order_id: orderId,
      type_id: typeId,
      region_id: regionId,
      location_id: locationId,
      price,
      volume_remain: volumeRemain,
      is_buy_order: record.is_buy_order === true,
      escrow,
      expires_at: expiresAt,
    };
  });
}

function parseExpiry(record: Record<string, unknown>): string | null {
  // ESI open orders carry `issued` + `duration` (days), not an absolute expiry.
  const issued = typeof record.issued === 'string' ? Date.parse(record.issued) : Number.NaN;
  const duration = typeof record.duration === 'number' && Number.isFinite(record.duration)
    ? record.duration
    : Number.NaN;
  if (!Number.isFinite(issued) || !Number.isFinite(duration) || duration < 0) return null;
  return new Date(issued + duration * 86_400_000).toISOString();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function lookupRegionNames(db: Db, regionIds: number[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const chunk of chunks(regionIds, SDE_IN_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT region_id, name FROM sde_regions WHERE region_id IN (${placeholders})`,
    ).all(...chunk) as Array<{ region_id: number; name: string }>;
    for (const row of rows) names.set(row.region_id, row.name);
  }
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
