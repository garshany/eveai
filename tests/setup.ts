import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Hermetic test environment: the suite must pass on a clean clone without a
// personal .env. Values are only used to satisfy src/config.ts import-time
// validation; tests never talk to real providers.
const TEST_ENV_DEFAULTS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'test-telegram-token',
  OPENAI_API_KEY: 'test-openai-key',
  EVE_CLIENT_ID: 'test-eve-client-id',
  EVE_CLIENT_SECRET: 'test-eve-client-secret',
  AUTH_SECRET_KEY: 'test-auth-secret-key-32-bytes-min!!',
  DEFAULT_MARKET_REGION_ID: '10000002',
  DEFAULT_MARKET_REGION_NAME: 'The Forge',
};

for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

// The ESI catalog loads its swagger spec from disk and tests stub fetch to
// stay offline. Seed the default cache path with the checked-in fixture so a
// clean clone has a catalog to load. An existing operator cache is preserved.
const cachePath = resolve(process.env.ESI_CATALOG_CACHE_PATH ?? './data/cache/esi-swagger.json');
if (!existsSync(cachePath)) {
  mkdirSync(dirname(cachePath), { recursive: true });
  copyFileSync(resolve('./tests/fixtures/esi-swagger.json'), cachePath);
}
