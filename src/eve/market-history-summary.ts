import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';

const ARGUMENT_KEYS = new Set(['region_id', 'type_id', 'days']);
const MAX_OUTPUT_CHARS = 12_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type MarketHistorySummaryArgs = {
  region_id: number;
  type_id: number;
  days: 30 | 90;
};

export type MarketHistorySummaryError = {
  ok: false;
  source: 'CCP ESI';
  authoritative: true;
  error: string;
  status: number | null;
  blocked: boolean;
};

type HistoryRow = {
  average: number;
  date: string;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
};

export const MARKET_HISTORY_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: 'market_history_summary',
  description:
    'Summarize the latest 30 or 90 validated public ESI market-history observations for one exact region/type pair. '
    + 'Returns bounded price, volume, volatility, and liquidity aggregates without raw daily rows.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      region_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      days: { type: 'integer', enum: [30, 90] },
    },
    required: ['region_id', 'type_id', 'days'],
    additionalProperties: false,
  },
};

export function isMarketHistorySummaryTool(name: string): boolean {
  return name === MARKET_HISTORY_SUMMARY_TOOL.name;
}

export function validateMarketHistorySummaryArgs(
  args: Record<string, unknown>,
  _options: { programmatic?: boolean } = {},
): { ok: true; data: MarketHistorySummaryArgs } | { ok: false; error: MarketHistorySummaryError } {
  if (!isPlainRecord(args) || Object.keys(args).length !== ARGUMENT_KEYS.size
    || Object.keys(args).some((key) => !ARGUMENT_KEYS.has(key))) {
    return invalidArguments();
  }
  if (!isPositiveSafeInteger(args.region_id) || !isPositiveSafeInteger(args.type_id)
    || (args.days !== 30 && args.days !== 90)) {
    return invalidArguments();
  }
  return {
    ok: true,
    data: { region_id: args.region_id, type_id: args.type_id, days: args.days },
  };
}

export async function executeMarketHistorySummary(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = validateMarketHistorySummaryArgs(rawArgs);
  if (!parsed.ok) return parsed.error;
  const args = parsed.data;

  try {
    const response = await callEsiOperation(
      db,
      'get_markets_region_id_history',
      { region_id: args.region_id, type_id: args.type_id },
      null,
    );
    if (!response.ok) return esiFailure(response.status);
    const rows = parseHistory(response.data);
    const today = new Date().toISOString().slice(0, 10);
    const selected = rows
      .filter((row) => row.date <= today)
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-args.days);
    const summary = summarize(args, selected, response.headers);
    return safeResult(summary, 'CCP ESI returned an invalid market history response.');
  } catch {
    return facadeError('CCP ESI returned an invalid market history response.');
  }
}

function parseHistory(value: unknown): HistoryRow[] {
  if (!Array.isArray(value)) throw new Error('history must be an array');
  if (value.length > 500) throw new Error('history exceeds row limit');
  const byDate = new Map<string, { raw: string; row: HistoryRow }>();
  for (const valueRow of value) {
    const source = record(valueRow);
    const row: HistoryRow = {
      average: finiteNonNegative(source.average),
      date: calendarDate(source.date),
      highest: finiteNonNegative(source.highest),
      lowest: finiteNonNegative(source.lowest),
      order_count: nonNegativeSafeInteger(source.order_count),
      volume: nonNegativeSafeInteger(source.volume),
    };
    if (row.highest < row.lowest) throw new Error('invalid price range');
    const raw = JSON.stringify(valueRow);
    const existing = byDate.get(row.date);
    if (existing && existing.raw !== raw) throw new Error('conflicting duplicate date');
    if (!existing) byDate.set(row.date, { raw, row });
  }
  return [...byDate.values()].map((entry) => entry.row);
}

