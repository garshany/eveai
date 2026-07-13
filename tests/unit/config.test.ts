import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function setRequiredEnv(): void {
  process.env.OPENAI_API_KEY = 'test';
  process.env.EVE_CLIENT_ID = 'test';
  process.env.EVE_CLIENT_SECRET = 'test';
  process.env.DEFAULT_MARKET_REGION_ID = '10000002';
  process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('OpenAI runtime configuration', () => {
  it('pins requests to the official OpenAI endpoint even when a legacy override is present', async () => {
    setRequiredEnv();
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1';

    const { config } = await import('../../src/config.js');

    expect(config.openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('rejects unsupported server-side Responses state', async () => {
    setRequiredEnv();
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'OPENAI_RESPONSE_STATE_MODE=server is unsupported',
    );
  });
});
