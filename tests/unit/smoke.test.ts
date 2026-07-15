import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeBaseUrl,
  resolveAppBaseUrl,
  runSmokeChecks,
} from '../../src/smoke.js';

const createNativeResponseMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/native-responses.js', () => ({
  createNativeResponse: createNativeResponseMock,
  toNativeMessage: (text: string) => ({
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
  }),
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('smoke helpers', () => {
  it('normalizes base URLs', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl(undefined)).toBe('');
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
  it('passes when the OpenAI API and app health respond', async () => {
    delete process.env.OPENAI_PROVIDER;
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.OPENAI_API_KEY = 'x';
    process.env.EVE_CLIENT_ID = 'x';
    process.env.EVE_CLIENT_SECRET = 'x';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.WEB_BASE_URL = 'http://127.0.0.1:3000';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    process.env.OPENAI_STORE_RESPONSES = 'true';

    let openAiBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.openai.com/v1/responses') {
        openAiBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_x","output_text":"pong"}}\n\n', { status: 200 });
      }
      if (url === 'http://127.0.0.1:3000/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const result = await runSmokeChecks();

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === 'model_responses')?.status).toBe('ok');
    expect(result.checks.find((check) => check.name === 'app_health')?.status).toBe('ok');
    expect(openAiBody?.store).toBe(true);
  });

  it('fails when the model endpoint or app health is unavailable', async () => {
    delete process.env.OPENAI_PROVIDER;
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.OPENAI_API_KEY = 'x';
    process.env.EVE_CLIENT_ID = 'x';
    process.env.EVE_CLIENT_SECRET = 'x';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    process.env.WEB_BASE_URL = 'http://127.0.0.1:3000';

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://api.openai.com/v1/responses') {
        return new Response('model unavailable', { status: 503 });
      }
      if (url === 'http://127.0.0.1:3000/health') {
        return new Response(JSON.stringify({ status: 'degraded' }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    const result = await runSmokeChecks();

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === 'model_responses')?.status).toBe('fail');
    expect(result.checks.find((check) => check.name === 'app_health')?.status).toBe('fail');
  });

  it('checks the selected CheapVibeCode Responses endpoint', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'x';
    process.env.OPENAI_API_KEY = 'x';
    process.env.EVE_CLIENT_ID = 'x';
    process.env.EVE_CLIENT_SECRET = 'x';
    process.env.DEFAULT_MARKET_REGION_ID = '10000002';
    process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
    process.env.OPENAI_PROVIDER = 'cheapvibecode';
    process.env.WEB_BASE_URL = 'http://127.0.0.1:3000';

    createNativeResponseMock.mockResolvedValueOnce({
      id: 'resp_cvc', output: [], outputText: 'pong', error: null, status: 'completed',
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:3000/health') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runSmokeChecks();

    expect(result.ok).toBe(true);
    expect(createNativeResponseMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('cheapvibecode.ru'), expect.anything());
  });
});
