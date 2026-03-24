import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveProxyHealthUrl,
  deriveProxyModelsUrl,
  normalizeBaseUrl,
  resolveAppBaseUrl,
  runSmokeChecks,
} from '../../src/smoke.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('smoke helpers', () => {
  it('normalizes base URLs and derives proxy endpoints', () => {
    expect(normalizeBaseUrl('http://localhost:8088/v1/')).toBe('http://localhost:8088/v1');
    expect(deriveProxyHealthUrl('http://localhost:8088/v1')).toBe('http://localhost:8088/health');
    expect(deriveProxyModelsUrl('http://localhost:8088/v1')).toBe('http://localhost:8088/v1/models');
  });

  it('resolves app base URL from web base url or host/port', () => {
    process.env.WEB_BASE_URL = 'https://eve.example.com/';
    expect(resolveAppBaseUrl()).toBe('https://eve.example.com');

    delete process.env.WEB_BASE_URL;
    process.env.HOST = '0.0.0.0';
    process.env.PORT = '3001';
    expect(resolveAppBaseUrl()).toBe('http://127.0.0.1:3001');
  });
});

describe('runSmokeChecks', () => {
  it('skips proxy check when OPENAI_BASE_URL is not a local proxy URL', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.OPENAI_API_KEY = 'x';
    process.env.EVE_CLIENT_ID = 'x';
    process.env.EVE_CLIENT_SECRET = 'x';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.WEB_BASE_URL = 'http://127.0.0.1:3000';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:3000/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const result = await runSmokeChecks();

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === 'proxy_health')?.status).toBe('skip');
    expect(result.checks.find((check) => check.name === 'app_health')?.status).toBe('ok');
  });

  it('fails when local proxy or app health is unavailable', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.OPENAI_API_KEY = 'x';
    process.env.EVE_CLIENT_ID = 'x';
    process.env.EVE_CLIENT_SECRET = 'x';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.OPENAI_BASE_URL = 'http://localhost:8088/v1';
    process.env.WEB_BASE_URL = 'http://127.0.0.1:3000';

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'http://localhost:8088/health') {
        return new Response('bad', { status: 503 });
      }
      if (url === 'http://localhost:8088/v1/models') {
        return new Response('{}', { status: 200 });
      }
      if (url === 'http://127.0.0.1:3000/health') {
        return new Response(JSON.stringify({ status: 'degraded' }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const result = await runSmokeChecks();

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === 'proxy_health')?.status).toBe('fail');
    expect(result.checks.find((check) => check.name === 'app_health')?.status).toBe('fail');
  });
});
