import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requiredInt(name: string): number {
  const raw = required(name);
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error(`Env var ${name} must be a number, got: "${raw}"`);
  return num;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return (value !== undefined && value !== '') ? value : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error(`Env var ${name} must be a number, got: "${raw}"`);
  return num;
}

function optionalFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num)) throw new Error(`Env var ${name} must be a number, got: "${raw}"`);
  return num;
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    allowedUserId: optionalInt('ALLOWED_TELEGRAM_USER_ID', 0),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.4'),
    baseUrl: optional('OPENAI_BASE_URL', ''),
    apiMode: optional('OPENAI_API_MODE', 'native_responses'),
    reasoningEffort: optional('OPENAI_REASONING_EFFORT', 'medium'),
  },
  eve: {
    clientId: required('EVE_CLIENT_ID'),
    clientSecret: required('EVE_CLIENT_SECRET'),
    callbackUrl: optional('EVE_CALLBACK_URL', 'http://localhost:3000/auth/eve/callback'),
  },
  esi: {
    baseUrl: optional('ESI_BASE_URL', 'https://esi.evetech.net/latest/'),
    specUrl: optional('ESI_SPEC_URL', 'https://esi.evetech.net/latest/swagger.json'),
    catalogCachePath: optional('ESI_CATALOG_CACHE_PATH', './data/cache/esi-swagger.json'),
    compatibilityDate: optional('ESI_COMPATIBILITY_DATE', '2026-03-15'),
    maxPages: optionalInt('ESI_MAX_PAGES', 5),
    backoffMaxSeconds: optionalInt('ESI_BACKOFF_MAX_SECONDS', 10),
  },
  server: {
    port: optionalInt('PORT', 3000),
    host: optional('HOST', '0.0.0.0'),
  },
  security: {
    allowWebAuth: optional('ALLOW_WEB_AUTH', 'false') === 'true',
  },
  db: {
    path: optional('DB_PATH', './data/eve-agent.db'),
  },
  sde: {
    dataDir: optional('SDE_DATA_DIR', './data/sde'),
  },
  userProfile: {
    path: optional('USER_PROFILE_PATH', './data/USER.md'),
    refreshSeconds: optionalInt('USER_PROFILE_REFRESH_SECONDS', 300),
  },
  market: {
    defaultRegionId: requiredInt('DEFAULT_MARKET_REGION_ID'),
    defaultRegionName: required('DEFAULT_MARKET_REGION_NAME'),
  },
  webSearch: {
    timeoutMs: optionalInt('WEB_SEARCH_TIMEOUT_MS', 8000),
    maxResults: optionalInt('WEB_SEARCH_MAX_RESULTS', 5),
  },
  zkill: {
    baseUrl: optional('ZKILL_BASE_URL', 'https://zkillboard.com/api/'),
    timeoutMs: optionalInt('ZKILL_TIMEOUT_MS', 8000),
    cacheTtlSeconds: optionalInt('ZKILL_CACHE_TTL_SECONDS', 300),
    maxPastSeconds: optionalInt('ZKILL_MAX_PAST_SECONDS', 604800),
    userAgent: optional('ZKILL_USER_AGENT', 'eve-agent/0.1.0 (contact: local-dev)'),
  },
  compact: {
    messageThreshold: optionalInt('COMPACT_MESSAGE_THRESHOLD', 50),
    tokenRatio: optionalFloat('COMPACT_TOKEN_RATIO', 0.6),
    tokenBudget: optionalInt('COMPACT_TOKEN_BUDGET', 8000),
    keepLast: optionalInt('COMPACT_KEEP_LAST', 10),
    maxInputChars: optionalInt('COMPACT_MAX_INPUT_CHARS', 20000),
  },
} as const;
