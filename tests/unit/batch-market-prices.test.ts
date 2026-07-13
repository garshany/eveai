import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the ESI transport so the test never touches the network. batch_market_prices
// calls get_markets_region_id_orders per type, then falls back to get_markets_prices
// (global average) for items whose regional order book is empty (e.g. PLEX).
const { callEsiOperationMock } = vi.hoisted(() => ({ callEsiOperationMock: vi.fn() }));
vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

const PLEX = 44992;
const TRITANIUM = 34;

type PriceResult = {
  type_id: number;
  error?: string;
  sell: { min_price: number } | null;
  buy: { max_price: number } | null;
  global_average_price?: number;
  note?: string;
};

async function runBatch(typeIds: number[]): Promise<PriceResult[]> {
  const { __test__ } = await import('../../src/agent/executor.js');
  const { createWebSearchState } = await import('../../src/agent/web-search.js');
  const db = {} as never;
  const ctx = { userId: 1, chatId: 1 };
  const result = (await __test__.executeToolCall(
    db,
    'req-1',
    'price check',
    ctx,
    'batch_market_prices',
    { region_id: 10000002, type_ids: typeIds },
    createWebSearchState(),
  )) as { ok: boolean; prices: PriceResult[] };
  return result.prices;
}

describe('batch_market_prices global-average fallback', () => {
  beforeEach(() => {
    callEsiOperationMock.mockReset();
  });

  it('backfills global average price when the regional order book is empty (PLEX)', async () => {
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string, args: Record<string, unknown>) => {
      if (operation === 'get_markets_region_id_orders') {
        // PLEX trades on a global market, so its regional order book is empty.
        return args.type_id === PLEX ? { ok: true, data: [] } : { ok: true, data: [] };
      }
      if (operation === 'get_markets_prices') {
        return { ok: true, data: [{ type_id: PLEX, average_price: 4621543.38, adjusted_price: 0 }] };
      }
      return { ok: false, error: `unexpected op ${operation}` };
    });

    const prices = await runBatch([PLEX]);
    expect(prices).toHaveLength(1);
    expect(prices[0].sell).toBeNull();
    expect(prices[0].buy).toBeNull();
    expect(prices[0].global_average_price).toBeCloseTo(4621543.38, 2);
    expect(prices[0].note).toMatch(/global/i);
    // The global list must be fetched exactly once for the empty item.
    const globalCalls = callEsiOperationMock.mock.calls.filter((c) => c[1] === 'get_markets_prices');
    expect(globalCalls).toHaveLength(1);
  });

  it('does not report adjusted_price as a market average (no trade average available)', async () => {
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_markets_region_id_orders') return { ok: true, data: [] };
      if (operation === 'get_markets_prices') {
        // Item has only CCP's internal adjusted valuation, no trade average.
        return { ok: true, data: [{ type_id: PLEX, adjusted_price: 1234567.0 }] };
      }
      return { ok: false, error: `unexpected op ${operation}` };
    });

    const prices = await runBatch([PLEX]);
    expect(prices[0].sell).toBeNull();
    expect(prices[0].buy).toBeNull();
    // adjusted_price must NOT be surfaced as a market price.
    expect(prices[0].global_average_price).toBeUndefined();
  });

  it('uses regional order book and skips the global list when orders exist', async () => {
    callEsiOperationMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_markets_region_id_orders') {
        return {
          ok: true,
          data: [
            { price: 5.5, volume_remain: 1000, is_buy_order: false },
            { price: 4.0, volume_remain: 500, is_buy_order: true },
          ],
        };
      }
      return { ok: false, error: `should not be called: ${operation}` };
    });

    const prices = await runBatch([TRITANIUM]);
    expect(prices[0].sell?.min_price).toBe(5.5);
    expect(prices[0].buy?.max_price).toBe(4.0);
    expect(prices[0].global_average_price).toBeUndefined();
    // No empty items → global price list must NOT be fetched.
    const globalCalls = callEsiOperationMock.mock.calls.filter((c) => c[1] === 'get_markets_prices');
    expect(globalCalls).toHaveLength(0);
  });
});
