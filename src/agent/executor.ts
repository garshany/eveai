import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import type { ApiReasoningEffort, ReasoningEffort } from '../openai-options.js';
import { buildDeveloperPrompt } from './prompts.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import {
  buildNativeAgentTools,
  executeUniverseObjectCount,
  executeSdeSql,
  planRoute,
  getToolPolicy,
  isSdeSqlTool,
  isUniverseCountTool,
  isEveKillToolName,
  isEveKillAnalyticsToolName,
  isBatchMarketTool,
  isHeartbeatConfigTool,
  isOsintInferTool,
  isAnalyzeLocalTool,
  isAnalyzeScanTool,
  isIntelNoteTool,
  isSetActiveFitTool,
  isRouteMonitorTool,
  isEveScoutToolName,
  isProgrammaticToolAllowed,
  isLocalParallelBatchTool,
} from './tools.js';
import type { PlanRouteArgs } from './tools.js';
import { updatePlan } from './planner.js';
import { BULK_FILTER_OPERATIONS } from '../eve/esi-catalog.js';
import { getActiveMonitor, stopRouteMonitor } from '../eve-board/monitor.js';
import {
  buildFunctionCallOutputs,
  buildOrderedContinuationInputItems,
  createNativeResponse,
  extractFunctionCalls,
  extractClientToolSearchCalls,
  extractFinalAssistantText,
  toNativeMessage,
  toNativeAssistantMessage,
  type NativeInputItem,
  type NativeFunctionCaller,
} from './native-responses.js';
import {
  prepareClientToolSearch,
  searchClientTools,
  type ClientToolSearchIndex,
} from './client-tool-search.js';
import { callEsiOperation } from '../eve/esi-client.js';
import {
  executeMarketHistorySummary,
  isMarketHistorySummaryTool,
  validateMarketHistorySummaryArgs,
} from '../eve/market-history-summary.js';
import {
  executeSystemMetricSnapshot,
  isSystemMetricSnapshotTool,
  validateSystemMetricSnapshotArgs,
} from '../eve/system-metric-snapshot.js';
import {
  executeDynamicItemSummary,
  isDynamicItemSummaryTool,
  validateDynamicItemSummaryArgs,
} from '../eve/dynamic-item-summary.js';
import { isTurnAborted, reportActivity, summarizeToolArgs, TURN_ABORTED_MESSAGE } from './activity.js';
import { ESI_FIELD_WHITELIST, filterEsiFields, validateEsiFields } from './esi-field-filter.js';
import { readUserProfile, refreshUserProfile } from '../eve/user-profile.js';
import { createRequestId } from './planner.js';
import { getThreadSummary, runPreTurnCompact, needsMidTurnCompaction, runMidTurnCompact } from './compact.js';
import { executeEveKillTool } from '../eve-kill/executor.js';
import { validateKillActivitySummaryArgs } from '../eve-kill/activity-summary.js';
import {
  executeEveScoutTool,
  validateCompareWormholeTypesArgs,
  validateScoutSystemsArgs,
} from '../eve/eve-scout-executor.js';
import type { EveScoutToolName } from '../eve/eve-scout-tools.js';
import type { EveKillToolName } from '../eve-kill/tools.js';
import { executeEveKillAnalyticsTool } from '../eve-kill/mcp-analytics.js';
import type { EveKillAnalyticsToolName } from '../eve-kill/analytics-tools.js';
import {
  executeDoctrineSummary,
  isDoctrineSummaryTool,
  validateDoctrineSummaryArgs,
} from '../eve-kill/doctrine-summary.js';
import { executeHeartbeatConfig } from '../scheduled/heartbeat-config.js';
import type { HeartbeatConfigArgs } from '../scheduled/heartbeat-config.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { UserContext } from '../auth/user-resolver.js';
import { executeOsintInferHome } from '../eve-osint/inference.js';
import { executeAnalyzeLocal } from '../eve-local/analyzer.js';
import { executeAnalyzeScan } from '../eve-scan/analyzer.js';
import { executeIntelNote } from '../eve-intel/notes.js';
import { assessShip } from '../eve-board/threat.js';
import { resolveActiveFitting, writeManualFitting } from '../eve/active-fitting.js';
import { createWebSearchState, executeWebSearch, registerWebSearch } from './web-search.js';
import type { WebSearchState } from './web-search.js';
import {
  deriveLiveContextNeeds,
  detectStaticAggregateObjectKind,
  formatCountNoun,
  isSimpleStaticAggregateCountGoal,
  parseStaticAggregateIntent,
  tryBuildDeterministicCountAnswer,
  tryHandleStaticAggregateFastPath,
} from './static-aggregate.js';
import { buildSafetyIdentifier } from './safety-identifier.js';
import {
  isProgrammaticToolName,
  serializeProgrammaticToolOutput,
  validateProgrammaticToolOutput,
} from './programmatic-contracts.js';
import { ResponseAdmissionController } from './response-admission.js';

const MAX_TOOL_ITERATIONS = 16;
const MAX_PROGRAMMATIC_CALLS_PER_BATCH = 4;
const MAX_PROGRAMMATIC_CALLS_PER_TURN = 4;
const MAX_PROGRAMMATIC_CALLS_PER_PROGRAM = 4;
const MAX_EVE_KILL_CALLS_PER_TURN = 30;
const MAX_EVE_KILL_ANALYTICS_CALLS_PER_TURN = 4;
const MAX_CONSECUTIVE_SAME_TOOL = 3;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_CHARS = 15000;
const PREVIOUS_RESPONSE_MAX_AGE_MS = 55 * 60 * 1000;
const RECOVERY_TOOL_SUMMARY_LIMIT = 6;
const RECOVERY_TOOL_RESULT_CHARS = 280;
const TOOL_STATE_MISMATCH_FRAGMENT = 'tool_state_mismatch';
const LEGACY_TOOL_STATE_MISMATCH_FRAGMENT = 'No tool call found for function call output with call_id';
const RESPONSE_STATE_MISSING_FRAGMENT = 'response_state_missing';

let readToolAdmission: ResponseAdmissionController | null = null;
let writeToolAdmission: ResponseAdmissionController | null = null;

function getReadToolAdmission(): ResponseAdmissionController {
  readToolAdmission ??= new ResponseAdmissionController({
    maxConcurrent: config.openai?.maxConcurrentReadTools ?? 16,
    maxQueued: config.openai?.maxQueuedTools ?? 64,
    queueTimeoutMs: config.openai?.toolQueueTimeoutMs ?? 15_000,
    label: 'Read tool',
  });
  return readToolAdmission;
}

function getWriteToolAdmission(): ResponseAdmissionController {
  writeToolAdmission ??= new ResponseAdmissionController({
    maxConcurrent: 1,
    maxQueued: config.openai?.maxQueuedTools ?? 64,
    queueTimeoutMs: config.openai?.toolQueueTimeoutMs ?? 15_000,
    label: 'Write tool',
  });
  return writeToolAdmission;
}

export { ESI_FIELD_WHITELIST, filterEsiFields, validateEsiFields } from './esi-field-filter.js';

/**
 * Auto-strip response fields whose value is constant across all rows
 * AND matches a request parameter value. These are pure waste —
 * the caller already knows the value from the request args.
 */
async function executeBatchMarketPrices(
  db: Db,
  args: Record<string, unknown>,
  _ctx: UserContext,
): Promise<unknown> {
  const invalid = (error: string): Record<string, unknown> => ({
    ok: false,
    source: 'CCP ESI',
    authoritative: true,
    error,
    status: null,
    blocked: false,
  });
  if (Object.keys(args).some((key) => key !== 'region_id' && key !== 'type_ids')) {
    return invalid('Unknown batch_market_prices parameter');
  }
  if (typeof args.region_id !== 'number' || !Number.isSafeInteger(args.region_id) || args.region_id <= 0) {
    return invalid('region_id must be a positive safe integer');
  }
  if (
    !Array.isArray(args.type_ids)
    || args.type_ids.length === 0
    || args.type_ids.length > 30
    || args.type_ids.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
  ) {
    return invalid('type_ids must contain 1 to 30 positive safe integers');
  }
  const typeIds = args.type_ids as number[];
  if (new Set(typeIds).size !== typeIds.length) {
    return invalid('type_ids must be unique');
  }
  const regionId = args.region_id;

  console.log('[batch_market] types=%d', typeIds.length);

  type OrderData = { price: number; volume_remain: number; is_buy_order: boolean };
  type MarketResult = {
    type_id: number;
    error?: string;
    sell: { min_price: number; volume: number; orders: number } | null;
    buy: { max_price: number; volume: number; orders: number } | null;
    global_average_price?: number;
  };

  const results: MarketResult[] = await Promise.all(
    typeIds.map(async (typeId): Promise<MarketResult> => {
      const esiResult = await callEsiOperation<OrderData[]>(
        db,
        'get_markets_region_id_orders',
        { region_id: regionId, order_type: 'all', type_id: typeId },
        null,
      );
      if (!esiResult.ok || !Array.isArray(esiResult.data)) {
        return { type_id: typeId, error: 'Market data unavailable', sell: null, buy: null };
      }
      const orders = esiResult.data;
      const sell = orders.filter((o) => !o.is_buy_order);
      const buy = orders.filter((o) => o.is_buy_order);
      const minSell = sell.length > 0 ? Math.min(...sell.map((o) => o.price)) : null;
      const maxBuy = buy.length > 0 ? Math.max(...buy.map((o) => o.price)) : null;
      const sellVolume = sell.reduce((s, o) => s + o.volume_remain, 0);
      const buyVolume = buy.reduce((s, o) => s + o.volume_remain, 0);
      return {
        type_id: typeId,
        sell: minSell != null ? { min_price: minSell, volume: sellVolume, orders: sell.length } : null,
        buy: maxBuy != null ? { max_price: maxBuy, volume: buyVolume, orders: buy.length } : null,
      };
    }),
  );

  // PLEX and a few other items trade on a global cross-region market, so the
  // regional order book is empty and would leave the model with two nulls
  // (which reads as "no data" and makes it give up). Backfill those with the
  // ESI global average price so every item gets a usable number. One extra
  // call, only when needed; the global list is ETag-cached.
  const needsGlobal = results.filter((r) => !r.error && r.sell === null && r.buy === null);
  if (needsGlobal.length > 0) {
    type GlobalPrice = { type_id: number; average_price?: number; adjusted_price?: number };
    const globalResult = await callEsiOperation<GlobalPrice[]>(db, 'get_markets_prices', {}, null);
    if (globalResult.ok && Array.isArray(globalResult.data)) {
      // Use ONLY average_price (the ESI trade average). adjusted_price is CCP's
      // internal valuation, not a market quote — falling back to it would report a
      // fake price for non-traded/stale items.
      const priceMap = new Map(
        globalResult.data.map((p) => [p.type_id, p.average_price] as const),
      );
      for (const r of needsGlobal) {
        const avg = priceMap.get(r.type_id);
        if (typeof avg === 'number' && avg > 0) {
          r.global_average_price = avg;
        }
      }
    }
  }

  const prices = results.map((result) => ({
    type_id: result.type_id,
    sell: result.sell,
    buy: result.buy,
    global_average_price: result.global_average_price ?? null,
    error: result.error ?? null,
  }));
  console.log('[batch_market] done items=%d', prices.length);

  return {
    ok: true,
    source: 'CCP ESI',
    authoritative: true,
    freshness: {
      retrieved_at: new Date().toISOString(),
      data_through: null,
      cache_max_age_seconds: null,
    },
    region_id: regionId,
    prices,
  };
}

function stripRedundantFields(data: unknown, requestArgs: Record<string, unknown>): unknown {
  if (!Array.isArray(data) || data.length === 0) return data;
  const first = data[0];
  if (!first || typeof first !== 'object') return data;

  // Find fields present in response that match a request arg value
  const redundant: string[] = [];
  for (const [key, argVal] of Object.entries(requestArgs)) {
    if (argVal == null || typeof argVal === 'object') continue;
    const responseKey = key.replace(/_id$/, '') === key ? key : key; // exact match
    if (!(responseKey in (first as Record<string, unknown>))) continue;
    // Check if value is constant across all rows and matches arg
    const allMatch = data.every((row) => {
      if (!row || typeof row !== 'object') return false;
      return (row as Record<string, unknown>)[responseKey] === argVal;
    });
    if (allMatch) redundant.push(responseKey);
  }

  if (redundant.length === 0) return data;
  console.log('[esi]   auto-stripped redundant fields=%j (values known from request args)', redundant);

  const dropSet = new Set(redundant);
  return data.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const record = row as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (!dropSet.has(k)) result[k] = v;
    }
    return result;
  });
}

export type AgentResult = {
  text: string;
  /** Peak input tokens in a single API call — reflects actual context size. */
  peakInputTokens: number;
};