function summarize(
  args: MarketHistorySummaryArgs,
  rows: HistoryRow[],
  headers: Record<string, string>,
): Record<string, unknown> {
  const observedDays = rows.length;
  const totalVolume = safeIntegerSum(rows.map((row) => row.volume));
  const totalOrders = safeIntegerSum(rows.map((row) => row.order_count));
  const averageSum = rows.reduce((sum, row) => sum + row.average, 0);
  const weightedSum = rows.reduce((sum, row) => sum + row.average * row.volume, 0);
  const returns = rows.slice(1).flatMap((row, index) => {
    const previous = rows[index]!;
    return previous.average > 0 && row.average > 0
      ? [(row.average / previous.average - 1) * 100]
      : [];
  });
  const returnMean = returns.length > 0
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : null;
  const volatility = returnMean === null
    ? null
    : Math.sqrt(returns.reduce((sum, value) => sum + ((value - returnMean) ** 2), 0) / returns.length);
  const firstAverage = rows[0]?.average;
  const lastAverage = rows.at(-1)?.average;

  return {
    ok: true,
    source: 'CCP ESI',
    authoritative: true,
    freshness: {
      retrieved_at: new Date().toISOString(),
      data_through: rows.length > 0 ? `${rows.at(-1)!.date}T00:00:00.000Z` : null,
      cache_max_age_seconds: cacheMaxAge(headers),
    },
    region_id: args.region_id,
    type_id: args.type_id,
    requested_days: args.days,
    window: {
      first_date: rows[0]?.date ?? null,
      last_date: rows.at(-1)?.date ?? null,
    },
    observed_days: observedDays,
    price: {
      lowest: observedDays > 0 ? round(Math.min(...rows.map((row) => row.lowest))) : null,
      highest: observedDays > 0 ? round(Math.max(...rows.map((row) => row.highest))) : null,
      mean_daily_average: observedDays > 0 ? round(averageSum / observedDays) : null,
      volume_weighted_average: totalVolume > 0 ? round(weightedSum / totalVolume) : null,
      change_percent: observedDays >= 2 && firstAverage !== undefined && firstAverage > 0 && lastAverage !== undefined
        ? round((lastAverage / firstAverage - 1) * 100)
        : null,
    },
    volume: {
      total: totalVolume,
      mean_per_observed_day: observedDays > 0 ? round(totalVolume / observedDays) : null,
    },
    volatility: {
      daily_return_stddev_percent: returns.length > 0 ? round(volatility!) : null,
    },
    liquidity: {
      total_orders: totalOrders,
      mean_orders_per_observed_day: observedDays > 0 ? round(totalOrders / observedDays) : null,
      active_days: rows.filter((row) => row.volume > 0).length,
    },
  };
}

function cacheMaxAge(headers: Record<string, string>): number | null {
  const match = /(?:^|,)\s*max-age=(\d+)\b/i.exec(headers['cache-control'] ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeIntegerSum(values: number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum) || sum < 0) throw new Error('unsafe total');
  return sum;
}

function round(value: number): number {
  if (!Number.isFinite(value)) throw new Error('non-finite result');
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid date');
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error('invalid date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('invalid date');
  }
  return value;
}

function safeResult(value: Record<string, unknown>, error: string): Record<string, unknown> {
  try {
    assertJsonValue(value);
    if (JSON.stringify(value).length > MAX_OUTPUT_CHARS) return facadeError(error);
    return value;
  } catch {
    return facadeError(error);
  }
}

function assertJsonValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry);
    return;
  }
  const row = record(value);
  for (const entry of Object.values(row)) assertJsonValue(entry);
}

function invalidArguments(): { ok: false; error: MarketHistorySummaryError } {
  return { ok: false, error: facadeError('Invalid market_history_summary arguments.', null, true) };
}

function esiFailure(status: unknown): MarketHistorySummaryError {
  const safeStatus = safeHttpStatus(status);
  return facadeError(
    safeStatus === null ? 'CCP ESI market history request failed.' : `CCP ESI market history request failed with HTTP status ${safeStatus}.`,
    safeStatus,
  );
}

function facadeError(
  error: string,
  status: number | null = null,
  blocked = false,
): MarketHistorySummaryError {
  return { ok: false, source: 'CCP ESI', authoritative: true, error, status, blocked };
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function finiteNonNegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid number');
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid integer');
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('expected plain object');
  return value;
}
