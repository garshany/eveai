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

export const config = {
  auth: {
    secretKey: optional('AUTH_SECRET_KEY', ''),
  },
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    botUsername: optional('TELEGRAM_BOT_USERNAME', ''),
    allowedUserId: optionalInt('ALLOWED_TELEGRAM_USER_ID', 0),
    requestWindowMs: optionalInt('TELEGRAM_REQUEST_WINDOW_MS', 60000),
    maxRequestsPerWindow: optionalInt('TELEGRAM_MAX_REQUESTS_PER_WINDOW', 6),
    maxActiveRequestsGlobal: optionalInt('TELEGRAM_MAX_ACTIVE_REQUESTS_GLOBAL', 24),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.4'),
    baseUrl: optional('OPENAI_BASE_URL', ''),
    apiMode: optional('OPENAI_API_MODE', 'native_responses'),
    reasoningEffort: optional('OPENAI_REASONING_EFFORT', 'medium'),
    maxOutputTokens: optionalInt('OPENAI_MAX_OUTPUT_TOKENS', 0),
    store: optional('OPENAI_STORE', 'true') === 'true',
    compactThreshold: optionalInt('OPENAI_COMPACT_THRESHOLD', 0),
    modelContextWindow: optionalInt('OPENAI_MODEL_CONTEXT_WINDOW', 200_000),
  },
  eve: {
    clientId: required('EVE_CLIENT_ID'),
    clientSecret: required('EVE_CLIENT_SECRET'),
    callbackUrl: optional('EVE_CALLBACK_URL', 'http://localhost:3000/auth/eve/callback'),
    requestTimeoutMs: optionalInt('SSO_REQUEST_TIMEOUT_MS', 8000),
  },
  esi: {
    baseUrl: optional('ESI_BASE_URL', 'https://esi.evetech.net/latest/'),
    specUrl: optional('ESI_SPEC_URL', 'https://esi.evetech.net/latest/swagger.json'),
    catalogCachePath: optional('ESI_CATALOG_CACHE_PATH', './data/cache/esi-swagger.json'),
    compatibilityDate: optional('ESI_COMPATIBILITY_DATE', '2026-03-15'),
    userAgent: optional('ESI_USER_AGENT', 'EVEAIBOT/1.0 (garshany80@gmail.com; +https://eveonline-ai.ru/; +https://github.com/garshany/eveai)'),
    maxPages: optionalInt('ESI_MAX_PAGES', 5),
    backoffMaxSeconds: optionalInt('ESI_BACKOFF_MAX_SECONDS', 10),
    requestTimeoutMs: optionalInt('ESI_REQUEST_TIMEOUT_MS', 8000),
    retryMaxAttempts: optionalInt('ESI_RETRY_MAX_ATTEMPTS', 3),
  },
  server: {
    port: optionalInt('PORT', 3000),
    host: optional('HOST', '127.0.0.1'),
  },
  web: {
    baseUrl: optional('WEB_BASE_URL', 'http://localhost:3000'),
    sessionTtlHours: optionalInt('WEB_SESSION_TTL_HOURS', 720),
    handoffTtlSeconds: optionalInt('TG_HANDOFF_TTL_SECONDS', 300),
  },
  db: {
    path: optional('DB_PATH', './data/eve-agent.db'),
  },
  sde: {
    dataDir: optional('SDE_DATA_DIR', './data/sde'),
  },
  userProfile: {
    path: optional('USER_PROFILE_PATH', './data/USER_{chat_id}_{character_id}.md'),
    refreshSeconds: optionalInt('USER_PROFILE_REFRESH_SECONDS', 300),
  },
  market: {
    defaultRegionId: requiredInt('DEFAULT_MARKET_REGION_ID'),
    defaultRegionName: required('DEFAULT_MARKET_REGION_NAME'),
  },
  tavily: {
    apiKey: optional('TAVILY_API_KEY', ''),
  },
  zkill: {
    baseUrl: optional('ZKILL_BASE_URL', 'https://zkillboard.com/api/'),
    timeoutMs: optionalInt('ZKILL_TIMEOUT_MS', 8000),
    cacheTtlSeconds: optionalInt('ZKILL_CACHE_TTL_SECONDS', 300),
    maxPastSeconds: optionalInt('ZKILL_MAX_PAST_SECONDS', 604800),
    userAgent: optional('ZKILL_USER_AGENT', 'EVEAIBOT/1.0 (garshany80@gmail.com; +https://eveonline-ai.ru/; +https://github.com/garshany/eveai)'),
    retryMaxAttempts: optionalInt('ZKILL_RETRY_MAX_ATTEMPTS', 3),
    backoffMaxMs: optionalInt('ZKILL_BACKOFF_MAX_MS', 10000),
  },
  eveKill: {
    baseUrl: optional('EVE_KILL_BASE_URL', 'https://eve-kill.com/api/'),
    timeoutMs: optionalInt('EVE_KILL_TIMEOUT_MS', 8000),
    cacheTtlSeconds: optionalInt('EVE_KILL_CACHE_TTL_SECONDS', 300),
    maxQueryLimit: optionalInt('EVE_KILL_MAX_QUERY_LIMIT', 100),
    userAgent: optional('EVE_KILL_USER_AGENT', 'EVEAIBOT/1.0 (garshany80@gmail.com; +https://eveonline-ai.ru/; +https://github.com/garshany/eveai)'),
    retryMaxAttempts: optionalInt('EVE_KILL_RETRY_MAX_ATTEMPTS', 3),
    backoffMaxMs: optionalInt('EVE_KILL_BACKOFF_MAX_MS', 10000),
  },
  eveScout: {
    baseUrl: optional('EVE_SCOUT_BASE_URL', 'https://api.eve-scout.com/v2/public/'),
    timeoutMs: optionalInt('EVE_SCOUT_TIMEOUT_MS', 8000),
    cacheTtlSeconds: optionalInt('EVE_SCOUT_CACHE_TTL_SECONDS', 300),
    userAgent: optional('EVE_SCOUT_USER_AGENT', 'EVEAIBOT/1.0 (garshany80@gmail.com; +https://eveonline-ai.ru/; +https://github.com/garshany/eveai)'),
    retryMaxAttempts: optionalInt('EVE_SCOUT_RETRY_MAX_ATTEMPTS', 2),
    backoffMaxMs: optionalInt('EVE_SCOUT_BACKOFF_MAX_MS', 5000),
  },
  compact: {
    maxInputChars: optionalInt('COMPACT_MAX_INPUT_CHARS', 20000),
  },
} as const;