export async function handleAgentMessage(
  db: Db,
  threadId: string,
  ctx: UserContext,
  userText: string,
): Promise<AgentResult> {
  ensureThreadOwnership(db, threadId, ctx);

  const linked = getLinkedCharacter(db, ctx);
  let userProfile = await readUserProfile(db, ctx);

  // Guard: if character is linked but profile file is missing, try to refresh it
  if (linked && !userProfile) {
    const PROFILE_GUARD_TIMEOUT_MS = 10_000;
    try {
      const result = await Promise.race([
        refreshUserProfile(db, ctx),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PROFILE_GUARD_TIMEOUT_MS)),
      ]);
      if (result && result.ok) {
        userProfile = await readUserProfile(db, ctx);
      }
    } catch {
      // proceed without profile
    }
  }

  const liveContextNeeds = deriveLiveContextNeeds(userText);
  const liveContext = linked && (liveContextNeeds.location || liveContextNeeds.ship)
    ? await fetchLiveContext(db, linked.characterId, ctx, liveContextNeeds)
    : null;

  const staticAggregateFastPath = tryHandleStaticAggregateFastPath(
    db,
    threadId,
    userText,
    liveContext?.location ?? null,
  );
  if (staticAggregateFastPath) {
    return { text: staticAggregateFastPath, peakInputTokens: 0 };
  }

  // Codex-style pre-turn compaction: compact before first API call if accumulated
  // tokens exceed 90% of model context window.
  await runPreTurnCompactSafe(db, threadId);

  const promptMode = isSimpleStaticAggregateCountGoal(userText) ? 'static_aggregate' : 'full';

  // Rebuild the developer prompt from current thread state. Called once up front
  // and again after mid-turn compaction so `instructions` always carries the
  // freshest thread summary. Everything except the summary is turn-stable.
  const rebuildDeveloperPrompt = (): string =>
    buildDeveloperPrompt(
      {
        authenticated: Boolean(linked),
        characterId: linked?.characterId ?? null,
        characterName: linked?.characterName ?? null,
        grantedScopes: linked?.scopes ?? [],
      },
      getThreadSummary(db, threadId),
      userProfile,
      liveContext?.summary ?? null,
      promptMode,
      config.openai.responseLanguage,
      config.openai.programmaticToolCalling,
    );

  const developerPrompt = rebuildDeveloperPrompt();

  const result = await runNativeAgentLoop(db, threadId, ctx, userText, developerPrompt, rebuildDeveloperPrompt);

  // Advance the pre-turn compaction counter. Stateless prompts are rebuilt from
  // a bounded SQLite window, so accumulating each peak acts as the periodic
  // backlog-summary cadence. Server-mode usage already includes the retained
  // previous-response chain, so its latest peak is the actual context size and
  // must not be added repeatedly. Compaction resets either representation.
  db.prepare(
    config.openai.responseStateMode === 'server'
      ? 'UPDATE agent_threads SET total_tokens = ? WHERE thread_id = ?'
      : 'UPDATE agent_threads SET total_tokens = COALESCE(total_tokens, 0) + ? WHERE thread_id = ?'
  ).run(result.peakInputTokens, threadId);

  return result;
}

type LiveContextNeeds = {
  location: boolean;
  ship: boolean;
};

type ShipContext = {
  shipName: string;
  shipTypeId: number;
  shipTypeName: string;
};

type LiveContext = {
  summary: string | null;
  location: SystemLocationContext | null;
  ship: ShipContext | null;
};

