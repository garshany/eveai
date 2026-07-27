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
import { parseModelPricingJson } from './usage/pricing.js';

/**
 * Default token tariffs (USD per 1M tokens: input / output / cached /
 * reasoning), from the owner's ModelHub numbers of 2026-07-27. Reasoning
 * tokens bill at the plain output rate. MODEL_PRICING_JSON overrides this
 * table wholesale.
 */
const DEFAULT_MODEL_PRICING_JSON = JSON.stringify({
  'gpt-5.6-sol': { input: 0.06825, output: 0.34125, cached: 0.0126, reasoning: 0.34125 },
  'gpt-5.6-terra': { input: 0.0525, output: 0.2625, cached: 0.0126, reasoning: 0.2625 },
  'gpt-5.6-luna': { input: 0.042, output: 0.21, cached: 0.0126, reasoning: 0.21 },
});

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

/** Strict non-negative decimal ("19", "19.5") — rejects "1e3", "19,5", junk. */
function optionalUsdAmount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`${name} must be a plain non-negative decimal number, got: "${raw}"`);
  }
  return Number(trimmed);
}

const DEFAULT_BOOSTY_URL = 'https://boosty.to/artemy1337';

/**
 * BOOSTY_URL: unset → the confirmed production page; explicitly empty → null,
 * which hides the donate button so the page never shows a dead link. Only
 * https:// targets are accepted — this is the single place the domain lives.
 */
function parseBoostyUrl(): string | null {
  const raw = process.env.BOOSTY_URL;
  if (raw === undefined) return DEFAULT_BOOSTY_URL;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error(`BOOSTY_URL must be an https:// URL (or empty to hide donations), got: "${raw}"`);
  }
  return trimmed;
}

/**
 * USD is the accounting currency and the source of truth. RUB is display-only
 * and exists solely when the operator pins a rate: USD_RUB_RATE plus
 * USD_RUB_RATE_DATE so the page can say "at rate X as of date Y". The rate is
 * never fetched from anywhere.
 */
