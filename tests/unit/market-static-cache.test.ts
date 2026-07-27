import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedMarketStatic,
  clearMarketStaticCache,
} from '../../web/src/components/market/static-cache.js';

describe('cachedMarketStatic', () => {
  beforeEach(() => {
    clearMarketStaticCache();
  });

  it('serves the same key from memory and dedupes parallel loads', async () => {
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return 'value';
    };
    const [first, second] = await Promise.all([
      cachedMarketStatic('k', loader),
      cachedMarketStatic('k', loader),
    ]);
    expect(first).toBe('value');
    expect(second).toBe('value');
    expect(loads).toBe(1);
    await cachedMarketStatic('k', loader);
    expect(loads).toBe(1);
  });

  it('does not cache failures', async () => {
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network');
      return 'recovered';
    };
    await expect(cachedMarketStatic('flaky', flaky)).rejects.toThrow('network');
    await expect(cachedMarketStatic('flaky', flaky)).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('evicts the oldest entries beyond the 300-record ceiling', async () => {
    for (let index = 0; index < 305; index += 1) {
      await cachedMarketStatic(`key-${index}`, async () => index);
    }
    // Первые пять выселены: повторный запрос — это новая загрузка.
    let reloads = 0;
    const spy = async () => {
      reloads += 1;
      return 'again';
    };
    await cachedMarketStatic('key-0', spy);
    expect(reloads).toBe(1);
    // Хвост кэша на месте: перезагрузки нет.
    await cachedMarketStatic('key-304', spy);
    expect(reloads).toBe(1);
  });

  it('drops everything on clear (logout switches the user)', async () => {
    await cachedMarketStatic('owned', async () => 'stale');
    clearMarketStaticCache();
    let reloads = 0;
    await cachedMarketStatic('owned', async () => {
      reloads += 1;
      return 'fresh';
    });
    expect(reloads).toBe(1);
  });
});
