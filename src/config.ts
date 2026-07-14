import 'dotenv/config';
import {
  parseOptionalEnumEnv,
  parseOptionalIntEnv,
  parseOptionalPositiveIntEnv,
  parseRequiredIntEnv,
  readOptionalEnv,
  readRequiredEnv,
} from './config-env.js';
import {
  REASONING_EFFORTS,
  REASONING_MODES,
  RESPONSE_STATE_MODES,
  type ResponseStateMode,
  TEXT_VERBOSITIES,
} from './openai-options.js';

// Strict parsing: malformed integers (e.g. "3000.5", "1e3", unsafe ints) fail
// fast at startup instead of being silently coerced. See src/config-env.ts.
function required(name: string): string {
  return readRequiredEnv(process.env, name);
}

function requiredInt(name: string): number {
  return parseRequiredIntEnv(process.env, name);
}

function optional(name: string, fallback: string): string {
  return readOptionalEnv(process.env, name, fallback);
}

function optionalInt(name: string, fallback: number): number {
  return parseOptionalIntEnv(process.env, name, fallback);
}

function optionalPositiveInt(name: string, fallback: number): number {
  return parseOptionalPositiveIntEnv(process.env, name, fallback);
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

function boundedPositiveInt(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, optionalPositiveInt(name, fallback)));
}

function parseResponseStateMode(): ResponseStateMode {
  const value = parseOptionalEnumEnv(process.env, 'OPENAI_RESPONSE_STATE_MODE', RESPONSE_STATE_MODES, 'stateless');
  if (value === 'server') {
    throw new Error('OPENAI_RESPONSE_STATE_MODE=server is unsupported: EVE AI Agent requires stateless Responses with store=false');
  }
  return value;
}

export const config = {
  auth: {
    secretKey: optional('AUTH_SECRET_KEY', ''),
  },
  telegram: {
    botToken: optional('TELEGRAM_BOT_TOKEN', ''),
    allowedUserId: optionalInt('ALLOWED_TELEGRAM_USER_ID', 0),
    requestWindowMs: optionalInt('TELEGRAM_REQUEST_WINDOW_MS', 60000),
    maxRequestsPerWindow: optionalInt('TELEGRAM_MAX_REQUESTS_PER_WINDOW', 6),
    maxActiveRequestsGlobal: optionalInt('TELEGRAM_MAX_ACTIVE_REQUESTS_GLOBAL', 24),
  },
  discord: {
    botToken: optional('DISCORD_BOT_TOKEN', ''),
    // Discord user id (snowflake) allowlist. Empty = allow any user in DMs.
    allowedUserId: optional('ALLOWED_DISCORD_USER_ID', ''),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.6-sol'),
    // The application deliberately uses the official OpenAI Responses API.
    // Keeping the endpoint fixed prevents a self-hosting typo from sending the
    // API key and chat data to an arbitrary OpenAI-compatible gateway.
    baseUrl: 'https://api.openai.com/v1',
    responseStateMode: parseResponseStateMode(),
    reasoningEffort: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_EFFORT', REASONING_EFFORTS, 'auto'),
    reasoningMode: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_MODE', REASONING_MODES, 'standard'),
    textVerbosity: parseOptionalEnumEnv(process.env, 'OPENAI_TEXT_VERBOSITY', TEXT_VERBOSITIES, 'low'),
    responsesTimeoutMs: optionalPositiveInt('OPENAI_RESPONSES_TIMEOUT_MS', 90_000),
    responseLanguage: optional('OPENAI_RESPONSE_LANGUAGE', 'Russian'),
    programmaticToolCalling: optionalBoolean('OPENAI_PROGRAMMATIC_TOOL_CALLING', false),
    maxOutputTokens: optionalInt('OPENAI_MAX_OUTPUT_TOKENS', 0),
    compactThreshold: optionalInt('OPENAI_COMPACT_THRESHOLD', 0),
    // Floor the window so a misconfigured 0/negative value can't make
    // autoCompactLimit 0 and trigger compaction on every single turn.
    modelContextWindow: Math.max(8_000, optionalInt('OPENAI_MODEL_CONTEXT_WINDOW', 200_000)),
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
    userAgent: optional('ESI_USER_AGENT', 'EVEAI/3.3 (+https://github.com/example/eveai; contact=operator@example.com)'),
    maxPages: Math.max(1, optionalInt('ESI_MAX_PAGES', 5)),
    backoffMaxSeconds: Math.max(1, optionalInt('ESI_BACKOFF_MAX_SECONDS', 10)),
    requestTimeoutMs: optionalInt('ESI_REQUEST_TIMEOUT_MS', 8000),
    retryMaxAttempts: Math.max(1, optionalInt('ESI_RETRY_MAX_ATTEMPTS', 3)),
  },
  server: {
    port: optionalInt('PORT', 3000),
    host: optional('HOST', '127.0.0.1'),
  },
  web: {
    baseUrl: optional('WEB_BASE_URL', 'http://localhost:3000'),
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
  eveKill: {
    timeoutMs: boundedPositiveInt('EVE_KILL_TIMEOUT_MS', 8000, 250, 60_000),
    userAgent: optional('EVE_KILL_USER_AGENT', 'EVEAI/3.3 (+https://github.com/example/eveai; contact=operator@example.com)'),
    retryMaxAttempts: boundedPositiveInt('EVE_KILL_RETRY_MAX_ATTEMPTS', 3, 1, 5),
    backoffMaxMs: boundedPositiveInt('EVE_KILL_BACKOFF_MAX_MS', 10000, 100, 60_000),
  },
  eveScout: {
    baseUrl: optional('EVE_SCOUT_BASE_URL', 'https://api.eve-scout.com/v2/public/'),
    timeoutMs: optionalInt('EVE_SCOUT_TIMEOUT_MS', 8000),
    cacheTtlSeconds: optionalInt('EVE_SCOUT_CACHE_TTL_SECONDS', 300),
    userAgent: optional('EVE_SCOUT_USER_AGENT', 'EVEAI/3.3 (+https://github.com/example/eveai; contact=operator@example.com)'),
    retryMaxAttempts: optionalInt('EVE_SCOUT_RETRY_MAX_ATTEMPTS', 2),
    backoffMaxMs: optionalInt('EVE_SCOUT_BACKOFF_MAX_MS', 5000),
  },
  compact: {
    maxInputChars: optionalInt('COMPACT_MAX_INPUT_CHARS', 20000),
  },
} as const;
