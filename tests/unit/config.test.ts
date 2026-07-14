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
  it('parses the programmatic tool calling pilot strictly and defaults it off', async () => {
    setRequiredEnv();
    delete process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING;
    expect((await import('../../src/config.js')).config.openai.programmaticToolCalling).toBe(false);

    vi.resetModules();
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = ' TrUe ';
    expect((await import('../../src/config.js')).config.openai.programmaticToolCalling).toBe(true);

    vi.resetModules();
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'yes';
    await expect(import('../../src/config.js')).rejects.toThrow('OPENAI_PROGRAMMATIC_TOOL_CALLING');
  });
  it('pins requests to the official OpenAI endpoint even when a legacy override is present', async () => {
    setRequiredEnv();
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1';

    const { config } = await import('../../src/config.js');

    expect(config.openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('does not expose an EVE-KILL base override and keeps the client pinned to the current API', async () => {
    setRequiredEnv();
    process.env.EVE_KILL_BASE_URL = 'https://untrusted.invalid/';

    const { config } = await import('../../src/config.js');
    const { EVE_KILL_API_BASE_URL, getEveKillConfig } = await import('../../src/eve-kill/client.js');

    expect(config.eveKill).not.toHaveProperty('baseUrl');
    expect(config.eveKill).not.toHaveProperty('cacheTtlSeconds');
    expect(EVE_KILL_API_BASE_URL).toBe('https://api.eve-kill.com/');
    expect(getEveKillConfig().baseUrl).toBe(EVE_KILL_API_BASE_URL);
    expect('zkill' in config).toBe(false);
  });

  it('hard-bounds positive EVE-KILL timeout, retry, and backoff controls', async () => {
    setRequiredEnv();
    process.env.EVE_KILL_TIMEOUT_MS = '999999999';
    process.env.EVE_KILL_RETRY_MAX_ATTEMPTS = '999999999';
    process.env.EVE_KILL_BACKOFF_MAX_MS = '999999999';

    const { config } = await import('../../src/config.js');

    expect(config.eveKill).toMatchObject({
      timeoutMs: 60_000,
      retryMaxAttempts: 5,
      backoffMaxMs: 60_000,
    });
  });

  it('rejects non-positive EVE-KILL retry controls at startup', async () => {
    for (const name of [
      'EVE_KILL_TIMEOUT_MS',
      'EVE_KILL_RETRY_MAX_ATTEMPTS',
      'EVE_KILL_BACKOFF_MAX_MS',
    ]) {
      setRequiredEnv();
      process.env[name] = '0';
      await expect(import('../../src/config.js')).rejects.toThrow(name);
      delete process.env[name];
      vi.resetModules();
    }
  });

  it('rejects unsupported server-side Responses state', async () => {
    setRequiredEnv();
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'OPENAI_RESPONSE_STATE_MODE=server is unsupported',
    );
  });
});