async function fetchLiveContext(
  db: Db,
  characterId: number,
  ctx: UserContext,
  needs: LiveContextNeeds,
): Promise<LiveContext> {
  try {
    await getEveCapabilities(db, 'executor_live_context', ctx);
    const [locationResult, shipResult] = await Promise.all([
      needs.location
        ? callEsiOperation<{ solar_system_id: number; station_id?: number; structure_id?: number }>(
            db, 'get_characters_character_id_location', { character_id: characterId }, ctx,
          )
        : Promise.resolve(null),
      needs.ship
        ? callEsiOperation<{ ship_type_id: number; ship_item_id: number; ship_name: string }>(
            db, 'get_characters_character_id_ship', { character_id: characterId }, ctx,
          )
        : Promise.resolve(null),
    ]);

    const parts: string[] = [];
    let locationContext: SystemLocationContext | null = null;
    let shipContext: ShipContext | null = null;

    if (locationResult?.ok) {
      const sysId = locationResult.data.solar_system_id;
      locationContext = resolveSystemLocationContext(db, sysId);
      const sysName = locationContext?.systemName ?? `ID ${sysId}`;
      const sec = locationContext?.security != null ? ` (sec ${Number(locationContext.security).toFixed(1)})` : '';
      parts.push(`Система: ${sysName}${sec}, system_id=${sysId}`);
      if (locationContext?.constellationName) {
        parts.push(`Созвездие: ${locationContext.constellationName}`);
      }
      if (locationContext?.regionName) {
        parts.push(`Регион: ${locationContext.regionName}`);
      }
      if (locationResult.data.station_id) parts.push(`Станция: station_id=${locationResult.data.station_id}`);
    }

    if (shipResult?.ok) {
      const typeRow = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(shipResult.data.ship_type_id) as { name: string } | undefined;
      const shipType = typeRow?.name ?? `type_id ${shipResult.data.ship_type_id}`;
      shipContext = {
        shipName: shipResult.data.ship_name,
        shipTypeId: shipResult.data.ship_type_id,
        shipTypeName: shipType,
      };
      // Enrich with hull assessment (EHP, align, class) for tactical context
      const assessment = assessShip(db, shipResult.data.ship_type_id);
      parts.push(
        `Корабль: ${shipResult.data.ship_name} (${shipType}), type_id=${shipResult.data.ship_type_id}`
        + `, класс=${assessment.shipClass}, base_ehp=${assessment.ehp}, align=${assessment.alignTime}s, warp=${assessment.warpSpeed}AU/s`
        + (assessment.isHighValueTarget ? ', HIGH_VALUE_TARGET' : ''),
      );

      // Resolve saved fitting matching current ship → persist to USER.md
      const fitting = await resolveActiveFitting(db, ctx, shipResult.data.ship_type_id, shipType);
      if (fitting) {
        parts.push(`Активный фит:\n${fitting}`);
      }
    }

    return {
      summary: parts.length > 0 ? parts.join('\n') : null,
      location: locationContext,
      ship: shipContext,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[executor] live context unavailable: %s', message);
    return {
      summary: null,
      location: null,
      ship: null,
    };
  }
}

type SystemLocationContext = {
  systemName: string;
  security: number | null;
  constellationName: string | null;
  regionName: string | null;
};

function resolveSystemLocationContext(db: Db, systemId: number): SystemLocationContext | null {
  const row = db.prepare(`
    SELECT
      s.name AS system_name,
      COALESCE(json_extract(s.data_json, '$.securityStatus'), json_extract(s.data_json, '$.security')) AS security,
      c.name AS constellation_name,
      r.name AS region_name
    FROM sde_systems s
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.system_id = ?
  `).get(systemId) as {
    system_name: string;
    security: number | null;
    constellation_name: string | null;
    region_name: string | null;
  } | undefined;

  if (!row) return null;
  return {
    systemName: row.system_name,
    security: row.security == null ? null : Number(row.security),
    constellationName: row.constellation_name,
    regionName: row.region_name,
  };
}

/**
 * Pre-turn compaction must never fail the user's turn: buildSmartContext caps
 * the prompt regardless of backlog size, and mid-turn compaction failure in
 * this same file is already deliberately non-fatal. While total_tokens stays
 * over the limit the next turn simply retries compaction.
 */
async function runPreTurnCompactSafe(db: Db, threadId: string): Promise<void> {
  // An abandoned turn (CLI Ctrl-C during the pre-loop work) must not spend a
  // summarizer model call or rewrite thread history — the loop would throw
  // TURN_ABORTED_MESSAGE right after anyway.
  if (isTurnAborted()) return;
  try {
    await runPreTurnCompact(db, threadId);
  } catch (error) {
    console.error('[executor] pre-turn compaction failed, continuing without compaction:', error);
  }
}

/**
 * Transient model/transport failures that are safe to retry with the exact
 * same request: our 90s deadline, truncated SSE streams, provider 429/5xx,
 * and undici/socket-level drops. Tool side effects only happen after a
 * successful response, so re-sending the identical call cannot duplicate them.
 */
function isTransientModelError(message: string): boolean {
  return /timed out|admission queue|Incomplete response stream|HTTP (429|5\d\d)|terminated|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|rate.?limit|server had an error|server_error|overloaded|too many requests|bad gateway|service unavailable|gateway time-?out/i.test(message);
}

const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1000;

function transientRetryDelayMs(attempt: number): number {
  // Bounded linear backoff: 1s, 2s, 3s — worst case adds ~6s to a turn.
  return TRANSIENT_RETRY_BASE_DELAY_MS * attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runNativeAgentLoop(
  db: Db,
  threadId: string,
  ctx: UserContext,
  goal: string,
  developerPrompt: string,
  rebuildDeveloperPrompt: () => string,
  responseFactory: typeof createNativeResponse = createNativeResponse,
): Promise<AgentResult> {
  const requestId = createRequestId();
  const builtTools = await buildNativeAgentTools(
    isSimpleStaticAggregateCountGoal(goal) ? 'static_aggregate' : 'full',
    { notificationCapability: ctx.notificationCapability ?? 'all' },
  );
  const clientToolSearch = config.openai.toolSearchExecution === 'client'
    ? prepareClientToolSearch(builtTools)
    : { requestTools: builtTools, index: [] as ClientToolSearchIndex };
  const tools = clientToolSearch.requestTools;
  const webSearchState = createWebSearchState();
  const reasoningEffort = resolveReasoningEffort(goal, config.openai.reasoningEffort);
  const safetyIdentifier = buildSafetyIdentifier(ctx.userId, config.auth.secretKey);
  console.log(
    '[executor] reasoning effort=%s source=%s mode=%s for goal="%s"',
    reasoningEffort,
    config.openai.reasoningEffort === 'auto' ? 'auto' : 'fixed',
    config.openai.reasoningMode,
    goal.slice(0, 60),
  );

  const continuation = planConversationContinuation(db, threadId);
  const useServerResponseState = config.openai.responseStateMode === 'server';
  let pendingItems: NativeInputItem[] = useServerResponseState
    ? continuation.items
    : buildSmartContext(db, threadId);
  // The Responses API rejects an empty input without previous_response_id.
  // History can be empty on a brand-new thread; fall back to the goal itself.
  if (pendingItems.length === 0 && !continuation.previousResponseId) {
    pendingItems = [toNativeMessage(goal)];
  }
  let previousResponseId: string | null = useServerResponseState
    ? continuation.previousResponseId
    : null;
  // Server mode normally sends only the newest input plus previous_response_id.
  // Keep an exact in-memory replay for this active turn so an expired provider
  // chain can restart cold without losing reasoning, calls, or tool outputs.
  let serverRecoveryItems: NativeInputItem[] = useServerResponseState
    ? buildSmartContext(db, threadId)
    : [];
  if (useServerResponseState && serverRecoveryItems.length === 0) {
    serverRecoveryItems = [...pendingItems];
  }
  console.log(
    '[executor] context: mode=%s state=%s items=%d prevId=%s',
    continuation.mode,
    useServerResponseState ? 'server' : 'stateless',
    pendingItems.length,
    previousResponseId ?? 'none',
  );

  // Build context management for native compaction
  const contextManagement = config.openai.compactThreshold > 0
    ? [{ type: 'compaction', compact_threshold: config.openai.compactThreshold }]
    : undefined;
  let emptyResponseRetries = 0;
  let lastToolName: string | null = null;
  let consecutiveSameToolCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalReasoningTokens = 0;
  /** Peak input tokens in a single iteration — reflects actual context size for compaction. */
  let peakInputTokens = 0;
  let toolStateRecoveryCount = 0;
  const MAX_TOOL_STATE_RECOVERIES = 3;
  let usedMidTurnCompact = false;
  // Per-turn budget for retrying the same request after a transient failure.
  // Without this, one dropped connection on iteration N throws away all tool
  // work from iterations 0..N-1 (the recovery paths below require
  // previousResponseId and are dead code in the default stateless mode).
  let transientRetries = 0;
  let programmaticCallsExecuted = 0;
  const knownProgramIds = new Set<string>();
  const rejectedProgramIds = new Set<string>();
  const programmaticPrograms = new Map<string, ProgrammaticProgramState>();
  const completedSideEffectResults = new Map<string, unknown>();
  let programInFlight = false;
  const localBatchState = { callsExecuted: 0 };
  let clientToolSearchCallsExecuted = 0;
  const seenClientToolSearchCallIds = new Set<string>();

  console.log('[executor] === NEW REQUEST request=%s goal="%s" ===', requestId, goal.slice(0, 80));

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    // Cooperative cancellation (CLI Ctrl-C): stop before spending another
    // model call. The CLI discards the turn's rows, so nothing is lost.
    if (isTurnAborted()) {
      if (useServerResponseState) saveLastResponseId(db, threadId, null);
      throw new Error(TURN_ABORTED_MESSAGE);
    }

    reportActivity({ type: 'model_turn', iteration });
    let response;
    try {
      response = await responseFactory({
        instructions: developerPrompt,
        items: pendingItems,
        previousResponseId,
        // Reuse the opaque per-user key for cache routing. Never send the raw
        // conversation/database identifier to the model provider.
        promptCacheKey: safetyIdentifier,
        tools,
        parallelToolCalls: true,
        truncation: 'auto',
        contextManagement,
        reasoningEffort,
        reasoningMode: config.openai.reasoningMode,
        // Preserve opaque reasoning for exact active-turn recovery in both
        // modes. It remains in memory and is never stored in SQLite.
        preserveReasoning: true,
        safetyIdentifier,
        // Only this top-level loop streams to the CLI activity feed; internal
        // model calls (compaction/OSINT/advisor) must not leak into the answer.
        streamToActivity: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientModelError(message) && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries += 1;
        const delay = transientRetryDelayMs(transientRetries);
        console.warn('[executor] transient model error retry=%d/%d delay_ms=%d message_length=%d',
          transientRetries, MAX_TRANSIENT_RETRIES, delay, message.length);
        await sleep(delay);
        // No response was processed: retry the exact same request without
        // consuming a tool iteration or changing its continuation id.
        iteration -= 1;
        continue;
      }
      if (
        shouldUseToolStateRecovery(
          message,
          toolStateRecoveryCount >= MAX_TOOL_STATE_RECOVERIES,
          previousResponseId,
          pendingItems,
        )
      ) {
        toolStateRecoveryCount += 1;
        previousResponseId = null;
        pendingItems = buildResponseStateRecoveryContext(db, threadId, serverRecoveryItems);
        serverRecoveryItems = [...pendingItems];
        saveLastResponseId(db, threadId, null);
        console.warn('[executor] tool state lost, switching to cold recovery context');
        continue;
      }
      if (useServerResponseState) saveLastResponseId(db, threadId, null);
      throw error;
    }

    // Cooperative cancellation, immediately after sampling: an abort during
    // the model call must stop the turn BEFORE mid-turn compaction (another
    // model call + history mutation) or any tool execution.
    if (isTurnAborted()) {
      if (useServerResponseState) saveLastResponseId(db, threadId, null);
      throw new Error(TURN_ABORTED_MESSAGE);
    }

    if (response.error) {
      if (isTransientModelError(response.error.message) && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries += 1;
        const delay = transientRetryDelayMs(transientRetries);
        console.warn('[executor] transient response error retry=%d/%d delay_ms=%d message_length=%d',
          transientRetries, MAX_TRANSIENT_RETRIES, delay, response.error.message.length);
        await sleep(delay);
        // Error envelopes are rejected before their output is processed.
        iteration -= 1;
        continue;
      }
      if (
        shouldUseToolStateRecovery(
          response.error.message,
          toolStateRecoveryCount >= MAX_TOOL_STATE_RECOVERIES,
          previousResponseId,
          pendingItems,
        )
      ) {
        toolStateRecoveryCount += 1;
        previousResponseId = null;
        pendingItems = buildResponseStateRecoveryContext(db, threadId, serverRecoveryItems);
        serverRecoveryItems = [...pendingItems];
        saveLastResponseId(db, threadId, null);
        console.warn('[executor] tool state lost in response payload, switching to cold recovery context');
        continue;
      }
      console.error('[executor] model error message_length=%d', response.error.message.length);
      const message = 'Сервис модели временно недоступен. Попробуй ещё раз.';
      storeAssistantMessage(db, threadId, message);
      saveLastResponseId(db, threadId, null);
      console.log('[executor] === DONE (error) total_in=%d total_out=%d total_cached=%d total_cache_write=%d total_reasoning=%d ===',
        totalInputTokens, totalOutputTokens, totalCachedTokens, totalCacheWriteTokens, totalReasoningTokens);
      return { text: message, peakInputTokens };
    }

    if (response.status && response.status !== 'completed') {
      console.error('[executor] non-completed model response status=%s', response.status);
      const message = 'Сервис модели временно недоступен. Попробуй ещё раз.';
      storeAssistantMessage(db, threadId, message);
      saveLastResponseId(db, threadId, null);
      return { text: message, peakInputTokens };
    }

    if (useServerResponseState) {
      serverRecoveryItems.push(...buildOrderedContinuationInputItems(
        response.output,
        config.openai.supportsEncryptedReasoningReplay,
      ));
    }

    for (const item of response.output) {
      if (item.type !== 'program') continue;
      if (typeof item.call_id === 'string' && item.call_id.trim()) {
        knownProgramIds.add(item.call_id);
      }
      programInFlight = true;
    }

    // Track token usage
    if (response.usage) {
      totalInputTokens += response.usage.input;
      totalOutputTokens += response.usage.output;
      totalCachedTokens += response.usage.cached;
      totalCacheWriteTokens += response.usage.cacheWrite ?? 0;
      totalReasoningTokens += response.usage.reasoning;
      if (response.usage.input > peakInputTokens) peakInputTokens = response.usage.input;
      console.log('[executor] iter=%d tokens: in=%d out=%d cached=%d cache_write=%d reasoning=%d',
        iteration, response.usage.input, response.usage.output, response.usage.cached,
        response.usage.cacheWrite ?? 0, response.usage.reasoning);
    }

    // --- Codex-style mid-turn compaction ---
    // After each sampling request, if input tokens >= autoCompactLimit AND model
    // needs follow-up (tool calls), compact and continue the loop.
    if (
      response.usage && needsMidTurnCompaction(response.usage.input) &&
      !programInFlight &&
      iteration > 0 && !usedMidTurnCompact
    ) {
      const toolCalls = extractFunctionCalls(response.output);
      if (toolCalls.length > 0) {
        console.log('[executor] mid-turn compaction: input=%d >= autoCompactLimit at iteration=%d',
          response.usage.input, iteration);
        usedMidTurnCompact = true;
        try {
          await runMidTurnCompact(db, threadId);
          // Refresh `instructions` so the newly written summary reaches the model
          // for the rest of this turn; the prompt captured before the loop still
          // holds the pre-compaction summary state.
          developerPrompt = rebuildDeveloperPrompt();
          previousResponseId = null;
          pendingItems = buildSmartContext(db, threadId);
          // The summary only covers user/assistant history — re-inject the
          // freshest tool results so this turn's collected data survives.
          const toolSummary = buildRecentToolSummaryMessage(db, threadId);
          if (toolSummary) {
            pendingItems.push(toNativeAssistantMessage(toolSummary));
          }
          pendingItems.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '[system] Контекст был сжат из-за размера. Продолжай выполнение задачи, используя сводку и восстановленные tool-результаты выше. Если нужные данные уже есть — используй их, не вызывай tools повторно.' }],
          } as NativeInputItem);
          if (useServerResponseState) serverRecoveryItems = [...pendingItems];
          continue;
        } catch (compactError) {
          console.error('[executor] mid-turn compaction failed:', compactError);
          // Continue without compaction — truncation='auto' handles overflow
        }
      }
    }

    if (response.toolSearchPaths.length > 0) {
      console.log('[executor] iteration=%d toolSearchPaths=%j', iteration, response.toolSearchPaths);
    }

    const clientSearchCalls = extractClientToolSearchCalls(response.output);
    const toolSearchItemCount = response.output.filter((item) => item.type === 'tool_search_call').length;
    if (
      config.openai.toolSearchExecution === 'client'
      && toolSearchItemCount !== clientSearchCalls.length
    ) {
      const message = 'Не удалось безопасно выполнить локальный поиск tools. Попробуй ещё раз.';
      storeAssistantMessage(db, threadId, message);
      saveLastResponseId(db, threadId, null);
      return { text: message, peakInputTokens };
    }
    if (clientSearchCalls.length > 0) {
      const ordinaryCalls = extractFunctionCalls(response.output);
      const duplicateCallId = clientSearchCalls.some((call) =>
        seenClientToolSearchCallIds.has(call.callId)
        || clientSearchCalls.filter((candidate) => candidate.callId === call.callId).length > 1);
      if (
        config.openai.toolSearchExecution !== 'client'
        || ordinaryCalls.length > 0
        || duplicateCallId
        || clientToolSearchCallsExecuted + clientSearchCalls.length > 4
      ) {
        const message = 'Не удалось безопасно выполнить локальный поиск tools. Попробуй ещё раз.';
        storeAssistantMessage(db, threadId, message);
        saveLastResponseId(db, threadId, null);
        return { text: message, peakInputTokens };
      }
      for (const call of clientSearchCalls) seenClientToolSearchCallIds.add(call.callId);
      clientToolSearchCallsExecuted += clientSearchCalls.length;
      const outputs = clientSearchCalls.map((call) => searchClientTools(
        clientToolSearch.index,
        call.callId,
        call.arguments,
      ));
      console.log('[tool_search] local calls=%d returned_specs=%d',
        outputs.length, outputs.reduce((total, output) => total + output.tools.length, 0));
      if (useServerResponseState) {
        if (!response.id) {
          const message = 'Не удалось продолжить локальный поиск tools: provider did not return response id.';
          storeAssistantMessage(db, threadId, message);
          saveLastResponseId(db, threadId, null);
          return { text: message, peakInputTokens };
        }
        previousResponseId = response.id;
        pendingItems = outputs;
        serverRecoveryItems.push(...outputs);
      } else {
        pendingItems = [
          ...pendingItems,
          ...buildOrderedContinuationInputItems(
            response.output,
            config.openai.supportsEncryptedReasoningReplay,
          ),
          ...outputs,
        ];
        previousResponseId = null;
      }
      continue;
    }

    const toolCalls = extractFunctionCalls(response.output);

    // Never dispatch an unanchored server response. Without a response id the
    // resulting function outputs cannot be submitted safely.
    if (
      useServerResponseState
      && toolCalls.length > 0
      && (response.status !== 'completed' || !response.id)
    ) {
      const message = 'Не удалось продолжить tool loop: provider did not return response id.';
      storeAssistantMessage(db, threadId, message);
      saveLastResponseId(db, threadId, null);
      return { text: message, peakInputTokens };
    }

    // Anti-loop: detect consecutive same-tool calls
    if (toolCalls.length === 1) {
      const currentTool = toolCalls[0].name;
      if (currentTool === lastToolName) {
        consecutiveSameToolCount += 1;
      } else {
        consecutiveSameToolCount = 1;
        lastToolName = currentTool;
      }
    } else if (toolCalls.length > 1) {
      consecutiveSameToolCount = 0;
      lastToolName = null;
    }

    if (toolCalls.length === 0) {
      const finalAssistantText = extractFinalAssistantText(response.output);
      const convenienceText = response.outputText.trim();
      if (finalAssistantText !== null) {
        const shapeError = validateCompletedProgramShapes(
          knownProgramIds,
          programmaticPrograms,
          rejectedProgramIds,
        );
        if (programInFlight && shapeError) {
          console.error('[executor] rejected incomplete program shape: %s', shapeError);
          const message = 'Не удалось завершить безопасную программную выборку. Попробуй ещё раз.';
          storeAssistantMessage(db, threadId, message);
          saveLastResponseId(db, threadId, null);
          return { text: message, peakInputTokens };
        }
        programInFlight = false;
        const finalText = finalAssistantText || convenienceText;
        reportActivity({ type: 'final_assistant_message' });
        storeAssistantMessage(db, threadId, finalText, useServerResponseState ? response.id : null);
        console.log('[executor] === DONE (text) iterations=%d total_in=%d total_out=%d total_cached=%d total_cache_write=%d total_reasoning=%d answer=%d chars ===',
          iteration + 1, totalInputTokens, totalOutputTokens, totalCachedTokens, totalCacheWriteTokens,
          totalReasoningTokens, finalText.length);
        return { text: finalText, peakInputTokens };
      }
      if (!programInFlight && convenienceText) {
        storeAssistantMessage(db, threadId, convenienceText, useServerResponseState ? response.id : null);
        return { text: convenienceText, peakInputTokens };
      }
      if (!useServerResponseState && (response.output.length > 0 || convenienceText)) {
        const continuationItems = buildOrderedContinuationInputItems(
          response.output,
          config.openai.supportsEncryptedReasoningReplay,
        );
        if (programInFlight && convenienceText) {
          continuationItems.push(toNativeAssistantMessage(convenienceText));
        }
        pendingItems = [...pendingItems, ...continuationItems];
        previousResponseId = null;
        continue;
      }
      if (response.toolSearchPaths.length > 0 && response.id && useServerResponseState) {
        previousResponseId = response.id;
        pendingItems = [];
        continue;
      }
      const outputTypes = response.output.map((item) => String(item.type ?? 'unknown'));
      const eventTypes = [...new Set(response.rawEvents.map((evt) => evt.event))];
      console.log('[executor] empty response details id=%s outputTypes=%j events=%j',
        response.id ?? 'none', outputTypes, eventTypes);
      if (response.id && emptyResponseRetries < 2 && useServerResponseState) {
        emptyResponseRetries += 1;
        console.log('[executor] empty response, retrying (%d/2) prevId=%s', emptyResponseRetries, response.id);
        previousResponseId = response.id;
        pendingItems = [];
        continue;
      }
      const fallback = 'Не удалось завершить ответ: модель не вернула ни текст, ни tool calls.';
      storeAssistantMessage(db, threadId, fallback);
      saveLastResponseId(db, threadId, null);
      return { text: fallback, peakInputTokens };
    }
    emptyResponseRetries = 0;

    // Re-check right before dispatch: an abort while extracting/answer-building
    // must not let any tool run — especially write tools (route_monitor,
    // intel_note, …). Sequential batches re-check before each tool too.
    if (isTurnAborted()) {
      if (useServerResponseState) saveLastResponseId(db, threadId, null);
      throw new Error(TURN_ABORTED_MESSAGE);
    }
    const validated = validateProgrammaticBatch(
      toolCalls,
      knownProgramIds,
      programmaticCallsExecuted,
      programmaticPrograms,
    );
    const hasProgrammaticBatch = validated.callers.some((caller) => caller !== undefined);
    if (hasProgrammaticBatch) {
      reportActivity({
        type: 'programmatic_tool_batch',
        accepted: validated.reservedProgrammaticCalls,
        rejected: validated.callers.filter((caller, index) => caller && validated.rejections[index]).length,
      });
      for (let index = 0; index < validated.callers.length; index += 1) {
        const caller = validated.callers[index];
        if (caller && validated.rejections[index]) {
          rejectedProgramIds.add(caller.caller_id);
        }
      }
    }
    programmaticCallsExecuted += validated.reservedProgrammaticCalls;
    const argsList = toolCalls.map((toolCall, index) => validated.rejections[index]
      ? {}
      : validated.normalizedArgs[index] ?? safeParseArguments(toolCall.argumentsText));
    const policies = await Promise.all(toolCalls.map((toolCall, index) => validated.rejections[index]
      ? Promise.resolve('read' as const)
      : getToolPolicy(toolCall.name)));
    const runOne = async (toolCall: typeof toolCalls[number], index: number): Promise<unknown> => {
      if (isTurnAborted()) throw new Error(TURN_ABORTED_MESSAGE);
      const rejection = validated.rejections[index];
      if (rejection) return rejection;
      const policy = policies[index];
      const sideEffectKey = policy === 'write' || policy === 'ui'
        ? buildSideEffectExecutionKey(toolCall.name, argsList[index] ?? {})
        : null;
      if (sideEffectKey && completedSideEffectResults.has(sideEffectKey)) {
        console.warn('[executor] reused completed side-effect tool result name=%s', toolCall.name);
        return completedSideEffectResults.get(sideEffectKey);
      }
      const result = await executeToolCall(
        db,
        requestId,
        goal,
        ctx,
        toolCall.name,
        argsList[index] ?? {},
        webSearchState,
        validated.callers[index] !== undefined,
        localBatchState,
      );
      if (sideEffectKey) completedSideEffectResults.set(sideEffectKey, result);
      return result;
    };
    let results: unknown[];
    try {
      results = policies.every((policy) => policy === 'read')
        ? await Promise.all(toolCalls.map(runOne))
        : await executeValidatedToolCallsSequentially(toolCalls, runOne);
    } catch (error) {
      if (useServerResponseState) saveLastResponseId(db, threadId, null);
      throw error;
    }

    const outputs: Array<{ callId: string; output: string; caller?: NativeFunctionCaller }> = [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      const args = argsList[index] ?? {};
      const result = results[index];
      const isAnalytics = isEveKillAnalyticsToolName(toolCall.name);
      const isProgrammatic = validated.callers[index] !== undefined;
      const isBoundedPublicFacade = isMarketHistorySummaryTool(toolCall.name)
        || isSystemMetricSnapshotTool(toolCall.name)
        || isDoctrineSummaryTool(toolCall.name)
        || isDynamicItemSummaryTool(toolCall.name)
        || isLocalParallelBatchTool(toolCall.name);
      const output = isProgrammaticToolName(toolCall.name)
        ? serializeProgrammaticToolOutput(toolCall.name, result)
        : truncateToolOutput(JSON.stringify(result));
      const auditArgs = isBoundedPublicFacade
        ? {
          classification: 'bounded-public-read',
          ...(isLocalParallelBatchTool(toolCall.name)
            ? { calls: localBatchAuditCalls(args) }
            : {}),
        }
        : isAnalytics || isProgrammatic
          ? { fields: Object.keys(args).sort() }
          : args;
      let boundedAudit: Record<string, unknown> | null = null;
      if (isProgrammatic || isBoundedPublicFacade) {
        const parsedOutput = safeParseJsonRecord(output);
        const schemaValid = isProgrammaticToolName(toolCall.name)
          && validateProgrammaticToolOutput(toolCall.name, parsedOutput).valid;
        boundedAudit = {
          ok: parsedOutput?.ok === true,
          blocked: parsedOutput?.blocked === true,
          schema_valid: schemaValid,
          output_chars: output.length,
        };
      }
      const auditResult = boundedAudit ?? compactToolResult(result);
      db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(
        threadId,
        'tool',
        JSON.stringify({
          tool: toolCall.name,
          args: auditArgs,
          result: auditResult,
        }),
      );
      console.log('[tool] %s args=%s sent=%d chars',
        toolCall.name,
        isProgrammatic ? 'programmatic-bounded' : JSON.stringify(auditArgs).slice(0, 120),
        output.length);
      outputs.push({
        callId: toolCall.callId,
        output,
        ...(validated.callers[index] ? { caller: validated.callers[index] } : {}),
      });
    }

    const deterministicAnswer = hasProgrammaticBatch
      ? null
      : tryBuildDeterministicCountAnswer(goal, toolCalls, results);
    if (deterministicAnswer) {
      storeAssistantMessage(db, threadId, deterministicAnswer);
      saveLastResponseId(db, threadId, null);
      console.log('[executor] === DONE (deterministic-count) iterations=%d total_in=%d total_out=%d total_cached=%d total_cache_write=%d total_reasoning=%d answer=%d chars ===',
        iteration + 1, totalInputTokens, totalOutputTokens, totalCachedTokens, totalCacheWriteTokens,
        totalReasoningTokens, deterministicAnswer.length);
      return { text: deterministicAnswer, peakInputTokens };
    }

    // Route shortcircuit: if plan_route returned formatted_summary, output it directly.
    // Saves one model iteration and guarantees the full danger report is shown.
    const hasRouteCall = toolCalls.some((tc) => tc.name === 'plan_route');
    if (hasRouteCall && !hasProgrammaticBatch) {
      const routeIdx = toolCalls.findIndex((tc) => tc.name === 'plan_route');
      const routeResult = results[routeIdx] as Record<string, unknown> | null;
      const summary = routeResult?.formatted_summary;
      if (typeof summary === 'string' && summary.length > 50) {
        storeAssistantMessage(db, threadId, summary);
        // Save null — the response has a dangling function_call (plan_route) without tool output,
        // so continuing from this prevId would cause "No tool output found" API error.
        saveLastResponseId(db, threadId, null);
        console.log('[executor] === DONE (route-shortcircuit) iterations=%d total_in=%d total_out=%d total_cached=%d total_cache_write=%d total_reasoning=%d answer=%d chars ===',
          iteration + 1, totalInputTokens, totalOutputTokens, totalCachedTokens, totalCacheWriteTokens,
          totalReasoningTokens, summary.length);
        return { text: summary, peakInputTokens };
      }
    }

    const functionOutputItems = buildFunctionCallOutputs(outputs);
    if (useServerResponseState) serverRecoveryItems.push(...functionOutputItems);
    if (useServerResponseState) {
      previousResponseId = response.id;
      pendingItems = functionOutputItems;
    } else {
      previousResponseId = null;
      // Stateless mode does not use previous_response_id, independently of
      // whether response logging is enabled with store=true:
      // each request's input is the model's entire view of the turn. Append
      // this round's calls/outputs to the accumulated items instead of
      // replacing them — otherwise the user's goal and earlier tool results
      // vanish after the first round and multi-step turns answer blind.
      // Growth is bounded by MAX_TOOL_ITERATIONS, the 12k/tool output budget,
      // truncation:'auto', and mid-turn compaction.
      pendingItems = [
        ...pendingItems,
        ...buildOrderedContinuationInputItems(
          response.output,
          config.openai.supportsEncryptedReasoningReplay,
        ),
        ...functionOutputItems,
      ];
    }

    // Anti-loop: if same tool called N+ times in a row, inject a nudge
    if (consecutiveSameToolCount >= MAX_CONSECUTIVE_SAME_TOOL) {
      console.log('[executor] anti-loop: %s called %d times consecutively, injecting nudge', lastToolName, consecutiveSameToolCount);
      const antiLoopNudge = {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[system] Ты вызывал один и тот же tool несколько раз подряд. Переходи к следующему шагу: используй собранные данные для ответа или вызови другой tool (get_markets_region_id_orders, plan_route, и т.д.).' }],
      } as NativeInputItem;
      pendingItems.push(antiLoopNudge);
      if (useServerResponseState) serverRecoveryItems.push(antiLoopNudge);
      consecutiveSameToolCount = 0;
    }
  }

  const timeout = 'Остановился после слишком большого числа tool iterations.';
  storeAssistantMessage(db, threadId, timeout);
  saveLastResponseId(db, threadId, null);
  console.log('[executor] === DONE (timeout) iterations=%d total_in=%d total_out=%d total_cached=%d total_cache_write=%d total_reasoning=%d ===',
    MAX_TOOL_ITERATIONS, totalInputTokens, totalOutputTokens, totalCachedTokens, totalCacheWriteTokens,
    totalReasoningTokens);
  return { text: timeout, peakInputTokens };
}

