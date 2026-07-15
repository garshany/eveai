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
  it('defaults stored response logs off and parses the opt-in strictly', async () => {
    setRequiredEnv();
    process.env.DOTENV_CONFIG_PATH = '/private/tmp/eveai-test-no-dotenv-file';
    delete process.env.OPENAI_STORE_RESPONSES;
    expect((await import('../../src/config.js')).config.openai.storeResponses).toBe(false);

    vi.resetModules();
    process.env.OPENAI_STORE_RESPONSES = ' TrUe ';
    expect((await import('../../src/config.js')).config.openai.storeResponses).toBe(true);

    vi.resetModules();
    process.env.OPENAI_STORE_RESPONSES = 'yes';
    await expect(import('../../src/config.js')).rejects.toThrow('OPENAI_STORE_RESPONSES');
  });

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
  it('defaults to OpenAI and ignores a legacy arbitrary base URL override', async () => {
    setRequiredEnv();
    delete process.env.OPENAI_PROVIDER;
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1';

    const { config } = await import('../../src/config.js');

    expect(config.openai.providerId).toBe('openai');
    expect(config.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.openai.supportsTruncation).toBe(true);
    expect(config.openai.supportsEncryptedReasoningReplay).toBe(true);
  });

  it('selects the fixed CheapVibeCode Responses endpoint by provider ID', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = ' cheapvibecode ';
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1';

    const { config } = await import('../../src/config.js');

    expect(config.openai.providerId).toBe('cheapvibecode');
    expect(config.openai.providerName).toBe('CheapVibeCode');
    expect(config.openai.baseUrl).toBe('https://cheapvibecode.ru/backend-api/codex');
    expect(config.openai.responsesTransport).toBe('websocket');
    expect(config.openai.toolSearchExecution).toBe('client');
    expect(config.openai.supportsHostedProgrammaticToolCalling).toBe(false);
    expect(config.openai.supportsLocalParallelBatch).toBe(true);
    expect(config.openai.supportsTruncation).toBe(false);
    expect(config.openai.supportsEncryptedReasoningReplay).toBe(false);
  });

  it('rejects unknown provider IDs instead of accepting arbitrary endpoints', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = 'custom-gateway';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'OPENAI_PROVIDER must be one of: openai, cheapvibecode',
    );
  });

  it('rejects server response state for one-shot CheapVibeCode WebSockets', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = 'cheapvibecode';
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';
    process.env.OPENAI_STORE_RESPONSES = 'true';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'CheapVibeCode WebSocket transport requires OPENAI_RESPONSE_STATE_MODE=stateless',
    );
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

  it('requires stored responses for server-side Responses state', async () => {
    setRequiredEnv();
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';
    process.env.OPENAI_STORE_RESPONSES = 'false';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'OPENAI_RESPONSE_STATE_MODE=server requires OPENAI_STORE_RESPONSES=true',
    );

    vi.resetModules();
    process.env.OPENAI_STORE_RESPONSES = 'true';
    const { config } = await import('../../src/config.js');
    expect(config.openai.responseStateMode).toBe('server');
    expect(config.openai.storeResponses).toBe(true);
  });
});
