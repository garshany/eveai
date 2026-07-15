import 'dotenv/config';
import {
  parseOptionalEnumEnv,
  parseOptionalIntEnv,
  parseOptionalPositiveIntEnv,
  parseOptionalStrictBooleanEnv,
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
import { resolveOpenAiProvider } from './openai-provider.js';

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

function parseResponseStateMode(storeResponses: boolean): ResponseStateMode {
  const value = parseOptionalEnumEnv(process.env, 'OPENAI_RESPONSE_STATE_MODE', RESPONSE_STATE_MODES, 'stateless');
  if (value === 'server' && !storeResponses) {
    throw new Error('OPENAI_RESPONSE_STATE_MODE=server requires OPENAI_STORE_RESPONSES=true');
  }
  return value;
}

const storeResponses = parseOptionalStrictBooleanEnv(process.env, 'OPENAI_STORE_RESPONSES', false);
const openAiProvider = resolveOpenAiProvider();
const responseStateMode = parseResponseStateMode(storeResponses);
if (openAiProvider.responsesTransport === 'websocket' && responseStateMode === 'server') {
  throw new Error('CheapVibeCode WebSocket transport requires OPENAI_RESPONSE_STATE_MODE=stateless');
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
    maxActiveRequestsGlobal: optionalInt('TELEGRAM_MAX_ACTIVE_REQUESTS_GLOBAL', 8),
  },
  discord: {
    botToken: optional('DISCORD_BOT_TOKEN', ''),
    // Discord user id (snowflake) allowlist. Empty = allow any user in DMs.
    allowedUserId: optional('ALLOWED_DISCORD_USER_ID', ''),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.6-sol'),
    providerId: openAiProvider.id,
    providerName: openAiProvider.name,
    // Provider IDs map to fixed transports and endpoints. There is deliberately no
    // arbitrary base-URL escape hatch for credentials and private chat data.
    baseUrl: openAiProvider.baseUrl,
    responsesTransport: openAiProvider.responsesTransport,
    toolSearchExecution: openAiProvider.toolSearchExecution,
    supportsHostedProgrammaticToolCalling: openAiProvider.supportsHostedProgrammaticToolCalling,
    supportsLocalParallelBatch: openAiProvider.supportsLocalParallelBatch,
    supportsTruncation: openAiProvider.supportsTruncation,
    supportsEncryptedReasoningReplay: openAiProvider.supportsEncryptedReasoningReplay,
    responseStateMode,
    reasoningEffort: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_EFFORT', REASONING_EFFORTS, 'auto'),
    reasoningMode: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_MODE', REASONING_MODES, 'standard'),
    textVerbosity: parseOptionalEnumEnv(process.env, 'OPENAI_TEXT_VERBOSITY', TEXT_VERBOSITIES, 'low'),
    responsesTimeoutMs: optionalPositiveInt('OPENAI_RESPONSES_TIMEOUT_MS', 90_000),
    maxConcurrentResponses: boundedPositiveInt('OPENAI_MAX_CONCURRENT_RESPONSES', 8, 1, 64),
    maxQueuedResponses: Math.max(0, Math.min(256, optionalInt('OPENAI_MAX_QUEUED_RESPONSES', 32))),
    responseQueueTimeoutMs: boundedPositiveInt('OPENAI_RESPONSE_QUEUE_TIMEOUT_MS', 15_000, 100, 120_000),
    maxConcurrentReadTools: boundedPositiveInt('AGENT_MAX_CONCURRENT_READ_TOOLS', 16, 4, 128),
    maxQueuedTools: Math.max(0, Math.min(512, optionalInt('AGENT_MAX_QUEUED_TOOLS', 64))),
    toolQueueTimeoutMs: boundedPositiveInt('AGENT_TOOL_QUEUE_TIMEOUT_MS', 15_000, 100, 120_000),
    responseLanguage: optional('OPENAI_RESPONSE_LANGUAGE', 'Russian'),
    storeResponses,
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
    chatEnabled: optionalBoolean('WEB_CHAT_ENABLED', false),
    trustProxy: optionalBoolean('WEB_TRUST_PROXY', false),
    sessionTtlHours: boundedPositiveInt('WEB_SESSION_TTL_HOURS', 720, 1, 8760),
    sessionCreationWindowSeconds: boundedPositiveInt(
      'WEB_SESSION_CREATION_WINDOW_SECONDS',
      600,
      60,
      86400,
    ),
    maxSessionCreationsPerWindow: boundedPositiveInt(
      'WEB_MAX_SESSION_CREATIONS_PER_WINDOW',
      30,
      1,
      1000,
    ),
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