type ExtractedToolCall = ReturnType<typeof extractFunctionCalls>[number];

type ProgrammaticKillWindow = {
  target: string;
  fromMs: number;
  toMs: number;
};

type ProgrammaticProgramState = {
  toolName: string;
  calls: number;
  workUnits: number;
  seenKeys: Set<string>;
  marketTypeIdsKey?: string;
  comparisonKey?: string;
  killWindows: ProgrammaticKillWindow[];
};

type ProgrammaticCallPolicy = {
  args: Record<string, unknown>;
  key: string;
  workUnits: number;
  maxCalls: number;
  marketTypeIdsKey?: string;
  comparisonKey?: string;
  killWindow?: ProgrammaticKillWindow;
};

function validateCompletedProgramShapes(
  knownProgramIds: ReadonlySet<string>,
  states: ReadonlyMap<string, ProgrammaticProgramState>,
  rejectedProgramIds: ReadonlySet<string>,
): string | null {
  for (const programId of knownProgramIds) {
    const state = states.get(programId);
    if (!state) {
      if (rejectedProgramIds.has(programId)) continue;
      return 'Program completed without an eligible bounded tool call';
    }
    const minimum = state.toolName === 'compare_wormhole_types' ? 1 : 2;
    if (state.calls < minimum) {
      return `${state.toolName} requires at least ${minimum} programmatic calls`;
    }
    if (state.toolName === 'count_universe_objects' && state.calls !== 2) {
      return 'count_universe_objects requires exactly two programmatic calls';
    }
  }
  return null;
}

