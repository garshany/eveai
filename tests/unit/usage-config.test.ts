import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function setRequiredEnv(): void {
  process.env.OPENAI_API_KEY = 'test';
  process.env.EVE_CLIENT_ID = 'test';
  process.env.EVE_CLIENT_SECRET = 'test';
  process.env.DEFAULT_MARKET_REGION_ID = '10000002';
  process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
  // Keep a stray operator .env from repopulating the knobs under test.
  process.env.DOTENV_CONFIG_PATH = '/private/tmp/eveai-test-no-dotenv-file';
}

beforeEach(() => {
  setRequiredEnv();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('transparency & usage configuration', () => {
  it('defaults BOOSTY_URL to the confirmed page, overrides it, and hides it when empty', async () => {
    delete process.env.BOOSTY_URL;
    expect((await import('../../src/config.js')).config.donations.boostyUrl)
      .toBe('https://boosty.to/artemy1337');

    vi.resetModules();
    process.env.BOOSTY_URL = 'https://boosty.to/someone-else';
    expect((await import('../../src/config.js')).config.donations.boostyUrl)
      .toBe('https://boosty.to/someone-else');

    vi.resetModules();
    process.env.BOOSTY_URL = '';
    expect((await import('../../src/config.js')).config.donations.boostyUrl).toBeNull();

    vi.resetModules();
    process.env.BOOSTY_URL = 'http://insecure.example/page';
    await expect(import('../../src/config.js')).rejects.toThrow('BOOSTY_URL');
  });

  it('exposes RUB only with an explicit dated rate and never invents one', async () => {
    delete process.env.USD_RUB_RATE;
    delete process.env.USD_RUB_RATE_DATE;
    expect((await import('../../src/config.js')).config.fx)
      .toEqual({ usdRubRate: null, usdRubRateDate: null });

    vi.resetModules();
    process.env.USD_RUB_RATE = '95.40';
    process.env.USD_RUB_RATE_DATE = '2026-07-27';
    expect((await import('../../src/config.js')).config.fx)
      .toEqual({ usdRubRate: 95.4, usdRubRateDate: '2026-07-27' });

    vi.resetModules();
    delete process.env.USD_RUB_RATE_DATE;
    await expect(import('../../src/config.js')).rejects.toThrow('USD_RUB_RATE_DATE');

    vi.resetModules();
    process.env.USD_RUB_RATE = '0';
    await expect(import('../../src/config.js')).rejects.toThrow('USD_RUB_RATE');
  });

  it('ships the owner’s tariffs by default and lets MODEL_PRICING_JSON replace them', async () => {
    delete process.env.MODEL_PRICING_JSON;
    const defaults = (await import('../../src/config.js')).config.usage.pricing;
    expect(defaults['gpt-5.6-sol']).toEqual({
      input: 0.06825, output: 0.34125, cached: 0.0126, reasoning: 0.34125,
    });
    expect(defaults['gpt-5.6-terra']).toEqual({
      input: 0.0525, output: 0.2625, cached: 0.0126, reasoning: 0.2625,
    });
    expect(defaults['gpt-5.6-luna']).toEqual({
      input: 0.042, output: 0.21, cached: 0.0126, reasoning: 0.21,
    });

    vi.resetModules();
    // An empty value behaves like unset: the defaults still apply.
    process.env.MODEL_PRICING_JSON = '';
    expect((await import('../../src/config.js')).config.usage.pricing).toEqual(defaults);

    vi.resetModules();
    process.env.MODEL_PRICING_JSON = '{"gpt-5.6-sol": {"input": 2, "output": 8, "cached": 0.5, "reasoning": 8}}';
    const { config } = await import('../../src/config.js');
    expect(config.usage.pricing).toEqual({
      'gpt-5.6-sol': { input: 2, output: 8, cached: 0.5, reasoning: 8 },
    });

    // The knob reaches the actual cost path, not just the config object.
    const { computeUsageCostMicros } = await import('../../src/usage/pricing.js');
    expect(computeUsageCostMicros(
      { input: 1_000_000, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      config.usage.pricing,
      'gpt-5.6-sol',
    )).toBe(2_000_000);
    expect(computeUsageCostMicros(
      { input: 1000, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      config.usage.pricing,
      'unlisted-model',
    )).toBeNull();

    vi.resetModules();
    process.env.MODEL_PRICING_JSON = '{broken';
    await expect(import('../../src/config.js')).rejects.toThrow('MODEL_PRICING_JSON');
  });

  it('bounds the raw-event retention window and wires it into the rollup', async () => {
    delete process.env.USAGE_EVENTS_RETENTION_DAYS;
    expect((await import('../../src/config.js')).config.usage.retentionDays).toBe(30);

    vi.resetModules();
    process.env.USAGE_EVENTS_RETENTION_DAYS = '90';
    expect((await import('../../src/config.js')).config.usage.retentionDays).toBe(90);

    vi.resetModules();
    process.env.USAGE_EVENTS_RETENTION_DAYS = '1'; // clamped: tail + one cycle must survive
    expect((await import('../../src/config.js')).config.usage.retentionDays).toBe(2);

    vi.resetModules();
    process.env.USAGE_EVENTS_RETENTION_DAYS = '99999';
    expect((await import('../../src/config.js')).config.usage.retentionDays).toBe(365);

    vi.resetModules();
    process.env.USAGE_EVENTS_RETENTION_DAYS = '0';
    await expect(import('../../src/config.js')).rejects.toThrow('USAGE_EVENTS_RETENTION_DAYS');
  });

  it('parses the BigQuery export settings and bounds their timers', async () => {
    delete process.env.GCP_BILLING_PROJECT_ID;
    delete process.env.GCP_BILLING_DATASET;
    delete process.env.GCP_BILLING_TABLE;
    delete process.env.GCP_BILLING_SERVICE_ACCOUNT_KEY_PATH;
    delete process.env.GCP_BILLING_REFRESH_TTL_MS;
    delete process.env.GCP_BILLING_QUERY_TIMEOUT_MS;
    expect((await import('../../src/config.js')).config.gcpBilling).toEqual({
      projectId: '',
      dataset: '',
      table: '',
      serviceAccountKeyPath: '',
      refreshTtlMs: 3_600_000,
      queryTimeoutMs: 10_000,
    });

    vi.resetModules();
    process.env.GCP_BILLING_PROJECT_ID = 'my-project';
    process.env.GCP_BILLING_DATASET = 'billing_export';
    process.env.GCP_BILLING_TABLE = 'gcp_billing_export_v1';
    process.env.GCP_BILLING_SERVICE_ACCOUNT_KEY_PATH = '/secrets/reader.json';
    process.env.GCP_BILLING_REFRESH_TTL_MS = '10'; // below the floor -> clamped
    process.env.GCP_BILLING_QUERY_TIMEOUT_MS = '4500';
    expect((await import('../../src/config.js')).config.gcpBilling).toEqual({
      projectId: 'my-project',
      dataset: 'billing_export',
      table: 'gcp_billing_export_v1',
      serviceAccountKeyPath: '/secrets/reader.json',
      refreshTtlMs: 60_000,
      queryTimeoutMs: 4_500,
    });
  });

  it('parses the infrastructure estimate strictly', async () => {
    delete process.env.INFRA_ESTIMATE_USD_MONTHLY;
    expect((await import('../../src/config.js')).config.infra.estimateMonthlyUsd).toBe(19);

    vi.resetModules();
    process.env.INFRA_ESTIMATE_USD_MONTHLY = '23.5';
    expect((await import('../../src/config.js')).config.infra.estimateMonthlyUsd).toBe(23.5);

    vi.resetModules();
    process.env.INFRA_ESTIMATE_USD_MONTHLY = 'cheap';
    await expect(import('../../src/config.js')).rejects.toThrow('INFRA_ESTIMATE_USD_MONTHLY');
  });

  it('clamps the public transparency cache window, with 0 restoring no-store', async () => {
    delete process.env.TRANSPARENCY_PUBLIC_CACHE_SECONDS;
    expect((await import('../../src/config.js')).config.transparency.publicCacheSeconds).toBe(60);

    vi.resetModules();
    process.env.TRANSPARENCY_PUBLIC_CACHE_SECONDS = '0';
    expect((await import('../../src/config.js')).config.transparency.publicCacheSeconds).toBe(0);

    vi.resetModules();
    process.env.TRANSPARENCY_PUBLIC_CACHE_SECONDS = '999999';
    expect((await import('../../src/config.js')).config.transparency.publicCacheSeconds).toBe(3600);
  });
});
