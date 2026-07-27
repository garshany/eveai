import { describe, expect, it } from 'vitest';
import { computeUsageCostMicros, parseModelPricingJson } from '../../src/usage/pricing.js';

describe('parseModelPricingJson', () => {
  it('treats unset and empty as "no tariffs known"', () => {
    expect(parseModelPricingJson(undefined)).toEqual({});
    expect(parseModelPricingJson('')).toEqual({});
    expect(parseModelPricingJson('   ')).toEqual({});
  });

  it('parses a valid pricing table keyed by model id', () => {
    const table = parseModelPricingJson(
      '{"gpt-5.6-sol": {"input": 2, "output": 8, "cached": 0.5, "reasoning": 8}, "other": {"input": 0, "output": 0, "cached": 0, "reasoning": 0}}',
    );
    expect(table['gpt-5.6-sol']).toEqual({ input: 2, output: 8, cached: 0.5, reasoning: 8 });
    expect(table.other).toEqual({ input: 0, output: 0, cached: 0, reasoning: 0 });
  });

  it('rejects malformed JSON and non-object payloads', () => {
    expect(() => parseModelPricingJson('{nope')).toThrow('MODEL_PRICING_JSON');
    expect(() => parseModelPricingJson('[1,2]')).toThrow('MODEL_PRICING_JSON');
    expect(() => parseModelPricingJson('42')).toThrow('MODEL_PRICING_JSON');
  });

  it('rejects missing, non-numeric, or negative rates', () => {
    expect(() => parseModelPricingJson('{"m": {"input": 1, "output": 1, "cached": 1}}'))
      .toThrow('MODEL_PRICING_JSON');
    expect(() => parseModelPricingJson('{"m": {"input": "1", "output": 1, "cached": 1, "reasoning": 1}}'))
      .toThrow('MODEL_PRICING_JSON');
    expect(() => parseModelPricingJson('{"m": {"input": -1, "output": 1, "cached": 1, "reasoning": 1}}'))
      .toThrow('MODEL_PRICING_JSON');
  });

  it('rejects unknown rate keys so typos cannot silently misprice', () => {
    expect(() => parseModelPricingJson('{"m": {"input": 1, "output": 1, "cached": 1, "reasoning": 1, "cacheWrite": 2}}'))
      .toThrow('MODEL_PRICING_JSON');
  });
});

describe('computeUsageCostMicros', () => {
  const pricing = parseModelPricingJson(
    '{"m": {"input": 2, "output": 8, "cached": 0.5, "reasoning": 16}}',
  );

  it('returns null for an unknown model — never a fake zero', () => {
    expect(computeUsageCostMicros(
      { input: 1000, output: 500, cached: 0, cacheWrite: 0, reasoning: 0 },
      pricing,
      'no-such-model',
    )).toBeNull();
    expect(computeUsageCostMicros(
      { input: 1000, output: 500, cached: 0, cacheWrite: 0, reasoning: 0 },
      {},
      'm',
    )).toBeNull();
  });

  it('prices with $/1M rates landing exactly on microdollars', () => {
    // 1_000_000 uncached input at $2/1M = $2 = 2_000_000 micros.
    expect(computeUsageCostMicros(
      { input: 1_000_000, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      pricing,
      'm',
    )).toBe(2_000_000);
  });

  it('treats cached as a subset of input and reasoning as a subset of output', () => {
    // input 100k of which 40k cached; output 10k of which 4k reasoning.
    // uncached 60k*2 + cached 40k*0.5 + visible 6k*8 + reasoning 4k*16
    // = 120_000 + 20_000 + 48_000 + 64_000 = 252_000 micros.
    expect(computeUsageCostMicros(
      { input: 100_000, output: 10_000, cached: 40_000, cacheWrite: 5_000, reasoning: 4_000 },
      pricing,
      'm',
    )).toBe(252_000);
  });

  it('rounds to integer microdollars at half-up boundaries', () => {
    // 1 token at $0.4/1M = 0.4 micros -> 0.
    expect(computeUsageCostMicros(
      { input: 1, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      parseModelPricingJson('{"m": {"input": 0.4, "output": 0, "cached": 0, "reasoning": 0}}'),
      'm',
    )).toBe(0);
    // 1 token at $0.5/1M = 0.5 micros -> 1 (half up).
    expect(computeUsageCostMicros(
      { input: 1, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      parseModelPricingJson('{"m": {"input": 0.5, "output": 0, "cached": 0, "reasoning": 0}}'),
      'm',
    )).toBe(1);
    // 3 tokens at $0.5/1M = 1.5 micros -> 2.
    expect(computeUsageCostMicros(
      { input: 3, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      parseModelPricingJson('{"m": {"input": 0.5, "output": 0, "cached": 0, "reasoning": 0}}'),
      'm',
    )).toBe(2);
  });

  it('clamps provider arithmetic anomalies instead of producing negative costs', () => {
    expect(computeUsageCostMicros(
      { input: 100, output: 50, cached: 500, cacheWrite: 0, reasoning: 500 },
      pricing,
      'm',
    )).toBe(computeUsageCostMicros(
      { input: 100, output: 50, cached: 100, cacheWrite: 0, reasoning: 50 },
      pricing,
      'm',
    ));
  });
});