function validateProgrammaticBatch(
  toolCalls: ExtractedToolCall[],
  knownProgramIds: ReadonlySet<string>,
  alreadyExecuted: number,
  programStates: Map<string, ProgrammaticProgramState> = new Map(),
): {
  callers: Array<NativeFunctionCaller | undefined>;
  rejections: Array<Record<string, unknown> | undefined>;
  normalizedArgs: Array<Record<string, unknown> | undefined>;
  reservedProgrammaticCalls: number;
} {
  const callers: Array<NativeFunctionCaller | undefined> = [];
  const rejections: Array<Record<string, unknown> | undefined> = [];
  const normalizedArgs: Array<Record<string, unknown> | undefined> = [];
  const programmaticIndexes: number[] = [];

  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index]!;
    if (call.caller === undefined) continue;
    const caller = call.caller;
    if (!caller || typeof caller !== 'object' || Array.isArray(caller)) {
      throw new Error('Invalid programmatic tool caller');
    }
    const record = caller as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== 'type' && key !== 'caller_id')
      || record.type !== 'program'
      || typeof record.caller_id !== 'string'
      || !record.caller_id.trim()
    ) {
      throw new Error('Invalid programmatic tool caller');
    }
    callers[index] = { type: 'program', caller_id: record.caller_id };
    programmaticIndexes.push(index);
  }

  if (programmaticIndexes.length === 0) {
    return { callers, rejections, normalizedArgs, reservedProgrammaticCalls: 0 };
  }

  const rejectBatch = (error: string) => {
    for (const index of programmaticIndexes) {
      rejections[index] = programmaticPolicyRejection(toolCalls[index]!.name, error);
    }
    return { callers, rejections, normalizedArgs, reservedProgrammaticCalls: 0 };
  };

  if (
    programmaticIndexes.length > MAX_PROGRAMMATIC_CALLS_PER_BATCH
    || alreadyExecuted + programmaticIndexes.length > MAX_PROGRAMMATIC_CALLS_PER_TURN
  ) {
    return rejectBatch('Programmatic tool call budget exceeded');
  }

  const draftStates = cloneProgrammaticStates(programStates);
  for (const index of programmaticIndexes) {
    const call = toolCalls[index]!;
    const caller = callers[index]!;
    if (!config.openai.programmaticToolCalling) {
      return rejectBatch('Programmatic tool calling is disabled');
    }
    if (!knownProgramIds.has(caller.caller_id)) {
      return rejectBatch('Unknown program caller');
    }
    if (!isProgrammaticToolAllowed(call.name)) {
      return rejectBatch('Tool is not allowed for programmatic calling');
    }
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(call.argumentsText) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
      parsed = value as Record<string, unknown>;
    } catch {
      return rejectBatch('Invalid programmatic tool arguments');
    }

    const policy = validateProgrammaticCallPolicy(call.name, parsed);
    if (!policy.ok) return rejectBatch(policy.error);

    const existing = draftStates.get(caller.caller_id);
    const state: ProgrammaticProgramState = existing ?? {
      toolName: call.name,
      calls: 0,
      workUnits: 0,
      seenKeys: new Set<string>(),
      killWindows: [],
    };
    if (state.toolName !== call.name) {
      return rejectBatch('A program may use only one eligible tool family');
    }
    if (
      state.calls + 1 > Math.min(MAX_PROGRAMMATIC_CALLS_PER_PROGRAM, policy.data.maxCalls)
      || state.workUnits + policy.data.workUnits > programmaticWorkUnitLimit(call.name)
    ) {
      return rejectBatch('Programmatic tool call budget exceeded');
    }
    if (state.seenKeys.has(policy.data.key)) {
      return rejectBatch('Duplicate programmatic tool call');
    }
    if (
      policy.data.marketTypeIdsKey
      && state.marketTypeIdsKey
      && state.marketTypeIdsKey !== policy.data.marketTypeIdsKey
    ) {
      return rejectBatch('Market comparison must use the same ordered type_ids');
    }
    if (
      policy.data.comparisonKey
      && state.comparisonKey
      && state.comparisonKey !== policy.data.comparisonKey
    ) {
      return rejectBatch('Programmatic comparison arguments must use one coherent shape');
    }
    if (policy.data.killWindow && state.killWindows.some((window) =>
      window.target === policy.data.killWindow!.target
      && policy.data.killWindow!.fromMs < window.toMs
      && window.fromMs < policy.data.killWindow!.toMs)) {
      return rejectBatch('Kill summary windows for the same target must not overlap');
    }

    state.calls += 1;
    state.workUnits += policy.data.workUnits;
    state.seenKeys.add(policy.data.key);
    state.marketTypeIdsKey ??= policy.data.marketTypeIdsKey;
    state.comparisonKey ??= policy.data.comparisonKey;
    if (policy.data.killWindow) state.killWindows.push(policy.data.killWindow);
    draftStates.set(caller.caller_id, state);
    normalizedArgs[index] = policy.data.args;
  }

  programStates.clear();
  for (const [programId, state] of draftStates) {
    programStates.set(programId, state);
  }
  return {
    callers,
    rejections,
    normalizedArgs,
    reservedProgrammaticCalls: programmaticIndexes.length,
  };
}

function cloneProgrammaticStates(
  states: ReadonlyMap<string, ProgrammaticProgramState>,
): Map<string, ProgrammaticProgramState> {
  return new Map([...states].map(([programId, state]) => [programId, {
    ...state,
    seenKeys: new Set(state.seenKeys),
    killWindows: state.killWindows.map((window) => ({ ...window })),
  }]));
}

function validateProgrammaticCallPolicy(
  name: string,
  args: Record<string, unknown>,
): { ok: true; data: ProgrammaticCallPolicy } | { ok: false; error: string } {
  if (name === 'count_universe_objects') {
    const keys = Object.keys(args);
    const targetKinds = ['system', 'constellation', 'region'];
    const objectKinds = ['constellations', 'systems', 'planets', 'moons', 'asteroid_belts', 'stations', 'stargates'];
    if (
      keys.length !== 3
      || !keys.every((key) => key === 'target_kind' || key === 'target_name' || key === 'object_kind')
      || typeof args.target_name !== 'string'
      || args.target_name.trim().length === 0
      || !targetKinds.includes(String(args.target_kind))
      || !objectKinds.includes(String(args.object_kind))
    ) {
      return { ok: false, error: 'Invalid count_universe_objects programmatic arguments' };
    }
    const normalized = {
      target_kind: args.target_kind,
      target_name: args.target_name.trim(),
      object_kind: args.object_kind,
    };
    return {
      ok: true,
      data: {
        args: normalized,
        key: `${normalized.target_kind}\u0000${normalized.target_name.toLowerCase()}\u0000${normalized.object_kind}`,
        workUnits: 1,
        maxCalls: 2,
      },
    };
  }

  if (name === 'batch_market_prices') {
    const validated = validateBatchMarketArgs(args, 10);
    if (!validated.ok) return validated;
    const typeIdsKey = validated.data.type_ids.join(',');
    return {
      ok: true,
      data: {
        args: validated.data,
        key: String(validated.data.region_id),
        workUnits: validated.data.type_ids.length,
        maxCalls: 4,
        marketTypeIdsKey: typeIdsKey,
      },
    };
  }

  if (name === 'compare_wormhole_types') {
    const validated = validateCompareWormholeTypesArgs(args);
    if (!validated.ok) return { ok: false, error: validated.error };
    return {
      ok: true,
      data: {
        args: validated.args,
        key: validated.args.identifiers.join(','),
        workUnits: validated.args.identifiers.length,
        maxCalls: 1,
      },
    };
  }

  if (name === 'scout_systems') {
    const validated = validateScoutSystemsArgs(args, { programmatic: true });
    if (!validated.ok) return { ok: false, error: validated.error };
    return {
      ok: true,
      data: {
        args: validated.args,
        key: `${validated.args.query.toLowerCase()}\u0000${validated.args.space ?? ''}`,
        workUnits: validated.args.limit,
        maxCalls: 4,
      },
    };
  }

  if (name === 'kill_activity_summary') {
    const validated = validateKillActivitySummaryArgs(args, { programmatic: true });
    if (!validated.ok) return { ok: false, error: validated.error.error };
    const target = `${validated.data.scope}:${validated.data.id}`;
    return {
      ok: true,
      data: {
        args: validated.data,
        key: `${target}\u0000${validated.data.activity}\u0000${validated.data.from}\u0000${validated.data.to}`,
        workUnits: 100,
        maxCalls: 4,
        killWindow: {
          target,
          fromMs: Date.parse(validated.data.from),
          toMs: Date.parse(validated.data.to),
        },
      },
    };
  }

  if (name === 'market_history_summary') {
    const validated = validateMarketHistorySummaryArgs(args, { programmatic: true });
    if (!validated.ok) return { ok: false, error: validated.error.error };
    return {
      ok: true,
      data: {
        args: validated.data,
        key: `${validated.data.region_id}:${validated.data.type_id}`,
        comparisonKey: String(validated.data.days),
        workUnits: validated.data.days,
        maxCalls: 4,
      },
    };
  }

  if (name === 'system_metric_snapshot') {
    const validated = validateSystemMetricSnapshotArgs(args, { programmatic: true });
    if (!validated.ok) return { ok: false, error: validated.error.error };
    return {
      ok: true,
      data: {
        args: validated.data,
        key: validated.data.metric,
        comparisonKey: validated.data.system_ids.join(','),
        workUnits: validated.data.system_ids.length,
        maxCalls: 4,
      },
    };
  }

  if (name === 'doctrine_summary') {
    const validated = validateDoctrineSummaryArgs(args, { programmatic: true });
    if (!validated.ok) return { ok: false, error: validated.error.error };
    return {
      ok: true,
      data: {
        args: validated.data,
        key: `${validated.data.entity_type}:${validated.data.entity_id}`,
        comparisonKey: `${validated.data.from}\u0000${validated.data.to}\u0000${validated.data.top}`,
        workUnits: validated.data.top,
        maxCalls: 4,
      },
    };
  }

  if (name === 'dynamic_item_summary') {
    const validated = validateDynamicItemSummaryArgs(args, { programmatic: true });
    if (!validated.ok) return { ok: false, error: validated.error.error };
    return {
      ok: true,
      data: {
        args: validated.data,
        key: `${validated.data.type_id}:${validated.data.item_id}`,
        comparisonKey: validated.data.attribute_ids.join(','),
        workUnits: validated.data.attribute_ids.length,
        maxCalls: 4,
      },
    };
  }

  return { ok: false, error: 'Tool is not allowed for programmatic calling' };
}

function validateBatchMarketArgs(
  args: Record<string, unknown>,
  maxTypeIds: number,
): { ok: true; data: { region_id: number; type_ids: number[] } } | { ok: false; error: string } {
  if (
    Object.keys(args).length !== 2
    || Object.keys(args).some((key) => key !== 'region_id' && key !== 'type_ids')
    || typeof args.region_id !== 'number'
    || !Number.isSafeInteger(args.region_id)
    || args.region_id <= 0
    || !Array.isArray(args.type_ids)
    || args.type_ids.length < 1
    || args.type_ids.length > maxTypeIds
    || args.type_ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    || new Set(args.type_ids).size !== args.type_ids.length
  ) {
    return { ok: false, error: `Programmatic market calls require 1-${maxTypeIds} unique positive type_ids` };
  }
  return {
    ok: true,
    data: { region_id: args.region_id, type_ids: [...args.type_ids] as number[] },
  };
}

function programmaticWorkUnitLimit(name: string): number {
  if (name === 'batch_market_prices') return 40;
  if (name === 'kill_activity_summary') return 400;
  if (name === 'market_history_summary') return 360;
  if (name === 'system_metric_snapshot') return 400;
  if (name === 'doctrine_summary') return 20;
  if (name === 'dynamic_item_summary') return 40;
  return Number.POSITIVE_INFINITY;
}

function programmaticPolicyRejection(name: string, error: string): Record<string, unknown> {
  if (name === 'count_universe_objects' || !isProgrammaticToolName(name)) {
    return { ok: false, blocked: true, error };
  }
  const source = name === 'batch_market_prices'
    ? 'CCP ESI'
    : name === 'kill_activity_summary' ? 'EVE-KILL'
      : name === 'doctrine_summary' ? 'EVE-KILL MCP'
        : name === 'market_history_summary' || name === 'system_metric_snapshot' || name === 'dynamic_item_summary'
          ? 'CCP ESI'
          : 'EVE-Scout';
  return {
    ok: false,
    source,
    authoritative: name === 'batch_market_prices'
      || name === 'market_history_summary'
      || name === 'system_metric_snapshot'
      || name === 'dynamic_item_summary',
    error,
    status: null,
    blocked: true,
  };
}

async function executeValidatedToolCallsSequentially(
  toolCalls: ExtractedToolCall[],
  runOne: (toolCall: ExtractedToolCall, index: number) => Promise<unknown>,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    if (isTurnAborted()) throw new Error(TURN_ABORTED_MESSAGE);
    results.push(await runOne(toolCalls[index]!, index));
  }
  return results;
}

type LocalParallelBatchCall = {
  id: string;
  tool: ReturnType<typeof localProgrammaticToolName>;
  args: Record<string, unknown>;
};

function localProgrammaticToolName(name: string) {
  if (!isProgrammaticToolName(name)) throw new Error('Invalid local batch tool');
  return name;
}

