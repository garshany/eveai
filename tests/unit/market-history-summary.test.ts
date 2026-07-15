import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProgrammaticToolOutput } from '../../src/agent/programmatic-contracts.js';

const mocks = vi.hoisted(() => ({ callEsiOperation: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: mocks.callEsiOperation }));

import {
  MARKET_HISTORY_SUMMARY_TOOL,
  executeMarketHistorySummary,
  isMarketHistorySummaryTool,
  validateMarketHistorySummaryArgs,
} from '../../src/eve/market-history-summary.js';

const db = {} as never;
const validArgs = { region_id: 10000002, type_id: 34, days: 30 } as const;

beforeEach(() => mocks.callEsiOperation.mockReset());

describe('market_history_summary facade', () => {
  it('exposes a strict direct tool and independently rejects malformed inputs before egress', async () => {
    expect(MARKET_HISTORY_SUMMARY_TOOL).toMatchObject({
      name: 'market_history_summary', strict: true,
      parameters: { required: ['region_id', 'type_id', 'days'], additionalProperties: false },
    });
    expect(MARKET_HISTORY_SUMMARY_TOOL.defer_loading).toBeUndefined();
    expect(isMarketHistorySummaryTool('market_history_summary')).toBe(true);
    expect(validateMarketHistorySummaryArgs(validArgs)).toMatchObject({ ok: true, data: validArgs });
    for (const args of [
      { ...validArgs, extra: 'secret' },
      { ...validArgs, region_id: 0 },
      { ...validArgs, type_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...validArgs, days: 31 },
    ]) {
      const result = await executeMarketHistorySummary(db, args);
      expect(result).toEqual({
        ok: false, source: 'CCP ESI', authoritative: true,
        error: 'Invalid market_history_summary arguments.', status: null, blocked: true,
      });
    }
    expect(mocks.callEsiOperation).not.toHaveBeenCalled();
  });

  it('sorts, excludes future rows, and computes rounded deterministic aggregates without raw history', async () => {
    mocks.callEsiOperation.mockResolvedValue({
      ok: true,
      status: 200,
      cached: false,
      headers: { 'cache-control': 'public, max-age=300' },
      data: [
        row('2026-07-03', 121, 130, 115, 3, 30),
        row('2999-01-01', 999, 999, 999, 1, 1),
        row('2026-07-01', 100, 110, 90, 1, 10),
        row('2026-07-02', 110, 120, 100, 2, 20),
      ],
    });
    const result = await executeMarketHistorySummary(db, validArgs);

    expect(mocks.callEsiOperation).toHaveBeenCalledWith(
      db,
      'get_markets_region_id_history',
      { region_id: validArgs.region_id, type_id: validArgs.type_id },
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: { data_through: '2026-07-03T00:00:00.000Z', cache_max_age_seconds: 300 },
      region_id: 10000002,
      type_id: 34,
      requested_days: 30,
      window: { first_date: '2026-07-01', last_date: '2026-07-03' },
      observed_days: 3,
      price: {
        lowest: 90,
        highest: 130,
        mean_daily_average: 110.333333,
        volume_weighted_average: 113.833333,
        change_percent: 21,
      },
      volume: { total: 60, mean_per_observed_day: 20 },
      volatility: { daily_return_stddev_percent: 0 },
      liquidity: { total_orders: 6, mean_orders_per_observed_day: 2, active_days: 3 },
    });
    expect(JSON.stringify(result)).not.toContain('order_count');
    expect(JSON.stringify(result)).not.toContain('2999');
    expect(validateProgrammaticToolOutput('market_history_summary', result)).toEqual({ valid: true, errors: [] });
  });

  it('returns an honest empty summary with nullable calculations', async () => {
    mocks.callEsiOperation.mockResolvedValue({ ok: true, status: 200, cached: false, headers: {}, data: [] });
    const result = await executeMarketHistorySummary(db, { ...validArgs, days: 90 });
    expect(result).toMatchObject({
      ok: true,
      observed_days: 0,
      freshness: { data_through: null, cache_max_age_seconds: null },
      window: { first_date: null, last_date: null },
      price: {
        lowest: null, highest: null, mean_daily_average: null,
        volume_weighted_average: null, change_percent: null,
      },
      volume: { total: 0, mean_per_observed_day: null },
      volatility: { daily_return_stddev_percent: null },
      liquidity: { total_orders: 0, mean_orders_per_observed_day: null, active_days: 0 },
    });
  });

  it('does not bridge volatility returns across a non-positive intervening day', async () => {
    mocks.callEsiOperation.mockResolvedValue({
      ok: true,
      status: 200,
      cached: false,
      headers: {},
      data: [
        row('2026-07-01', 100, 100, 100, 1, 1),
        row('2026-07-02', 0, 0, 0, 1, 1),
        row('2026-07-03', 121, 121, 121, 1, 1),
      ],
    });
    expect(await executeMarketHistorySummary(db, validArgs)).toMatchObject({
      ok: true,
      volatility: { daily_return_stddev_percent: null },
    });
  });

  it('rejects more than 500 upstream history rows before aggregation', async () => {
    mocks.callEsiOperation.mockResolvedValue({
      ok: true,
      status: 200,
      cached: false,
      headers: {},
      data: Array.from({ length: 501 }, (_, index) => row('2026-07-01', 100 + index, 110 + index, 90, 1, 1)),
    });
    expect(await executeMarketHistorySummary(db, validArgs)).toMatchObject({
      ok: false,
      error: 'CCP ESI returned an invalid market history response.',
      blocked: false,
    });
  });

  it('deduplicates byte-equivalent dates but fails closed on conflicting, malformed, or non-finite rows', async () => {
    const same = row('2026-07-01', 100, 110, 90, 1, 10);
    mocks.callEsiOperation.mockResolvedValue({ ok: true, status: 200, cached: false, headers: {}, data: [same, same] });
    expect(await executeMarketHistorySummary(db, validArgs)).toMatchObject({ ok: true, observed_days: 1 });

    for (const data of [
      [same, { ...same, average: 101 }],
      [{ ...same, average: Number.NaN }],
      [{ ...same, date: '2026-02-30' }],
      [{ ...same, volume: -1 }],
      [{ ...same, lowest: 120, highest: 110 }],
    ]) {
      mocks.callEsiOperation.mockResolvedValue({ ok: true, status: 200, cached: false, headers: {}, data });
      expect(await executeMarketHistorySummary(db, validArgs)).toEqual({
        ok: false, source: 'CCP ESI', authoritative: true,
        error: 'CCP ESI returned an invalid market history response.', status: null, blocked: false,
      });
    }
  });

  it('sanitizes upstream errors and never reflects bodies or arguments', async () => {
    mocks.callEsiOperation.mockResolvedValue({ ok: false, status: 503, error: 'token-secret raw URL' });
    const result = await executeMarketHistorySummary(db, validArgs);
    expect(result).toEqual({
      ok: false, source: 'CCP ESI', authoritative: true,
      error: 'CCP ESI market history request failed with HTTP status 503.', status: 503, blocked: false,
    });
    expect(JSON.stringify(result)).not.toContain('token-secret');
  });
});

function row(
  date: string,
  average: number,
  highest: number,
  lowest: number,
  orderCount: number,
  volume: number,
) {
  return { average, date, highest, lowest, order_count: orderCount, volume };
}