function parseFxConfig(): { usdRubRate: number | null; usdRubRateDate: string | null } {
  const rawRate = process.env.USD_RUB_RATE;
  if (rawRate === undefined || rawRate.trim() === '') {
    return { usdRubRate: null, usdRubRateDate: null };
  }
  const trimmed = rawRate.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`USD_RUB_RATE must be a positive decimal number, got: "${rawRate}"`);
  }
  const rawDate = process.env.USD_RUB_RATE_DATE;
  const date = rawDate?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('USD_RUB_RATE requires USD_RUB_RATE_DATE in YYYY-MM-DD format (the rate must be labeled with its date)');
  }
  return { usdRubRate: Number(trimmed), usdRubRateDate: date };
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
    // Interactive pagination budget. At 5 this was not a soft cap: anything
    // needing more pages (region orders without a type filter, a multi-year
    // wallet journal, public contracts) failed outright with 422 instead of
    // returning partial data. Oversized results are handled downstream by the
    // tool-output budget and its bounded sample, so pull first and shape later.
    maxPages: Math.max(1, optionalInt('ESI_MAX_PAGES', 50)),
    assetsMaxPages: Math.max(1, optionalInt('ESI_ASSETS_MAX_PAGES', 200)),
    // market_wide_summary sweep budgets, tuned for coverage over politeness.
    // The binding ceiling is not ours: ESI enforces an error limit and blocks
    // the caller for minutes once it trips, so unbounded fan-out buys bans,
    // not speed. 12 keeps a cold 68-region sweep at a few seconds while still
    // leaving room under the shared ESI-leaf admission controller.
    marketWideConcurrency: boundedPositiveInt('ESI_MARKET_WIDE_CONCURRENCY', 12, 1, 64),
    // There are 68 k-space trade regions in the current SDE, so this never
    // binds in practice; it exists only so a corrupt region list cannot spin
    // the sweep forever.
    marketWideMaxRegions: boundedPositiveInt('ESI_MARKET_WIDE_MAX_REGIONS', 500, 1, 2_000),
    // Per-region page budget for the per-type order book. Jita rarely exceeds a
    // couple of 1000-row pages for one type; generous so a busy type is swept
    // whole rather than reported as failed.
    marketWideMaxPages: boundedPositiveInt('ESI_MARKET_WIDE_MAX_PAGES', 50, 1, 500),
    backoffMaxSeconds: Math.max(1, optionalInt('ESI_BACKOFF_MAX_SECONDS', 10)),
    // 8s cut off slow ESI endpoints (deep pagination, cold cache) mid-answer.
    // Still bounded: the turn deadline is the real ceiling, and a hung request
    // must not sit on an ESI leaf slot forever.
    requestTimeoutMs: optionalInt('ESI_REQUEST_TIMEOUT_MS', 30_000),
    retryMaxAttempts: Math.max(1, optionalInt('ESI_RETRY_MAX_ATTEMPTS', 5)),
  },
  characterSync: {
    // Page ceiling for the character-datastore sync path only. Interactive ESI
    // tool calls keep the tighter esi.maxPages; a full private profile (assets,
    // wallet journal) legitimately spans far more pages.
    maxPages: boundedPositiveInt('CHARACTER_SYNC_MAX_PAGES', 50, 1, 200),
    // Freshness used when ESI omits an Expires header on a synced dataset.
    fallbackTtlSeconds: boundedPositiveInt('CHARACTER_SYNC_FALLBACK_TTL_SECONDS', 3600, 60, 86_400),
    // After a failed dataset refresh, wait this long before retrying so a
    // broken endpoint is not hammered on every character_sql call.
    errorRetrySeconds: boundedPositiveInt('CHARACTER_SYNC_ERROR_RETRY_SECONDS', 120, 10, 3600),
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
    // At 1 a second question was rejected while the first was still running,
    // which reads as the chat refusing to listen. Turns can take minutes, so
    // let a few queue up per user.
    maxQueuedAgentRequestsPerUser: boundedPositiveInt('WEB_MAX_QUEUED_AGENT_REQUESTS_PER_USER', 5, 1, 50),
    requestWindowSeconds: boundedPositiveInt('WEB_REQUEST_WINDOW_SECONDS', 60, 10, 3600),
    maxRequestsPerUserWindow: boundedPositiveInt('WEB_MAX_REQUESTS_PER_USER_WINDOW', 6, 1, 1000),
    maxRequestsGlobalWindow: boundedPositiveInt('WEB_MAX_REQUESTS_GLOBAL_WINDOW', 120, 1, 10000),
    maxRequestsGlobalDay: boundedPositiveInt('WEB_MAX_REQUESTS_GLOBAL_DAY', 10_000, 1, 1_000_000),
    maxCostUnitsPerUserWindow: boundedPositiveInt('WEB_MAX_COST_UNITS_PER_USER_WINDOW', 24, 1, 100_000),
    maxCostUnitsGlobalWindow: boundedPositiveInt('WEB_MAX_COST_UNITS_GLOBAL_WINDOW', 480, 1, 1_000_000),
    maxCostUnitsGlobalDay: boundedPositiveInt('WEB_MAX_COST_UNITS_GLOBAL_DAY', 40_000, 1, 10_000_000),
    agentDeadlineMs: boundedPositiveInt('WEB_AGENT_DEADLINE_MS', 600_000, 30_000, 3_600_000),
    // Overall deadline for the manual profile sync (POST /api/web/profile/
    // sync): without it a struggling ESI would hold the request for tens of
    // minutes (datasets x pages x retries). On expiry the route answers 503
    // with partial progress.
    profileSyncTimeoutMs: boundedPositiveInt('WEB_PROFILE_SYNC_TIMEOUT_MS', 75_000, 5_000, 600_000),
    requestRetentionDays: boundedPositiveInt('WEB_REQUEST_RETENTION_DAYS', 7, 1, 90),
    // АИ-подбор предметов (/api/web/market/ai-search): отдельный выключатель и
    // бюджеты, чтобы оператор мог удешевить или погасить фичу, не трогая чат.
    aiSearchEnabled: optionalBoolean('WEB_AI_SEARCH_ENABLED', true),
    aiSearchMaxModelCalls: boundedPositiveInt('WEB_AI_SEARCH_MAX_MODEL_CALLS', 2, 1, 5),
    aiSearchTimeoutMs: boundedPositiveInt('WEB_AI_SEARCH_TIMEOUT_MS', 30_000, 5_000, 120_000),
    aiSearchMaxResults: boundedPositiveInt('WEB_AI_SEARCH_MAX_RESULTS', 20, 1, 50),
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
  marketSnapshot: {
    // Local whole-market snapshot walked straight from public ESI: the worker
    // pages /markets/{region_id}/orders/ for every k-space trade region. No
    // third-party dump dependency.
    enabled: optionalBoolean('MARKET_SNAPSHOT_ENABLED', true),
    // Grace allowance past a region's OWN tier interval before its rows read
    // as stale (see getMarketSnapshotMeta): a healthy minor-tier book is
    // legitimately hours old, so a flat age threshold would mark it stale
    // most of the time. One missed sweep past the interval stays tolerable.
    staleMinutes: boundedPositiveInt('MARKET_SNAPSHOT_STALE_MINUTES', 75, 15, 1_440),
    // 2000 measured on the production VM: ~135 MB peak RSS — safe next to the
    // agent on a 2 GB box (20k rows/batch spiked to 306 MB).
    batchSize: boundedPositiveInt('MARKET_SNAPSHOT_BATCH_SIZE', 2_000, 100, 100_000),
    // Two-tier freshness, classified by page count (never by region name):
    // regions whose book spans at least this many 1000-order pages refetch on
    // the major interval, the long tail on the minor one. With the current
    // market, 100 pages catches exactly The Forge (409), Domain (184),
    // Sinq Laison (124) and Metropolis (120) — half of all orders.
    majorMinPages: boundedPositiveInt('MARKET_SNAPSHOT_MAJOR_MIN_PAGES', 100, 1, 10_000),
    // Never below ESI's own 5-minute order-book cache.
    majorIntervalMinutes: boundedPositiveInt('MARKET_SNAPSHOT_MAJOR_INTERVAL_MINUTES', 30, 5, 1_440),
    minorIntervalMinutes: boundedPositiveInt('MARKET_SNAPSHOT_MINOR_INTERVAL_MINUTES', 360, 5, 10_080),
    // Page fan-out inside ONE region's walk. A large book must finish far
    // inside ESI's 5-minute cache window or last-modified flips mid-walk:
    // 409 pages at 150-250 ms sequentially is 5+ minutes (the cold sweep
    // could never commit — measured in production 2026-07-27); a pool of 8
    // is ~10-15 s, a 20-30x margin. Not "the more the better": this walker
    // bypasses the agent's ESI-leaf admission controller, so the pool stays
    // small on purpose — interactive calls share the same IP rate/error
    // budget, and throttleIfNeeded still paces every response.
    pageConcurrency: boundedPositiveInt('MARKET_SNAPSHOT_PAGE_CONCURRENCY', 8, 1, 32),
  },
  marketHistory: {
    // Local per-type daily price history, refreshed from ESI
    // /markets/{region_id}/history/. CCP rebuilds that endpoint once a day at
    // 11:05 UTC, so the hourly tick mostly revalidates warm pairs.
    enabled: optionalBoolean('MARKET_HISTORY_ENABLED', true),
    // One tick's worth of due pairs. The due set after a quiet night is the
    // watchlist plus the seeded top types (a few hundred pairs), so 100
    // drains it in a handful of ticks without crowding the agent's ESI calls.
    maxPerTick: boundedPositiveInt('MARKET_HISTORY_MAX_PER_TICK', 100, 1, 500),
    // Each pair is a single unauthenticated ESI call; 4 in flight stays well
    // inside the public error-limit budget.
    concurrency: boundedPositiveInt('MARKET_HISTORY_CONCURRENCY', 4, 1, 16),
    // Watchlist pairs are always seeded; this additionally seeds the top-N
    // types by listed value (volume_remain * price) in major regions. 0
    // disables the top-types seed (clamped like maxUpdateAgeMinutes: a
    // negative reads as disabled, which lowering the number never intends).
    seedTopTypes: Math.min(1_000, Math.max(0, optionalInt('MARKET_HISTORY_SEED_TOP_TYPES', 200))),
  },
  marketAlerts: {
    // One-shot price alerts evaluated against the local market_orders snapshot
    // every 5 minutes. The tick is a single indexed read per active alert and
    // makes zero ESI calls, so there is no cost reason to default it off.
    enabled: optionalBoolean('MARKET_ALERTS_ENABLED', true),
    // Cap on simultaneously active alerts per user. Alerts are one-shot (a
    // firing flips status to 'triggered' forever), so the cap bounds the
    // per-tick scan size and the alerts panel, not any external quota. 200 is
    // the "something is wrong with the client" ceiling, not a target.
    maxActivePerUser: boundedPositiveInt('MARKET_ALERTS_MAX_ACTIVE_PER_USER', 50, 1, 200),
  },
  tavily: {
    apiKey: optional('TAVILY_API_KEY', ''),
  },
  // Community-run EVE APIs (EVE Ref, zKillboard, MutaMarket, Janice). One
  // shared retry/timeout budget: these are best-effort enrichments, so the
  // budget is deliberately smaller than ESI's.
  community: {
    everefBaseUrl: optional('EVEREF_BASE_URL', 'https://api.everef.net'),
    zkillBaseUrl: optional('ZKILL_BASE_URL', 'https://zkillboard.com'),
    mutamarketBaseUrl: optional('MUTAMARKET_BASE_URL', 'https://mutamarket.com'),
    janiceBaseUrl: optional('JANICE_BASE_URL', 'https://janice.e-351.com'),
    // Empty key disables the Janice second opinion; the local appraisal
    // still works without it.
    janiceApiKey: optional('JANICE_API_KEY', ''),
    timeoutMs: boundedPositiveInt('COMMUNITY_API_TIMEOUT_MS', 12_000, 250, 60_000),
    retryMaxAttempts: boundedPositiveInt('COMMUNITY_API_RETRY_MAX_ATTEMPTS', 3, 1, 5),
    backoffMaxMs: boundedPositiveInt('COMMUNITY_API_BACKOFF_MAX_MS', 8000, 100, 60_000),
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
  usage: {
    // Raw usage_events rows older than this are pruned after the daily rollup;
    // usage_daily aggregates are kept forever. The floor guarantees "today's
    // tail" plus one full rollup cycle always survive in the raw table.
    retentionDays: boundedPositiveInt('USAGE_EVENTS_RETENTION_DAYS', 30, 2, 365),
    // USD per 1M tokens keyed by model id. Unset/empty falls back to the
    // owner's current ModelHub tariffs (DEFAULT_MODEL_PRICING_JSON);
    // a non-empty MODEL_PRICING_JSON replaces the table wholesale.
    pricing: parseModelPricingJson(
      process.env.MODEL_PRICING_JSON?.trim() ? process.env.MODEL_PRICING_JSON : DEFAULT_MODEL_PRICING_JSON,
    ),
  },
  donations: {
    boostyUrl: parseBoostyUrl(),
  },
  fx: parseFxConfig(),
  gcpBilling: {
    // Cloud Billing API only serves the SKU price list; actual spend exists
    // solely in the BigQuery billing export. All four values are required for
    // the reader to run; all empty means "export not set up" (an explicit
    // state, never a silent fallback to made-up numbers).
    projectId: optional('GCP_BILLING_PROJECT_ID', ''),
    dataset: optional('GCP_BILLING_DATASET', ''),
    table: optional('GCP_BILLING_TABLE', ''),
    serviceAccountKeyPath: optional('GCP_BILLING_SERVICE_ACCOUNT_KEY_PATH', ''),
    // The export itself lags by hours, so polling faster than this buys
    // nothing. Refreshes run in the background, never in the HTTP handler.
    refreshTtlMs: boundedPositiveInt('GCP_BILLING_REFRESH_TTL_MS', 3_600_000, 60_000, 86_400_000),
    queryTimeoutMs: boundedPositiveInt('GCP_BILLING_QUERY_TIMEOUT_MS', 10_000, 1_000, 60_000),
  },
  infra: {
    // Static monthly figure shown strictly while no live billing export is
    // available. From the owner's measurements: ~$18-20/month total for the
    // e2-small VM, data disk, boot disk, and daily snapshots.
    estimateMonthlyUsd: optionalUsdAmount('INFRA_ESTIMATE_USD_MONTHLY', 19),
  },
  transparency: {
    // Public cache lifetime for GET /api/web/transparency. 0 restores no-store.
    publicCacheSeconds: Math.max(0, Math.min(3600, optionalInt('TRANSPARENCY_PUBLIC_CACHE_SECONDS', 60))),
  },
} as const;