function validateLocalParallelBatch(
  args: Record<string, unknown>,
  alreadyExecuted: number,
): { ok: true; calls: LocalParallelBatchCall[] } | { ok: false; error: string } {
  if (Object.keys(args).length !== 1 || !Array.isArray(args.calls)) {
    return { ok: false, error: 'Invalid local parallel batch' };
  }
  if (args.calls.length < 1 || args.calls.length > 4 || alreadyExecuted + args.calls.length > 4) {
    return { ok: false, error: 'Local parallel batch budget exceeded' };
  }

  const calls: LocalParallelBatchCall[] = [];
  const ids = new Set<string>();
  const seenOperations = new Set<string>();
  const familyStates = new Map<string, ProgrammaticProgramState>();
  for (const raw of args.calls) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Invalid local parallel batch' };
    }
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3
      || Object.keys(record).some((key) => key !== 'id' && key !== 'tool' && key !== 'arguments_json')
      || typeof record.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id)
      || typeof record.tool !== 'string'
      || typeof record.arguments_json !== 'string'
      || record.arguments_json.length < 2
      || record.arguments_json.length > 4_000
      || ids.has(record.id)
      || !isProgrammaticToolAllowed(record.tool)
    ) {
      return { ok: false, error: 'Invalid local parallel batch' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.arguments_json) as unknown;
    } catch {
      return { ok: false, error: 'Invalid local parallel batch arguments' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Invalid local parallel batch arguments' };
    }
    const policy = validateProgrammaticCallPolicy(record.tool, parsed as Record<string, unknown>);
    if (!policy.ok) return { ok: false, error: 'Local parallel batch arguments were rejected' };
    const operationKey = `${record.tool}\u0000${policy.data.key}`;
    if (seenOperations.has(operationKey)) {
      return { ok: false, error: 'Duplicate local parallel batch operation' };
    }

    const state = familyStates.get(record.tool) ?? {
      toolName: record.tool,
      calls: 0,
      workUnits: 0,
      seenKeys: new Set<string>(),
      killWindows: [],
    };
    if (
      state.calls + 1 > policy.data.maxCalls
      || state.workUnits + policy.data.workUnits > programmaticWorkUnitLimit(record.tool)
      || (policy.data.marketTypeIdsKey && state.marketTypeIdsKey
        && policy.data.marketTypeIdsKey !== state.marketTypeIdsKey)
      || (policy.data.comparisonKey && state.comparisonKey
        && policy.data.comparisonKey !== state.comparisonKey)
      || (policy.data.killWindow && state.killWindows.some((window) =>
        window.target === policy.data.killWindow!.target
        && policy.data.killWindow!.fromMs < window.toMs
        && window.fromMs < policy.data.killWindow!.toMs))
    ) {
      return { ok: false, error: 'Local parallel batch coherence check failed' };
    }
    state.calls += 1;
    state.workUnits += policy.data.workUnits;
    state.seenKeys.add(policy.data.key);
    state.marketTypeIdsKey ??= policy.data.marketTypeIdsKey;
    state.comparisonKey ??= policy.data.comparisonKey;
    if (policy.data.killWindow) state.killWindows.push(policy.data.killWindow);
    familyStates.set(record.tool, state);
    ids.add(record.id);
    seenOperations.add(operationKey);
    calls.push({
      id: record.id,
      tool: localProgrammaticToolName(record.tool),
      args: policy.data.args,
    });
  }
  return { ok: true, calls };
}

async function executeLocalParallelBatch(
  args: Record<string, unknown>,
  state: { callsExecuted: number },
  dispatch: (tool: LocalParallelBatchCall['tool'], args: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  if (!config.openai.supportsLocalParallelBatch) {
    return { ok: false, blocked: true, error: 'Local parallel batch is unavailable' };
  }
  const validated = validateLocalParallelBatch(args, state.callsExecuted);
  if (!validated.ok) return { ok: false, blocked: true, error: validated.error };
  if (isTurnAborted()) throw new Error(TURN_ABORTED_MESSAGE);

  state.callsExecuted += validated.calls.length;
  const settled = await Promise.allSettled(validated.calls.map((call) => dispatch(call.tool, call.args)));
  const results = validated.calls.map((call, index) => {
    const result = settled[index]!;
    const value = result.status === 'fulfilled'
      ? result.value
      : programmaticPolicyRejection(call.tool, 'Tool execution failed');
    return {
      id: call.id,
      tool: call.tool,
      output: JSON.parse(serializeProgrammaticToolOutput(call.tool, value)) as unknown,
    };
  });

  const envelope = { ok: true, results };
  while (JSON.stringify(envelope).length > MAX_TOOL_OUTPUT_CHARS) {
    const largest = results
      .map((result, index) => ({ index, size: JSON.stringify(result.output).length }))
      .filter((entry) => entry.size > 512)
      .sort((left, right) => right.size - left.size)[0];
    if (!largest) break;
    const call = validated.calls[largest.index]!;
    results[largest.index]!.output = JSON.parse(serializeProgrammaticToolOutput(
      call.tool,
      programmaticPolicyRejection(call.tool, 'Batch aggregate output limit exceeded'),
    )) as unknown;
  }
  return envelope;
}

function localBatchAuditCalls(args: Record<string, unknown>): Array<Record<string, string>> {
  if (!Array.isArray(args.calls)) return [];
  return args.calls.slice(0, 4).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    return typeof record.id === 'string' && typeof record.tool === 'string'
      ? [{ id: record.id.slice(0, 64), tool: record.tool.slice(0, 64) }]
      : [];
  });
}

async function executeToolCall(
  db: Db,
  requestId: string,
  goal: string,
  ctx: UserContext,
  name: string,
  args: Record<string, unknown>,
  webSearchState: WebSearchState,
  programmatic = false,
  localBatchState: { callsExecuted: number } = { callsExecuted: 0 },
): Promise<unknown> {
  // The batch container holds no permit while its children wait, preventing a
  // semaphore deadlock. Every validated leaf re-enters this wrapper.
  if (isLocalParallelBatchTool(name)) {
    return executeToolCallUnadmitted(
      db, requestId, goal, ctx, name, args, webSearchState, programmatic, localBatchState,
    );
  }
  const policy = await getToolPolicy(name);
  const admission = policy === 'read'
    ? getReadToolAdmission()
    : policy === 'write' || policy === 'ui'
      ? getWriteToolAdmission()
      : null;
  const release = admission ? await admission.acquire() : null;
  try {
    return await executeToolCallUnadmitted(
      db, requestId, goal, ctx, name, args, webSearchState, programmatic, localBatchState,
    );
  } finally {
    release?.();
  }
}

