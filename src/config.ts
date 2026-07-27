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
const readSubagentsEnabled = optionalBoolean(
  'CHEAPVIBE_READ_SUBAGENTS_ENABLED',
  openAiProvider.id === 'modelhub',
);
if (openAiProvider.id === 'modelhub' && responseStateMode === 'server') {
  throw new Error('ModelHub does not support server-side response state; set OPENAI_RESPONSE_STATE_MODE=stateless');
}
if (process.env.WEB_TRUST_PROXY?.trim().toLowerCase() === 'true') {
  throw new Error('WEB_TRUST_PROXY=true is unsafe; configure explicit WEB_TRUSTED_PROXY_CIDRS instead');
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
    // Drop queued Telegram updates on boot. Default false: messages sent while
    // the bot was down (deploy/restart) are redelivered instead of silently lost.
    dropPendingUpdates: optionalBoolean('TELEGRAM_DROP_PENDING_UPDATES', false),
    // Redelivered updates older than this are skipped, so a long outage does not
    // replay a day-old backlog or a stale destructive command (/clear). Clamped
    // at 0 (the documented "disabled"): a negative value would read as disabled
    // too, which is the opposite of what lowering the number intends.
    maxUpdateAgeMinutes: Math.max(0, optionalInt('TELEGRAM_MAX_UPDATE_AGE_MINUTES', 15)),
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
    // Optional per-iteration effort tiers for the native tool loop. 'auto'
    // inherits the base OPENAI_REASONING_EFFORT resolution, so unset tiers
    // change nothing. INTERMEDIATE covers iterations that continue an
    // in-flight tool chain; FINAL covers the first request and continuations
    // after plain assistant text.
    reasoningEffortIntermediate: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_EFFORT_INTERMEDIATE', REASONING_EFFORTS, 'auto'),
    reasoningEffortFinal: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_EFFORT_FINAL', REASONING_EFFORTS, 'auto'),
    reasoningMode: parseOptionalEnumEnv(process.env, 'OPENAI_REASONING_MODE', REASONING_MODES, 'standard'),
    textVerbosity: parseOptionalEnumEnv(process.env, 'OPENAI_TEXT_VERBOSITY', TEXT_VERBOSITIES, 'low'),
    // Provider latency up to ~53s per call was observed in production; 90s was
    // cutting heavy turns mid-flight. The ceiling stays finite so a hung
    // request still fails instead of pinning an admission slot forever.
    responsesTimeoutMs: boundedPositiveInt('OPENAI_RESPONSES_TIMEOUT_MS', 300_000, 10_000, 900_000),
    // Generous but finite: a zero deadline would leave a wedged turn holding an
    // admission slot and its request record in `running` until systemd kills
    // the process on restart.
    turnDeadlineMs: boundedPositiveInt('AGENT_TURN_DEADLINE_MS', 600_000, 30_000, 3_600_000),
    maxConcurrentResponses: boundedPositiveInt('OPENAI_MAX_CONCURRENT_RESPONSES', 8, 1, 64),
    maxQueuedResponses: Math.max(0, Math.min(256, optionalInt('OPENAI_MAX_QUEUED_RESPONSES', 32))),
    responseQueueTimeoutMs: boundedPositiveInt('OPENAI_RESPONSE_QUEUE_TIMEOUT_MS', 15_000, 100, 120_000),
    maxConcurrentReadTools: boundedPositiveInt('AGENT_MAX_CONCURRENT_READ_TOOLS', 16, 4, 128),
    maxConcurrentEsiLeaves: boundedPositiveInt('AGENT_MAX_CONCURRENT_ESI_LEAVES', 12, 1, 64),
    maxQueuedTools: Math.max(0, Math.min(512, optionalInt('AGENT_MAX_QUEUED_TOOLS', 64))),
    toolQueueTimeoutMs: boundedPositiveInt('AGENT_TOOL_QUEUE_TIMEOUT_MS', 15_000, 100, 120_000),
    // Per-tool output budget in chars. Sized against the model context window
    // (default 200k tokens): 120k chars ≈ 30k tokens, so several full outputs
    // fit in one turn without tripping provider context errors. Finite on
    // purpose — an unbounded output would blow the context window and turn a
    // "full answer" into a provider error.
    maxToolOutputChars: boundedPositiveInt('AGENT_MAX_TOOL_OUTPUT_CHARS', 120_000, 1_000, 1_000_000),
    // Arrays below this row count are passed to the model verbatim (within the
    // char budget); aggregation kicks in only for genuinely large result sets.
    smartAggregateThreshold: boundedPositiveInt('AGENT_SMART_AGGREGATE_THRESHOLD', 200, 10, 100_000),
    // Stateless context window loaded from SQLite per turn.
    maxContextMessages: boundedPositiveInt('AGENT_MAX_CONTEXT_MESSAGES', 40, 4, 200),
    maxContextChars: boundedPositiveInt('AGENT_MAX_CONTEXT_CHARS', 100_000, 4_000, 800_000),
    maxProgrammaticToolOutputChars: boundedPositiveInt('AGENT_MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS', 120_000, 1_000, 1_000_000),
    // Tool-loop iteration ceiling. Loop protection, not a quality cap: high
    // enough that legitimate multi-step turns finish, finite so a stuck loop
    // still terminates (the turn deadline also bounds it in time).
    maxToolIterations: boundedPositiveInt('AGENT_MAX_TOOL_ITERATIONS', 80, 4, 400),
    // Anti-loop guard: identical tool called this many times in a row triggers
    // a nudge, not a hard stop. Kept low on purpose.
    maxConsecutiveSameTool: boundedPositiveInt('AGENT_MAX_CONSECUTIVE_SAME_TOOL', 5, 2, 20),
    maxClientSearchCallsPerResponse: boundedPositiveInt('AGENT_MAX_CLIENT_SEARCH_CALLS_PER_RESPONSE', 8, 1, 32),
    maxEveKillCallsPerTurn: boundedPositiveInt('AGENT_MAX_EVE_KILL_CALLS_PER_TURN', 60, 1, 500),
    maxEveKillAnalyticsCallsPerTurn: boundedPositiveInt('AGENT_MAX_EVE_KILL_ANALYTICS_CALLS_PER_TURN', 12, 1, 100),
    // Retries of the identical request after transient provider/transport
    // failures. Bounded by the turn deadline in wall-clock terms.
    maxTransientRetries: boundedPositiveInt('AGENT_MAX_TRANSIENT_RETRIES', 5, 1, 10),
    // Shared read-leaf ceiling across the root turn and delegated subagents.
    maxTotalTurnReadLeaves: boundedPositiveInt('AGENT_MAX_TOTAL_TURN_READ_LEAVES', 96, 4, 512),
    responseLanguage: optional('OPENAI_RESPONSE_LANGUAGE', 'Russian'),
    storeResponses,
    programmaticToolCalling: optionalBoolean('OPENAI_PROGRAMMATIC_TOOL_CALLING', false),
    readSubagentsEnabled,
    readSubagentConcurrency: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_CONCURRENCY', 4, 1, 12),
    readSubagentMaxTasks: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_MAX_TASKS', 8, 2, 16),
    readSubagentMaxWorkers: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_MAX_WORKERS', 6, 1, 12),
    readSubagentMaxWorkerIterations: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_MAX_WORKER_ITERATIONS', 8, 1, 16),
    readSubagentMaxModelCalls: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_MAX_MODEL_CALLS', 24, 2, 128),
    readSubagentAggregateChars: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_AGGREGATE_CHARS', 60_000, 2_000, 500_000),
    // Wall-clock cap for one delegated read batch. Always additionally bounded
    // by the remaining turn deadline at dispatch time.
    readSubagentBatchDeadlineMs: boundedPositiveInt('CHEAPVIBE_READ_SUBAGENT_BATCH_DEADLINE_MS', 600_000, 30_000, 3_600_000),
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
    userAgent: optional('ESI_USER_AGENT', 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)'),
    maxPages: Math.max(1, optionalInt('ESI_MAX_PAGES', 5)),
    assetsMaxPages: Math.max(1, optionalInt('ESI_ASSETS_MAX_PAGES', 25)),
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
    trustedProxyCidrs: optional('WEB_TRUSTED_PROXY_CIDRS', '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
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
    maxConcurrentAgentRequests: boundedPositiveInt('WEB_MAX_CONCURRENT_AGENT_REQUESTS', 8, 1, 32),
    maxQueuedAgentRequests: boundedPositiveInt('WEB_MAX_QUEUED_AGENT_REQUESTS', 64, 1, 1000),
    maxQueuedAgentRequestsPerUser: boundedPositiveInt('WEB_MAX_QUEUED_AGENT_REQUESTS_PER_USER', 1, 1, 10),
    requestWindowSeconds: boundedPositiveInt('WEB_REQUEST_WINDOW_SECONDS', 60, 10, 3600),
    maxRequestsPerUserWindow: boundedPositiveInt('WEB_MAX_REQUESTS_PER_USER_WINDOW', 6, 1, 1000),
    maxRequestsGlobalWindow: boundedPositiveInt('WEB_MAX_REQUESTS_GLOBAL_WINDOW', 120, 1, 10000),
    maxRequestsGlobalDay: boundedPositiveInt('WEB_MAX_REQUESTS_GLOBAL_DAY', 10_000, 1, 1_000_000),
    maxCostUnitsPerUserWindow: boundedPositiveInt('WEB_MAX_COST_UNITS_PER_USER_WINDOW', 24, 1, 100_000),
    maxCostUnitsGlobalWindow: boundedPositiveInt('WEB_MAX_COST_UNITS_GLOBAL_WINDOW', 480, 1, 1_000_000),
    maxCostUnitsGlobalDay: boundedPositiveInt('WEB_MAX_COST_UNITS_GLOBAL_DAY', 40_000, 1, 10_000_000),
    agentDeadlineMs: boundedPositiveInt('WEB_AGENT_DEADLINE_MS', 600_000, 30_000, 3_600_000),
    requestRetentionDays: boundedPositiveInt('WEB_REQUEST_RETENTION_DAYS', 7, 1, 90),
    turnstileSiteKey: optional('TURNSTILE_SITE_KEY', ''),
    turnstileSecretKey: optional('TURNSTILE_SECRET_KEY', ''),
    turnstileHostname: optional('TURNSTILE_EXPECTED_HOSTNAME', ''),
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
    userAgent: optional('EVE_KILL_USER_AGENT', 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)'),
    retryMaxAttempts: boundedPositiveInt('EVE_KILL_RETRY_MAX_ATTEMPTS', 3, 1, 5),
    backoffMaxMs: boundedPositiveInt('EVE_KILL_BACKOFF_MAX_MS', 10000, 100, 60_000),
  },
  eveScout: {
    baseUrl: optional('EVE_SCOUT_BASE_URL', 'https://api.eve-scout.com/v2/public/'),
    timeoutMs: optionalInt('EVE_SCOUT_TIMEOUT_MS', 8000),
    cacheTtlSeconds: optionalInt('EVE_SCOUT_CACHE_TTL_SECONDS', 300),
    userAgent: optional('EVE_SCOUT_USER_AGENT', 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)'),
    retryMaxAttempts: optionalInt('EVE_SCOUT_RETRY_MAX_ATTEMPTS', 2),
    backoffMaxMs: optionalInt('EVE_SCOUT_BACKOFF_MAX_MS', 5000),
  },
  compact: {
    maxInputChars: optionalInt('COMPACT_MAX_INPUT_CHARS', 20000),
  },
  shutdown: {
    // How long a stop waits for in-flight turns to finish before exiting.
    // These three numbers must move together (see deploy/systemd/eveai.service):
    //   AGENT_TURN_DEADLINE_MS (default 600s, ceiling 3600s) bounds one turn;
    //   SHUTDOWN_DRAIN_MS bounds the stop wait for in-flight turns;
    //   the supervisor's stop timeout (TimeoutStopSec) must stay above drain.
    // The default matches the default turn deadline so a default-length turn
    // always fits in the drain; it costs nothing on an idle stop because the
    // drain exits as soon as nothing is in flight. The ceiling matches the
    // turn-deadline ceiling so a raised deadline can still be drained — raise
    // drain and TimeoutStopSec together with it. 0 exits immediately.
    drainMs: Math.max(0, Math.min(3_600_000, optionalInt('SHUTDOWN_DRAIN_MS', 600_000))),
    drainPollMs: boundedPositiveInt('SHUTDOWN_DRAIN_POLL_MS', 250, 10, 5_000),
  },
} as const;
