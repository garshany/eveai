import { afterEach, describe, expect, it, vi } from 'vitest';

// isEveSsoConfigured reads config.eve.clientId/clientSecret, which config.ts
// resolves from env at import time — so each case sets env then re-imports fresh.
async function isConfigured(clientId: string, clientSecret: string): Promise<boolean> {
  process.env.ALLOWED_TELEGRAM_USER_ID = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.DEFAULT_MARKET_REGION_ID = '10000002';
  process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
  process.env.EVE_CLIENT_ID = clientId;
  process.env.EVE_CLIENT_SECRET = clientSecret;
  vi.resetModules();
  const { isEveSsoConfigured } = await import('../../src/eve/eve-login.js');
  return isEveSsoConfigured();
}

afterEach(() => vi.resetModules());

describe('isEveSsoConfigured', () => {
  it('treats documented and obvious placeholders as unconfigured', async () => {
    expect(await isConfigured('placeholder', 'placeholder')).toBe(false);
    expect(await isConfigured('smoke', 'smoke')).toBe(false);
    // README "Required Environment" literal dots.
    expect(await isConfigured('...', '...')).toBe(false);
    // README "EVE SSO Setup" guide placeholders — including the mismatched key name.
    expect(await isConfigured('your_client_id', 'your_secret_key')).toBe(false);
    // A real-looking client id but a leftover guide secret must still be unconfigured.
    expect(await isConfigured('1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', 'your_secret_key')).toBe(false);
    // Note: truly empty creds can't reach here — config's required() rejects them
    // at startup — so this only needs to cover non-empty placeholder strings.
  });

  it('treats real-looking credentials as configured', async () => {
    expect(await isConfigured(
      '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      'AbC123dEf456GhI789jKl012MnO345pQr678',
    )).toBe(true);
  });
});