async function executeToolCallUnadmitted(
  db: Db,
  requestId: string,
  goal: string,
  ctx: UserContext,
  name: string,
  args: Record<string, unknown>,
  webSearchState: WebSearchState,
  programmatic = false,
  localBatchState: { callsExecuted: number } = { callsExecuted: 0 },
): Promise<unknown> {
  // Live activity: surface which tool ("skill") is running to any attached sink
  // (the interactive CLI). No-op for the bots. Single point so it covers both
  // the parallel and sequential dispatch paths.
  reportActivity({
    type: 'tool_start',
    name,
    detail: programmatic
      || isMarketHistorySummaryTool(name)
      || isSystemMetricSnapshotTool(name)
      || isDoctrineSummaryTool(name)
      || isDynamicItemSummaryTool(name)
      || isLocalParallelBatchTool(name)
      ? 'bounded public read'
      : isEveKillAnalyticsToolName(name) ? 'public analytics request' : summarizeToolArgs(name, args),
  });

  const notificationCapability = ctx.notificationCapability ?? 'all';
  const notificationBlocked = notificationCapability === 'none'
    ? name === 'kill_watch' || isHeartbeatConfigTool(name) || isRouteMonitorTool(name)
    : notificationCapability === 'feed' && isHeartbeatConfigTool(name);
  if (notificationBlocked) {
    return {
      ok: false,
      blocked: true,
      error: notificationCapability === 'feed'
        ? 'Heartbeat scheduling is unavailable in the terminal CLI. Route monitoring and EVE-KILL watches remain available while the CLI is running.'
        : 'Durable background notifications are unavailable in this transient chat lane. Use Telegram, Discord, or the interactive CLI.',
    };
  }

  if (isLocalParallelBatchTool(name)) {
    return executeLocalParallelBatch(args, localBatchState, async (tool, normalizedArgs) =>
      executeToolCall(
        db,
        requestId,
        goal,
        ctx,
        tool,
        normalizedArgs,
        webSearchState,
        true,
        localBatchState,
      ));
  }

  if (name === 'web_search') {
    const query = String(args.query ?? '');
    const guard = registerWebSearch(webSearchState, query);
    if (!guard.allowed) {
      console.log('[web_search] blocked reason=%s query=%s', guard.reason, query);
      return {
        ok: false,
        results: [],
        error: guard.reason,
        blocked: true,
      };
    }
    console.log('[web_search] query=%s', query);
    const result = await executeWebSearch(query);
    console.log('[web_search] ok=%s results=%d', result.ok, result.results.length);
    return result;
  }

  if (name === 'get_eve_capabilities') {
    return await getEveCapabilities(db, String(args.intent ?? goal), ctx);
  }

  if (name === 'update_plan') {
    const steps = normalizePlanSteps(args.steps);
    return updatePlan(db, requestId, goal, steps);
  }

  if (isSdeSqlTool(name)) {
    return executeSdeSql(db, String(args.sql ?? ''));
  }

  if (isUniverseCountTool(name)) {
    return executeUniverseObjectCount(db, args);
  }

  if (isBatchMarketTool(name)) {
    try {
      return await executeBatchMarketPrices(db, args, ctx);
    } catch {
      return {
        ok: false,
        source: 'CCP ESI',
        authoritative: true,
        error: 'Market request failed',
        status: null,
        blocked: false,
      };
    }
  }

  if (isMarketHistorySummaryTool(name)) {
    return await executeMarketHistorySummary(db, args);
  }

  if (isSystemMetricSnapshotTool(name)) {
    return await executeSystemMetricSnapshot(db, args);
  }

  if (isDynamicItemSummaryTool(name)) {
    return await executeDynamicItemSummary(db, args);
  }

  if (isOsintInferTool(name)) {
    return await executeOsintInferHome(db, args);
  }

  if (isAnalyzeLocalTool(name)) {
    return await executeAnalyzeLocal(db, args);
  }

  if (isAnalyzeScanTool(name)) {
    return await executeAnalyzeScan(db, args);
  }

  if (isIntelNoteTool(name)) {
    return executeIntelNote(db, ctx.userId, args);
  }

  if (isSetActiveFitTool(name)) {
    return await writeManualFitting(db, ctx, String(args.fitting ?? ''));
  }

  if (isHeartbeatConfigTool(name)) {
    return executeHeartbeatConfig(db, ctx, {
      action: String(args.action ?? 'list'),
      interval_seconds: typeof args.interval_seconds === 'number' ? args.interval_seconds : undefined,
      check: typeof args.check === 'string' ? args.check : undefined,
    } as HeartbeatConfigArgs);
  }

  if (isRouteMonitorTool(name)) {
    const action = String(args.action ?? 'status');
    const chatId = ctx.chatId ?? ctx.userId;

    if (action === 'stop') {
      stopRouteMonitor(chatId, 'manual');
      return { ok: true, stopped: true, message: 'Мониторинг маршрута остановлен.' };
    }

    // Default: status
    const monitor = getActiveMonitor(chatId);
    if (!monitor) {
      return { ok: true, active: false, message: 'Нет активного мониторинга маршрута.' };
    }

    const elapsed = Date.now() - new Date(monitor.startedAt).getTime();
    const minutes = Math.round(elapsed / 60_000);
    return {
      ok: true,
      active: true,
      chatId: monitor.chatId,
      characterId: monitor.characterId,
      ship: monitor.shipName,
      shipEhp: monitor.shipEhp,
      currentSystemId: monitor.currentSystemId,
      routeLength: monitor.routeSystems.length,
      jumpsCompleted: monitor.stats.jumpsCompleted,
      killsSeen: monitor.stats.killsSeen,
      dangerEvents: monitor.stats.dangerEvents.length,
      elapsedMinutes: minutes,
    };
  }

  if (name === 'plan_route') {
    const routeArgs: PlanRouteArgs = {
      origin: String(args.origin ?? ''),
      destination: String(args.destination ?? ''),
      set_autopilot: args.set_autopilot !== false,
      avoid: Array.isArray(args.avoid) ? args.avoid.filter((v): v is number => typeof v === 'number') : [],
      prefer: args.prefer === 'shortest' || args.prefer === 'insecure' || args.prefer === 'thera_shortcut' ? args.prefer : 'secure',
    };
    const routeResult = await planRoute(db, routeArgs, ctx);
    console.log('[plan_route] origin=%s dest=%s routes=%d autopilot=%s error=%s',
      routeResult.origin?.name ?? '?', routeResult.destination?.name ?? '?',
      routeResult.routes.length, routeResult.autopilot_set, routeResult.error ?? 'none');
    for (const r of routeResult.routes) {
      console.log('[plan_route]   %s: %d jumps, kills_1h=%d, danger_systems=%d, safe=%d, sampled_value=%dM coverage=%d/%d',
        r.flag, r.jumps, r.total_kills_1h, r.danger_systems.length, r.safe_count,
        r.total_value_m, r.value_resolved_kills, r.total_kills_1h);
    }
    if (!routeResult.ok) {
      return { ok: false, error: routeResult.error };
    }
    return {
      ok: true,
      origin: routeResult.origin,
      destination: routeResult.destination,
      autopilot_set: routeResult.autopilot_set,
      autopilot_mode: routeResult.autopilot_mode,
      formatted_summary: routeResult.formatted_summary,
      routes: routeResult.routes.map((route) => ({
        flag: route.flag,
        jumps: route.jumps,
        min_sec: route.min_sec,
        safe_count: route.safe_count,
        total_kills_1h: route.total_kills_1h,
        sampled_value_m: route.total_value_m,
        value_sample_coverage: {
          resolved_kills: route.value_resolved_kills,
          total_kills: route.total_kills_1h,
        },
        systems: route.systems,
        danger_systems: route.danger_systems.map((danger) => ({
          name: danger.name,
          sec: danger.sec,
          kills_1h: danger.kills_1h,
          pvp: danger.pvp,
          npc: danger.npc,
          sampled_value_m: danger.total_value_m,
          value_sample_coverage: {
            resolved_kills: danger.value_resolved_kills,
            total_kills: danger.kills_1h,
          },
        })),
      })),
    };
  }

  if (isEveKillToolName(name) || isEveKillAnalyticsToolName(name) || isDoctrineSummaryTool(name)) {
    webSearchState.eveKillCallCount += 1;
    if (webSearchState.eveKillCallCount > MAX_EVE_KILL_CALLS_PER_TURN) {
      console.log('[eve-kill] blocked: limit %d reached (call #%d)', MAX_EVE_KILL_CALLS_PER_TURN, webSearchState.eveKillCallCount);
      return { ok: false, error: `Лимит eve-kill (${MAX_EVE_KILL_CALLS_PER_TURN}) на один ответ исчерпан. Анализируй уже собранные данные.`, blocked: true };
    }
    if (isEveKillAnalyticsToolName(name) || isDoctrineSummaryTool(name)) {
      webSearchState.eveKillAnalyticsCallCount += 1;
      if (webSearchState.eveKillAnalyticsCallCount > MAX_EVE_KILL_ANALYTICS_CALLS_PER_TURN) {
        console.log(
          '[eve-kill-analytics] blocked: limit %d reached (call #%d)',
          MAX_EVE_KILL_ANALYTICS_CALLS_PER_TURN,
          webSearchState.eveKillAnalyticsCallCount,
        );
        return {
          ok: false,
          error: `Лимит аналитики EVE-KILL (${MAX_EVE_KILL_ANALYTICS_CALLS_PER_TURN}) на один ответ исчерпан. Анализируй уже собранные данные.`,
          blocked: true,
        };
      }
      const result = isDoctrineSummaryTool(name)
        ? await executeDoctrineSummary(db, args)
        : await executeEveKillAnalyticsTool(name as EveKillAnalyticsToolName, args);
      console.log('[eve-kill-analytics] %s completed (call #%d)', name, webSearchState.eveKillAnalyticsCallCount);
      return result;
    }
    const result = await executeEveKillTool(db, name as EveKillToolName, args, ctx.chatId ?? ctx.userId);
    console.log('[eve-kill] %s completed (call #%d)', name, webSearchState.eveKillCallCount);
    return result;
  }

  if (isEveScoutToolName(name)) {
    const result = await executeEveScoutTool(db, name as EveScoutToolName, args);
    console.log('[eve-scout] %s completed', name);
    return result;
  }

  const fieldValidation = await validateEsiFields(name, args.fields);
  if (!fieldValidation.ok) {
    return { ok: false, status: 400, error: fieldValidation.error };
  }

  const requestedFields = fieldValidation.fields;
  const esiArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'fields' && key !== 'filter_ids'));

  // Bulk endpoint: validate filter_ids
  const bulkSpec = BULK_FILTER_OPERATIONS[name] ?? null;
  const filterIds = Array.isArray(args.filter_ids) ? args.filter_ids as number[] : null;
  if (bulkSpec && (!filterIds || filterIds.length === 0)) {
    return { ok: false, status: 400, error: `${name} is a bulk endpoint. You must supply filter_ids (array of ${bulkSpec.filterKey} values) to filter results.` };
  }
  if (bulkSpec && filterIds && filterIds.length > 100) {
    return { ok: false, status: 400, error: `filter_ids too large (${filterIds.length}). Maximum 100 IDs per request.` };
  }

  const esiResult = await callEsiOperation(db, name, esiArgs, ctx);

  // Bulk endpoint: filter rows by filter_ids
  if (esiResult.ok && esiResult.data != null && bulkSpec && filterIds) {
    const idSet = new Set(filterIds);
    if (Array.isArray(esiResult.data)) {
      const before = esiResult.data.length;
      esiResult.data = (esiResult.data as Record<string, unknown>[]).filter(
        (row) => idSet.has(Number(row[bulkSpec.filterKey])),
      );
      console.log('[esi] %s bulk filter: %d/%d rows matched by %s in %j', name, (esiResult.data as unknown[]).length, before, bulkSpec.filterKey, filterIds);
    }
  }

  // Filter noisy fields from ESI responses
  if (esiResult.ok && esiResult.data != null) {
    const rawData = esiResult.data;
    esiResult.data = filterEsiFields(name, esiResult.data, requestedFields);

    // Auto-strip fields whose value is constant and already known from request args
    esiResult.data = stripRedundantFields(esiResult.data, esiArgs);

    // Log field filtering details
    const whitelistFields = ESI_FIELD_WHITELIST[name] ?? null;
    const rawSample = Array.isArray(rawData) ? rawData[0] : rawData;
    const finalSample = Array.isArray(esiResult.data) ? (esiResult.data as unknown[])[0] : esiResult.data;
    const rawKeys = rawSample && typeof rawSample === 'object' ? Object.keys(rawSample as Record<string, unknown>) : [];
    const keptKeys = finalSample && typeof finalSample === 'object' ? Object.keys(finalSample as Record<string, unknown>) : [];
    const droppedKeys = rawKeys.filter((k) => !keptKeys.includes(k));
    const rowCount = Array.isArray(rawData) ? rawData.length : 1;
    const rawChars = JSON.stringify(rawData).length;
    const finalChars = JSON.stringify(esiResult.data).length;
    const savedPct = rawChars > 0 ? Math.round((1 - finalChars / rawChars) * 100) : 0;
    console.log('[esi] %s rows=%d status=%s cached=%s', name, rowCount, esiResult.status, esiResult.cached ?? false);
    console.log('[esi]   fields_requested=%j whitelist=%j', requestedFields, whitelistFields);
    console.log('[esi]   raw_fields=%j', rawKeys);
    console.log('[esi]   final=%j dropped=%j', keptKeys, droppedKeys);
    console.log('[esi]   raw=%d chars final=%d chars saved=%d%%', rawChars, finalChars, savedPct);
  } else {
    console.log('[esi] %s status=%s ok=%s error=%s',
      name, esiResult.status ?? '?', esiResult.ok, !esiResult.ok ? esiResult.error : 'none');
  }

  return esiResult;
}

export { areSimilarWebSearchQueries, createWebSearchState, normalizeWebSearchQuery, registerWebSearch } from './web-search.js';
export type { WebSearchState } from './web-search.js';

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function safeParseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizePlanSteps(rawSteps: unknown): Array<{
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'blocked' | 'failed';
  depends_on: string[];
  notes: string;
}> {
  if (!Array.isArray(rawSteps)) return [];

  return rawSteps.flatMap((step, index) => {
    if (!step || typeof step !== 'object') return [];
    const record = step as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `step-${index + 1}`;
    const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : `Step ${index + 1}`;
    const status = normalizePlanStepStatus(record.status);
    const depends_on = Array.isArray(record.depends_on)
      ? record.depends_on.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const notes = typeof record.notes === 'string' ? record.notes : '';
    return [{ id, title, status, depends_on, notes }];
  });
}

function normalizePlanStepStatus(value: unknown): 'pending' | 'running' | 'done' | 'blocked' | 'failed' {
  if (
    value === 'pending'
    || value === 'running'
    || value === 'done'
    || value === 'blocked'
    || value === 'failed'
  ) {
    return value;
  }
  return 'pending';
}

function buildSmartContext(db: Db, threadId: string): NativeInputItem[] {
  const rows = db.prepare(
    "SELECT id, role, content FROM messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?",
  ).all(threadId, MAX_CONTEXT_MESSAGES) as Array<{ id: number; role: string; content: string }>;

  rows.reverse(); // chronological order

  // Trim to char budget (drop oldest first)
  const selected: Array<{ role: string; content: string }> = [];
  let totalChars = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (selected.length > 0 && totalChars + row.content.length > MAX_CONTEXT_CHARS) break;
    selected.push(row);
    totalChars += row.content.length;
  }
  selected.reverse();

  return selected.map((row) =>
    row.role === 'assistant'
      ? toNativeAssistantMessage(row.content)
      : toNativeMessage(row.content),
  );
}

function buildToolStateRecoveryContext(db: Db, threadId: string): NativeInputItem[] {
  const items = buildSmartContext(db, threadId);
  const toolSummary = buildRecentToolSummaryMessage(db, threadId);
  if (toolSummary) {
    items.push(toNativeAssistantMessage(toolSummary));
  }
  items.push({
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text: '[system] Provider-side tool state was lost after tool execution. Use the recovered tool results above to answer if they are sufficient. If more work is still required, continue from this cold context and avoid repeating the same tool call loop.',
    }],
  });
  return items;
}

function buildResponseStateRecoveryContext(
  db: Db,
  threadId: string,
  replayItems: NativeInputItem[],
): NativeInputItem[] {
  return replayItems.length > 0 ? [...replayItems] : buildSmartContext(db, threadId);
}

function buildRecentToolSummaryMessage(db: Db, threadId: string): string | null {
  const rows = db.prepare(
    "SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id DESC LIMIT ?",
  ).all(threadId, RECOVERY_TOOL_SUMMARY_LIMIT) as Array<{ content: string }>;
  if (rows.length === 0) return null;

  const lines = rows
    .reverse()
    .map((row) => formatToolRecoveryLine(row.content))
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;

  return `Recovered tool results from SQLite:\n${lines.join('\n')}`;
}

function formatToolRecoveryLine(rawContent: string): string | null {
  try {
    const parsed = JSON.parse(rawContent) as {
      tool?: unknown;
      args?: unknown;
      result?: unknown;
    };
    const tool = typeof parsed.tool === 'string' ? parsed.tool : 'unknown_tool';
    const args = truncateRecoveryValue(parsed.args);
    const result = truncateRecoveryValue(parsed.result);
    return `- ${tool} args=${args} result=${result}`;
  } catch {
    return null;
  }
}

function truncateRecoveryValue(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  if (text.length <= RECOVERY_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, RECOVERY_TOOL_RESULT_CHARS)}…`;
}

function shouldRecoverFromToolStateMismatch(
  message: string,
  previousResponseId: string | null,
  pendingItems: NativeInputItem[],
): boolean {
  if (!previousResponseId) return false;
  if (
    !message.includes(TOOL_STATE_MISMATCH_FRAGMENT)
    && !message.includes(LEGACY_TOOL_STATE_MISMATCH_FRAGMENT)
  ) return false;
  return pendingItems.some((item) => item.type === 'function_call_output');
}

function shouldUseToolStateRecovery(
  message: string,
  exhausted: boolean,
  previousResponseId: string | null,
  pendingItems: NativeInputItem[],
): boolean {
  if (exhausted) return false;
  if (shouldRecoverFromToolStateMismatch(message, previousResponseId, pendingItems)) return true;
  return Boolean(previousResponseId && message.toLowerCase().includes(RESPONSE_STATE_MISSING_FRAGMENT));
}

export { deriveLiveContextNeeds } from './static-aggregate.js';

type ConversationContinuation = {
  mode: 'warm' | 'cold';
  items: NativeInputItem[];
  previousResponseId: string | null;
};

function planConversationContinuation(db: Db, threadId: string): ConversationContinuation {
  const row = db.prepare(
    `SELECT
       t.last_response_id AS last_response_id,
       t.last_response_message_id AS last_response_message_id,
       (SELECT id FROM messages WHERE thread_id = t.thread_id AND role = 'user' ORDER BY id DESC LIMIT 1) AS latest_user_id,
       (SELECT content FROM messages WHERE thread_id = t.thread_id AND role = 'user' ORDER BY id DESC LIMIT 1) AS latest_user_content,
       (SELECT id FROM messages WHERE thread_id = t.thread_id AND role = 'assistant' ORDER BY id DESC LIMIT 1) AS latest_assistant_id,
       (SELECT created_at FROM messages WHERE id = t.last_response_message_id AND thread_id = t.thread_id AND role = 'assistant') AS anchor_assistant_at,
       (SELECT COUNT(*) FROM messages WHERE thread_id = t.thread_id AND id > COALESCE(t.last_response_message_id, 0)) AS messages_after_anchor,
       (SELECT COUNT(*) FROM messages WHERE thread_id = t.thread_id AND role = 'user' AND id > COALESCE(t.last_response_message_id, 0)) AS users_after_anchor
     FROM agent_threads t
     WHERE t.thread_id = ?`
  ).get(threadId) as {
    last_response_id: string | null;
    last_response_message_id: number | null;
    latest_user_id: number | null;
    latest_user_content: string | null;
    latest_assistant_id: number | null;
    anchor_assistant_at: string | null;
    messages_after_anchor: number;
    users_after_anchor: number;
  } | undefined;

  if (
    row?.last_response_id
    && row.last_response_message_id
    && row.latest_user_content
    && row.latest_assistant_id === row.last_response_message_id
    && row.latest_user_id !== null
    && row.latest_user_id > row.last_response_message_id
    && row.messages_after_anchor === 1
    && row.users_after_anchor === 1
    && isRecentSqliteTimestamp(row.anchor_assistant_at, PREVIOUS_RESPONSE_MAX_AGE_MS)
  ) {
    return {
      mode: 'warm',
      items: [toNativeMessage(row.latest_user_content)],
      previousResponseId: row.last_response_id,
    };
  }

  if (row && (row.last_response_id || row.last_response_message_id)) {
    saveLastResponseId(db, threadId, null);
  }

  return {
    mode: 'cold',
    items: buildSmartContext(db, threadId),
    previousResponseId: null,
  };
}

function saveLastResponseId(db: Db, threadId: string, responseId: string | null): void {
  db.prepare(
    "UPDATE agent_threads SET last_response_id = ?, last_response_message_id = NULL, updated_at = datetime('now') WHERE thread_id = ?"
  ).run(responseId, threadId);
}

function buildSideEffectExecutionKey(name: string, args: unknown): string {
  return `${name}\0${JSON.stringify(sortJsonForExecutionKey(args))}`;
}

function sortJsonForExecutionKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonForExecutionKey);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonForExecutionKey(entry)]),
  );
}

function isRecentSqliteTimestamp(value: string | null, maxAgeMs: number): boolean {
  if (!value) return false;
  const millis = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(millis)) return false;
  return (Date.now() - millis) <= maxAgeMs;
}

/**
 * Classify user message complexity to select optimal reasoning effort.
 * Returns 'low' for trivial messages, 'medium' for standard, 'high' for complex analysis.
 */
export function classifyReasoningEffort(goal: string): ApiReasoningEffort {
  const lower = goal.toLowerCase().trim();
  const len = lower.length;

  // Trivial: greetings, very short messages, simple social exchanges
  if (len < 30) {
    if (/^(привет|здравствуй|хай|hi|hello|hey|yo|ку|хей|здорово|дарова|gg|пока|спасибо|thx|thanks|ok|ок|да|нет|ладно|хорошо|понял|ясно)\b/u.test(lower)) {
      return 'low';
    }
    if (/^(что ты умеешь|помощь|help|\/start|\/help)\s*$/u.test(lower)) {
      return 'low';
    }
  }

  // Static aggregate counts → low effort (simple DB lookup)
  if (isSimpleStaticAggregateCountGoal(goal)) {
    return 'low';
  }

  // Complex: multi-entity analysis, scans, OSINT, tactical assessment, market comparison
  const complexPatterns = [
    /анализ|analyze|analysis|проанализируй/u,
    /d-scan|dscan|дскан|флит|fleet comp/u,
    /local\s+scan|локал|кто в локале/u,
    /osint|резиденц|staging|откуда летает/u,
    /сравни|сравнение|compare|vs\s+/u,
    /доктрин|doctrine|counter|контр/u,
    /рассчитай|calculate|dps|ehp|танк/u,
    /маршрут.*опасн|route.*danger|threat/u,
    /фит.*для|build.*fit|fitting/u,
  ];
  if (complexPatterns.some((p) => p.test(lower))) {
    return 'high';
  }

  // Long pastes (D-Scan, fleet comp, local list) → high
  const lineCount = goal.split('\n').length;
  if (lineCount > 10) {
    return 'high';
  }

  return 'medium';
}

export function resolveReasoningEffort(
  goal: string,
  configured: ReasoningEffort,
): ApiReasoningEffort {
  return configured === 'auto'
    ? classifyReasoningEffort(goal)
    : configured;
}

export const __test__ = {
  runNativeAgentLoop,
  runPreTurnCompactSafe,
  isTransientModelError,
  buildSmartContext,
  buildToolStateRecoveryContext,
  buildResponseStateRecoveryContext,
  buildRecentToolSummaryMessage,
  executeToolCall,
  deriveLiveContextNeeds,
  resolveSystemLocationContext,
  shouldRecoverFromToolStateMismatch,
  shouldUseToolStateRecovery,
  buildSideEffectExecutionKey,
  isSimpleStaticAggregateCountGoal,
  detectStaticAggregateObjectKind,
  parseStaticAggregateIntent,
  tryBuildDeterministicCountAnswer,
  tryHandleStaticAggregateFastPath,
  formatCountNoun,
  planConversationContinuation,
  isRecentSqliteTimestamp,
  classifyReasoningEffort,
  resolveReasoningEffort,
  validateProgrammaticBatch,
  validateLocalParallelBatch,
  executeLocalParallelBatch,
  validateCompletedProgramShapes,
  truncateToolOutput,
};

function compactToolResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      count: value.length,
      sample: value.slice(0, 3).map((item) => compactToolResult(item)),
    };
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record).slice(0, 12)) {
    if (Array.isArray(entry)) {
      compacted[key] = {
        count: entry.length,
        sample: entry.slice(0, 3).map((item) => compactToolResult(item)),
      };
      continue;
    }
    if (entry && typeof entry === 'object') {
      compacted[key] = compactToolResult(entry);
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

const MAX_TOOL_OUTPUT_CHARS = 12000;
const SMART_AGGREGATE_THRESHOLD = 20;

/**
 * Smart truncation: for large arrays, compute numeric aggregates (min/max/sum)
 * per field, then attach a top-N sample. Works for any ESI array response.
 */
function truncateToolOutput(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return truncatedToolOutputNotice(json.length);
  }

  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json;

  try {

    // Find the array to aggregate — either top-level or inside .data
    let targetArray: unknown[] | null = null;
    let wrapperObj: Record<string, unknown> | null = null;

    if (Array.isArray(parsed)) {
      targetArray = parsed;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.data)) {
        targetArray = obj.data;
        wrapperObj = obj;
      }
    }

    if (targetArray && targetArray.length >= SMART_AGGREGATE_THRESHOLD) {
      const aggregated = smartAggregate(targetArray);
      if (wrapperObj) {
        wrapperObj.data = aggregated;
        const result = JSON.stringify(wrapperObj);
        if (result.length <= MAX_TOOL_OUTPUT_CHARS) return result;
        aggregated.top = aggregated.top.slice(0, 5);
        wrapperObj.data = aggregated;
        const smaller = stringifyWithinToolOutputBudget(wrapperObj);
        if (smaller) return smaller;
      }
      const result = JSON.stringify(aggregated);
      if (result.length <= MAX_TOOL_OUTPUT_CHARS) return result;
      aggregated.top = aggregated.top.slice(0, 5);
      const smaller = JSON.stringify(aggregated);
      if (smaller.length <= MAX_TOOL_OUTPUT_CHARS) return smaller;
    }

    // Fallback: simple slice
    if (targetArray) {
      const sliced = targetArray.slice(0, 50);
      const payload = wrapperObj
        ? { ...wrapperObj, data: { items: sliced, truncated: true, total: targetArray.length } }
        : { items: sliced, truncated: true, total: targetArray.length };
      const result = JSON.stringify(payload);
      if (result.length <= MAX_TOOL_OUTPUT_CHARS) return result;
      const smaller = targetArray.slice(0, 20);
      const smallPayload = wrapperObj
        ? { ...wrapperObj, data: { items: smaller, truncated: true, total: targetArray.length } }
        : { items: smaller, truncated: true, total: targetArray.length };
      const bounded = stringifyWithinToolOutputBudget(smallPayload);
      if (bounded) return bounded;
    }
  } catch {
    // fall through
  }
  return truncatedToolOutputNotice(json.length);
}

function stringifyWithinToolOutputBudget(value: unknown): string | null {
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_TOOL_OUTPUT_CHARS ? serialized : null;
}

function truncatedToolOutputNotice(totalChars: number): string {
  return JSON.stringify({
    truncated: true,
    total_chars: totalChars,
    notice: 'Tool output exceeded the size budget and was reduced.',
  });
}

function smartAggregate(rows: unknown[]): {
  count: number;
  aggregates: Record<string, { min: number; max: number; sum: number }>;
  top: unknown[];
} {
  const first = rows[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return { count: rows.length, aggregates: {}, top: rows.slice(0, 10) };
  }

  // Detect numeric fields and compute min/max/sum
  const numericFields = new Map<string, { min: number; max: number; sum: number }>();
  const keys = Object.keys(first as Record<string, unknown>);

  for (const key of keys) {
    const val = (first as Record<string, unknown>)[key];
    if (typeof val === 'number') {
      numericFields.set(key, { min: Infinity, max: -Infinity, sum: 0 });
    }
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    for (const [key, agg] of numericFields) {
      const val = record[key];
      if (typeof val === 'number') {
        if (val < agg.min) agg.min = val;
        if (val > agg.max) agg.max = val;
        agg.sum += val;
      }
    }
  }

  const aggregates: Record<string, { min: number; max: number; sum: number }> = {};
  for (const [key, agg] of numericFields) {
    aggregates[key] = agg;
  }

  // Sort by first numeric field (usually price) to get best top-N
  const sortKey = keys.find((k) => numericFields.has(k));
  const sorted = sortKey
    ? [...rows].sort((a, b) => {
        const av = (a as Record<string, unknown>)[sortKey];
        const bv = (b as Record<string, unknown>)[sortKey];
        return (typeof av === 'number' ? av : 0) - (typeof bv === 'number' ? bv : 0);
      })
    : rows;

  return {
    count: rows.length,
    aggregates,
    top: sorted.slice(0, 10),
  };
}

function storeAssistantMessage(
  db: Db,
  threadId: string,
  content: string,
  responseId: string | null = null,
): void {
  db.transaction(() => {
    const inserted = db.prepare(
      'INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)',
    ).run(threadId, 'assistant', content);
    const messageId = Number(inserted.lastInsertRowid);
    db.prepare(
      `UPDATE agent_threads
       SET last_response_id = ?, last_response_message_id = ?, updated_at = datetime('now')
       WHERE thread_id = ?`,
    ).run(responseId, responseId ? messageId : null, threadId);
  })();
}

function ensureThreadOwnership(db: Db, threadId: string, ctx: UserContext): void {
  if (ctx.chatId !== undefined) {
    db.prepare(
      `INSERT INTO telegram_sessions (chat_id, last_seen_at)
       VALUES (?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET last_seen_at = datetime('now')`,
    ).run(ctx.chatId);
  }

  const existing = db.prepare(
    'SELECT chat_id, user_id FROM agent_threads WHERE thread_id = ?',
  ).get(threadId) as { chat_id: number; user_id: number | null } | undefined;

  if (!existing) {
    db.prepare(
      'INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)',
    ).run(threadId, ctx.chatId ?? 0, ctx.userId);
    return;
  }

  // Check ownership: user_id match OR chat_id match
  if (ctx.userId && existing.user_id && existing.user_id !== ctx.userId) {
    throw new Error(`Thread ${threadId} does not belong to user ${ctx.userId}`);
  }
  if (ctx.chatId !== undefined && existing.chat_id !== 0 && existing.chat_id !== ctx.chatId) {
    throw new Error(`Thread ${threadId} does not belong to chat ${ctx.chatId}`);
  }

  // Backfill user_id if missing
  if (ctx.userId && !existing.user_id) {
    db.prepare('UPDATE agent_threads SET user_id = ? WHERE thread_id = ?').run(ctx.userId, threadId);
  }
}
