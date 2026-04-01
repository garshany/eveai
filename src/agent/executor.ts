import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
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
  isBatchMarketTool,
  isHeartbeatConfigTool,
} from './tools.js';
import type { PlanRouteArgs } from './tools.js';
import { updatePlan } from './planner.js';
import { BULK_FILTER_OPERATIONS } from '../eve/esi-catalog.js';
import {
  buildFunctionCallOutputs,
  createNativeResponse,
  extractFunctionCalls,
  toNativeMessage,
  toNativeAssistantMessage,
  type NativeInputItem,
} from './native-responses.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { loadEsiCatalog } from '../eve/esi-catalog.js';
import { readUserProfile, refreshUserProfile } from '../eve/user-profile.js';
import { createRequestId } from './planner.js';
import { getThreadSummary, runPreTurnCompact, needsMidTurnCompaction, runMidTurnCompact } from './compact.js';
import { executeEveKillTool } from '../eve-kill/executor.js';
import type { EveKillToolName } from '../eve-kill/tools.js';
import { executeHeartbeatConfig } from '../scheduled/heartbeat-config.js';
import type { HeartbeatConfigArgs } from '../scheduled/heartbeat-config.js';
import { getLinkedCharacter } from '../eve/sso.js';
import type { UserContext } from '../auth/user-resolver.js';

const MAX_TOOL_ITERATIONS = 16;
const MAX_WEB_SEARCHES_PER_TURN = 2;
const MAX_EVE_KILL_CALLS_PER_TURN = 6;
const MAX_CONSECUTIVE_SAME_TOOL = 3;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_CONTEXT_CHARS = 15000;
const PREVIOUS_RESPONSE_MAX_AGE_MS = 55 * 60 * 1000;
const RECOVERY_TOOL_SUMMARY_LIMIT = 6;
const RECOVERY_TOOL_RESULT_CHARS = 280;
const TOOL_STATE_MISMATCH_FRAGMENT = 'No tool call found for function call output with call_id';

/**
 * Default whitelist of fields to keep per ESI operation.
 * If an operation is listed here, only these fields survive.
 * Unlisted operations pass through unfiltered.
 */
export const ESI_FIELD_WHITELIST: Record<string, string[]> = {
  // Market
  get_markets_region_id_orders: ['price', 'volume_remain', 'is_buy_order', 'location_id', 'system_id'],
  get_markets_structures_structure_id: ['price', 'volume_remain', 'is_buy_order', 'location_id'],

  // Character
  get_characters_character_id_assets: ['type_id', 'location_id', 'quantity', 'item_id', 'is_singleton'],
  get_characters_character_id_orders: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id', 'volume_total'],
  get_characters_character_id_orders_history: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id', 'state'],
  get_characters_character_id_blueprints: ['type_id', 'quantity', 'material_efficiency', 'time_efficiency', 'runs', 'location_id', 'item_id'],
  get_characters_character_id_industry_jobs: ['activity_id', 'blueprint_type_id', 'product_type_id', 'status', 'start_date', 'end_date', 'runs', 'output_location_id'],
  get_characters_character_id_wallet_journal: ['date', 'ref_type', 'amount', 'balance', 'description', 'first_party_id', 'second_party_id'],
  get_characters_character_id_wallet_transactions: ['date', 'type_id', 'quantity', 'unit_price', 'is_buy', 'location_id', 'client_id'],
  get_characters_character_id_contracts: ['contract_id', 'type', 'status', 'price', 'date_issued', 'date_expired', 'issuer_id', 'start_location_id', 'end_location_id', 'title', 'volume'],
  get_characters_character_id_skillqueue: ['skill_id', 'finished_level', 'finish_date', 'queue_position'],

  // Corporation
  get_corporations_corporation_id_assets: ['type_id', 'location_id', 'quantity', 'item_id', 'is_singleton'],
  get_corporations_corporation_id_orders: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id'],
  get_corporations_corporation_id_orders_history: ['type_id', 'price', 'volume_remain', 'is_buy_order', 'location_id', 'region_id', 'state'],
  get_corporations_corporation_id_blueprints: ['type_id', 'quantity', 'material_efficiency', 'time_efficiency', 'runs', 'location_id'],
  get_corporations_corporation_id_industry_jobs: ['activity_id', 'blueprint_type_id', 'product_type_id', 'status', 'start_date', 'end_date', 'runs'],
  get_corporations_corporation_id_contracts: ['contract_id', 'type', 'status', 'price', 'date_issued', 'date_expired', 'issuer_id', 'start_location_id', 'end_location_id', 'title', 'volume'],
  get_corporations_corporation_id_wallets_division_journal: ['date', 'ref_type', 'amount', 'balance', 'description', 'first_party_id', 'second_party_id'],
  get_corporations_corporation_id_wallets_division_transactions: ['date', 'type_id', 'quantity', 'unit_price', 'is_buy', 'location_id', 'client_id'],
  get_corporations_corporation_id_structures: ['structure_id', 'name', 'system_id', 'type_id', 'state', 'fuel_expires', 'services'],
  get_corporations_corporation_id_containers_logs: ['action', 'character_id', 'container_type_id', 'location_id', 'logged_at', 'quantity', 'type_id'],

  // Public contracts
  get_contracts_public_region_id: ['contract_id', 'type', 'price', 'date_expired', 'date_issued', 'start_location_id', 'end_location_id', 'title', 'volume'],

  // Bulk endpoints (server-side row filtering via filter_ids)
  get_universe_system_kills: ['system_id', 'ship_kills', 'npc_kills', 'pod_kills'],
  get_universe_system_jumps: ['system_id', 'ship_jumps'],
  get_markets_prices: ['type_id', 'adjusted_price', 'average_price'],
  get_industry_systems: ['solar_system_id', 'cost_indices'],
  get_sovereignty_map: ['system_id', 'alliance_id', 'corporation_id', 'faction_id'],
};

/**
 * Filter ESI response data to only keep relevant fields.
 * - If `requestedFields` is provided (from tool args.fields), use those.
 * - Otherwise fall back to ESI_FIELD_WHITELIST default for the operation.
 * - If neither exists, return data as-is.
 */
export function filterEsiFields(
  operationName: string,
  data: unknown,
  requestedFields?: string[] | null,
): unknown {
  const fields = requestedFields ?? ESI_FIELD_WHITELIST[operationName] ?? null;
  if (!fields) return data;

  const fieldSet = new Set(fields);

  if (Array.isArray(data)) {
    return data.map((item) => pickFields(item, fieldSet));
  }

  return pickFields(data, fieldSet);
}

export async function validateEsiFields(
  operationName: string,
  rawFields: unknown,
): Promise<{ ok: true; fields: string[] | null } | { ok: false; error: string }> {
  if (rawFields === undefined || rawFields === null) {
    return { ok: true, fields: null };
  }
  if (!Array.isArray(rawFields)) {
    return { ok: false, error: 'Invalid fields: expected an array of field names or null.' };
  }
  if (rawFields.some((field) => typeof field !== 'string')) {
    return { ok: false, error: 'Invalid fields: every entry must be a string.' };
  }

  const fields = [...new Set(rawFields as string[])];
  if (fields.length === 0) {
    return { ok: false, error: 'Invalid fields: expected at least one field name.' };
  }

  const catalog = await loadEsiCatalog();
  const operation = catalog.get(operationName);
  const allowedFields = operation?.responseFields ?? null;
  if (!allowedFields || allowedFields.length === 0) {
    return { ok: false, error: `Operation ${operationName} does not support field projection.` };
  }

  const allowedFieldSet = new Set(allowedFields);
  const invalidFields = fields.filter((field) => !allowedFieldSet.has(field));
  if (invalidFields.length > 0) {
    return {
      ok: false,
      error: `Invalid fields for ${operationName}: ${invalidFields.join(', ')}. Allowed fields: ${allowedFields.join(', ')}`,
    };
  }

  return { ok: true, fields };
}

function pickFields(item: unknown, fields: Set<string>): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in record) {
      result[key] = record[key];
    }
  }
  return result;
}

/**
 * Auto-strip response fields whose value is constant across all rows
 * AND matches a request parameter value. These are pure waste —
 * the caller already knows the value from the request args.
 */
async function executeBatchMarketPrices(
  db: Db,
  args: Record<string, unknown>,
  ctx: UserContext,
): Promise<unknown> {
  const regionId = Number(args.region_id ?? 10000002);
  const typeIds = Array.isArray(args.type_ids)
    ? args.type_ids.filter((v): v is number => typeof v === 'number')
    : [];

  if (typeIds.length === 0) {
    return { ok: false, error: 'type_ids must be a non-empty array of integers' };
  }
  if (typeIds.length > 30) {
    return { ok: false, error: 'Maximum 30 type_ids per batch' };
  }

  console.log('[batch_market] region=%d types=%d ids=%j', regionId, typeIds.length, typeIds);

  type OrderData = { price: number; volume_remain: number; is_buy_order: boolean };

  const results = await Promise.all(
    typeIds.map(async (typeId) => {
      const esiResult = await callEsiOperation<OrderData[]>(
        db,
        'get_markets_region_id_orders',
        { region_id: regionId, order_type: 'all', type_id: typeId },
        ctx,
      );
      if (!esiResult.ok || !Array.isArray(esiResult.data)) {
        return { type_id: typeId, error: !esiResult.ok ? esiResult.error : 'failed' };
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

  const totalChars = JSON.stringify(results).length;
  console.log('[batch_market] done items=%d result=%d chars', results.length, totalChars);

  return { ok: true, prices: results };
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
  let userProfile = readUserProfile(db, ctx);

  // Guard: if character is linked but profile file is missing, try to refresh it
  if (linked && !userProfile) {
    const PROFILE_GUARD_TIMEOUT_MS = 10_000;
    try {
      const result = await Promise.race([
        refreshUserProfile(db, ctx),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PROFILE_GUARD_TIMEOUT_MS)),
      ]);
      if (result && result.ok) {
        userProfile = readUserProfile(db, ctx);
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
  await runPreTurnCompact(db, threadId);

  const summary = getThreadSummary(db, threadId);
  const promptMode = isSimpleStaticAggregateCountGoal(userText) ? 'static_aggregate' : 'full';

  const developerPrompt = buildDeveloperPrompt(
    {
      authenticated: Boolean(linked),
      characterId: linked?.characterId ?? null,
      characterName: linked?.characterName ?? null,
      grantedScopes: linked?.scopes ?? [],
    },
    summary,
    userProfile,
    liveContext?.summary ?? null,
    promptMode,
  );

  const result = await runNativeAgentLoop(db, threadId, ctx, userText, developerPrompt);

  // Track cumulative token usage for compaction trigger.
  // Use peakInputTokens (max of single iteration) — reflects actual context size.
  // Summing across iterations double-counts because each iteration resends instructions+tools.
  db.prepare(
    'UPDATE agent_threads SET total_tokens = COALESCE(total_tokens, 0) + ? WHERE thread_id = ?'
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
      parts.push(`Корабль: ${shipResult.data.ship_name} (${shipType}), type_id=${shipResult.data.ship_type_id}`);
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
      json_extract(s.data_json, '$.security') AS security,
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

async function runNativeAgentLoop(
  db: Db,
  threadId: string,
  ctx: UserContext,
  goal: string,
  developerPrompt: string,
): Promise<AgentResult> {
  const chatId = ctx.chatId ?? ctx.userId;
  const requestId = createRequestId();
  const tools = await buildNativeAgentTools(
    isSimpleStaticAggregateCountGoal(goal) ? 'static_aggregate' : 'full',
  );
  const webSearchState = createWebSearchState();

  const continuation = planConversationContinuation(db, threadId);
  let pendingItems: NativeInputItem[] = continuation.items;
  let previousResponseId: string | null = continuation.previousResponseId;
  console.log(
    '[executor] context: mode=%s items=%d prevId=%s',
    continuation.mode,
    continuation.items.length,
    continuation.previousResponseId ?? 'none',
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
  let totalReasoningTokens = 0;
  /** Peak input tokens in a single iteration — reflects actual context size for compaction. */
  let peakInputTokens = 0;
  let toolStateRecoveryCount = 0;
  const MAX_TOOL_STATE_RECOVERIES = 3;
  let usedMidTurnCompact = false;

  console.log('[executor] === NEW REQUEST chat=%d thread=%s goal="%s" ===', chatId, threadId.slice(0, 12), goal.slice(0, 80));

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    let response;
    try {
      response = await createNativeResponse({
        instructions: developerPrompt,
        items: pendingItems,
        previousResponseId,
        promptCacheKey: threadId,
        tools,
        parallelToolCalls: true,
        truncation: 'auto',
        contextManagement,
        chatId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        shouldUseToolStateRecovery(message, toolStateRecoveryCount >= MAX_TOOL_STATE_RECOVERIES,previousResponseId, pendingItems)
      ) {
        toolStateRecoveryCount += 1;
        previousResponseId = null;
        pendingItems = buildToolStateRecoveryContext(db, threadId);
        saveLastResponseId(db, threadId, null);
        console.warn('[executor] tool state lost, switching to cold recovery context: %s', message);
        continue;
      }
      throw error;
    }

    // Track token usage
    if (response.usage) {
      totalInputTokens += response.usage.input;
      totalOutputTokens += response.usage.output;
      totalCachedTokens += response.usage.cached;
      totalReasoningTokens += response.usage.reasoning;
      if (response.usage.input > peakInputTokens) peakInputTokens = response.usage.input;
      console.log('[executor] iter=%d tokens: in=%d out=%d cached=%d reasoning=%d',
        iteration, response.usage.input, response.usage.output, response.usage.cached, response.usage.reasoning);
    }

    // Silent context loss detection: if we are in warm mode (prevId set) on the first
    // iteration and the API returns cached=0, the previous response chain is gone.
    // Fall back to cold mode so the model sees full message history from DB.
    if (
      iteration === 0 &&
      previousResponseId &&
      response.usage &&
      response.usage.cached === 0 &&
      !response.error
    ) {
      console.warn('[executor] silent context loss detected: warm mode with cached=0, falling back to cold recovery');
      totalInputTokens = 0;
      totalOutputTokens = 0;
      totalCachedTokens = 0;
      totalReasoningTokens = 0;
      peakInputTokens = 0;
      previousResponseId = null;
      pendingItems = buildSmartContext(db, threadId);
      saveLastResponseId(db, threadId, null);
      continue;
    }

    // --- Codex-style mid-turn compaction ---
    // After each sampling request, if input tokens >= autoCompactLimit AND model
    // needs follow-up (tool calls), compact and continue the loop.
    if (
      response.usage && needsMidTurnCompaction(response.usage.input) &&
      iteration > 0 && !usedMidTurnCompact
    ) {
      const toolCalls = extractFunctionCalls(response.output);
      if (toolCalls.length > 0) {
        console.log('[executor] mid-turn compaction: input=%d >= autoCompactLimit at iteration=%d',
          response.usage.input, iteration);
        usedMidTurnCompact = true;
        try {
          await runMidTurnCompact(db, threadId);
          previousResponseId = null;
          pendingItems = buildSmartContext(db, threadId);
          pendingItems.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '[system] Контекст был сжат из-за размера. Продолжай выполнение задачи, используя сводку выше. Если нужные данные уже есть в сводке — используй их, не вызывай tools повторно.' }],
          } as NativeInputItem);
          continue;
        } catch (compactError) {
          console.error('[executor] mid-turn compaction failed:', compactError);
          // Continue without compaction — truncation='auto' handles overflow
        }
      }
    }

    if (response.error) {
      if (
        shouldUseToolStateRecovery(response.error.message, toolStateRecoveryCount >= MAX_TOOL_STATE_RECOVERIES,previousResponseId, pendingItems)
      ) {
        toolStateRecoveryCount += 1;
        previousResponseId = null;
        pendingItems = buildToolStateRecoveryContext(db, threadId);
        saveLastResponseId(db, threadId, null);
        console.warn('[executor] tool state lost in response payload, switching to cold recovery context: %s', response.error.message);
        continue;
      }
      console.error('[executor] model error:', response.error.message);
      const message = 'Сервис модели временно недоступен. Попробуй ещё раз.';
      storeAssistantMessage(db, threadId, message);
      saveLastResponseId(db, threadId, null);
      console.log('[executor] === DONE (error) total_in=%d total_out=%d total_cached=%d total_reasoning=%d ===',
        totalInputTokens, totalOutputTokens, totalCachedTokens, totalReasoningTokens);
      return { text: message, peakInputTokens };
    }

    if (response.toolSearchPaths.length > 0) {
      console.log('[executor] iteration=%d toolSearchPaths=%j', iteration, response.toolSearchPaths);
    }

    const toolCalls = extractFunctionCalls(response.output);

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
      if (response.outputText.trim()) {
        storeAssistantMessage(db, threadId, response.outputText);
        saveLastResponseId(db, threadId, response.id);
        console.log('[executor] === DONE (text) iterations=%d total_in=%d total_out=%d total_cached=%d total_reasoning=%d answer=%d chars ===',
          iteration + 1, totalInputTokens, totalOutputTokens, totalCachedTokens, totalReasoningTokens, response.outputText.length);
        return { text: response.outputText, peakInputTokens };
      }
      if (response.toolSearchPaths.length > 0 && response.id) {
        previousResponseId = response.id;
        pendingItems = [];
        continue;
      }
      const outputTypes = response.output.map((item) => String(item.type ?? 'unknown'));
      const eventTypes = [...new Set(response.rawEvents.map((evt) => evt.event))];
      console.log('[executor] empty response details id=%s outputTypes=%j events=%j',
        response.id ?? 'none', outputTypes, eventTypes);
      if (response.id && emptyResponseRetries < 2) {
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

    const policies = await Promise.all(toolCalls.map((toolCall) => getToolPolicy(toolCall.name)));
    const argsList = toolCalls.map((toolCall) => safeParseArguments(toolCall.argumentsText));
    const results = policies.every((policy) => policy === 'read')
      ? await Promise.all(toolCalls.map((toolCall, index) =>
          executeToolCall(db, requestId, goal, ctx, toolCall.name, argsList[index] ?? {}, webSearchState),
        ))
      : await executeToolCallsSequentially(db, requestId, goal, ctx, toolCalls, argsList, webSearchState);

    const outputs: Array<{ callId: string; output: string }> = [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      const args = argsList[index] ?? {};
      const result = results[index];
      db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(
        threadId,
        'tool',
        JSON.stringify({
          tool: toolCall.name,
          args,
          result: compactToolResult(result),
        }),
      );
      const rawOutput = JSON.stringify(result);
      const truncatedOutput = truncateToolOutput(rawOutput);
      console.log('[tool] %s args=%s raw=%d chars sent=%d chars',
        toolCall.name, JSON.stringify(args).slice(0, 120), rawOutput.length, truncatedOutput.length);
      outputs.push({
        callId: toolCall.callId,
        output: truncatedOutput,
      });
    }

    const deterministicAnswer = tryBuildDeterministicCountAnswer(goal, toolCalls, results);
    if (deterministicAnswer) {
      storeAssistantMessage(db, threadId, deterministicAnswer);
      saveLastResponseId(db, threadId, null);
      console.log('[executor] === DONE (deterministic-count) iterations=%d total_in=%d total_out=%d total_cached=%d total_reasoning=%d answer=%d chars ===',
        iteration + 1, totalInputTokens, totalOutputTokens, totalCachedTokens, totalReasoningTokens, deterministicAnswer.length);
      return { text: deterministicAnswer, peakInputTokens };
    }

    // Route shortcircuit: if plan_route returned formatted_summary, output it directly.
    // Saves one model iteration and guarantees the full danger report is shown.
    const hasRouteCall = toolCalls.some((tc) => tc.name === 'plan_route');
    if (hasRouteCall) {
      const routeIdx = toolCalls.findIndex((tc) => tc.name === 'plan_route');
      const routeResult = results[routeIdx] as Record<string, unknown> | null;
      const summary = routeResult?.formatted_summary;
      if (typeof summary === 'string' && summary.length > 50) {
        storeAssistantMessage(db, threadId, summary);
        // Save null — the response has a dangling function_call (plan_route) without tool output,
        // so continuing from this prevId would cause "No tool output found" API error.
        saveLastResponseId(db, threadId, null);
        console.log('[executor] === DONE (route-shortcircuit) iterations=%d total_in=%d total_out=%d total_cached=%d total_reasoning=%d answer=%d chars ===',
          iteration + 1, totalInputTokens, totalOutputTokens, totalCachedTokens, totalReasoningTokens, summary.length);
        return { text: summary, peakInputTokens };
      }
    }

    if (!response.id) {
      const message = 'Не удалось продолжить tool loop: proxy не вернул response id.';
      storeAssistantMessage(db, threadId, message);
      saveLastResponseId(db, threadId, null);
      return { text: message, peakInputTokens };
    }

    previousResponseId = response.id;
    pendingItems = buildFunctionCallOutputs(outputs);

    // Anti-loop: if same tool called N+ times in a row, inject a nudge
    if (consecutiveSameToolCount >= MAX_CONSECUTIVE_SAME_TOOL) {
      console.log('[executor] anti-loop: %s called %d times consecutively, injecting nudge', lastToolName, consecutiveSameToolCount);
      pendingItems.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[system] Ты вызывал один и тот же tool несколько раз подряд. Переходи к следующему шагу: используй собранные данные для ответа или вызови другой tool (get_markets_region_id_orders, plan_route, и т.д.).' }],
      } as NativeInputItem);
      consecutiveSameToolCount = 0;
    }
  }

  const timeout = 'Остановился после слишком большого числа tool iterations.';
  storeAssistantMessage(db, threadId, timeout);
  saveLastResponseId(db, threadId, null);
  console.log('[executor] === DONE (timeout) iterations=%d total_in=%d total_out=%d total_cached=%d total_reasoning=%d ===',
    MAX_TOOL_ITERATIONS, totalInputTokens, totalOutputTokens, totalCachedTokens, totalReasoningTokens);
  return { text: timeout, peakInputTokens };
}

async function executeToolCallsSequentially(
  db: Db,
  requestId: string,
  goal: string,
  ctx: UserContext,
  toolCalls: Array<{ callId: string; name: string; argumentsText: string }>,
  argsList: Array<Record<string, unknown>>,
  webSearchState: WebSearchState,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    results.push(await executeToolCall(
      db, requestId, goal, ctx, toolCalls[index].name, argsList[index] ?? {}, webSearchState,
    ));
  }
  return results;
}

async function executeToolCall(
  db: Db,
  requestId: string,
  goal: string,
  ctx: UserContext,
  name: string,
  args: Record<string, unknown>,
  webSearchState: WebSearchState,
): Promise<unknown> {
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
    return await executeBatchMarketPrices(db, args, ctx);
  }

  if (isHeartbeatConfigTool(name)) {
    return executeHeartbeatConfig(db, ctx, {
      action: String(args.action ?? 'list'),
      interval_seconds: typeof args.interval_seconds === 'number' ? args.interval_seconds : undefined,
      check: typeof args.check === 'string' ? args.check : undefined,
    } as HeartbeatConfigArgs);
  }

  if (name === 'plan_route') {
    const routeArgs: PlanRouteArgs = {
      origin: String(args.origin ?? ''),
      destination: String(args.destination ?? ''),
      set_autopilot: args.set_autopilot !== false,
      avoid: Array.isArray(args.avoid) ? args.avoid.filter((v): v is number => typeof v === 'number') : [],
      prefer: args.prefer === 'shortest' || args.prefer === 'insecure' ? args.prefer : 'secure',
    };
    const routeResult = await planRoute(db, routeArgs, ctx);
    console.log('[plan_route] origin=%s dest=%s routes=%d autopilot=%s error=%s',
      routeResult.origin?.name ?? '?', routeResult.destination?.name ?? '?',
      routeResult.routes.length, routeResult.autopilot_set, routeResult.error ?? 'none');
    for (const r of routeResult.routes) {
      console.log('[plan_route]   %s: %d jumps, kills_1h=%d, danger_systems=%d, safe=%d, value=%dM',
        r.flag, r.jumps, r.total_kills_1h, r.danger_systems.length, r.safe_count, r.total_value_m);
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
        total_value_m: route.total_value_m,
        systems: route.systems,
        danger_systems: route.danger_systems.map((danger) => ({
          name: danger.name,
          sec: danger.sec,
          kills_1h: danger.kills_1h,
          pvp: danger.pvp,
          npc: danger.npc,
          total_value_m: danger.total_value_m,
        })),
      })),
    };
  }

  if (isEveKillToolName(name)) {
    webSearchState.eveKillCallCount += 1;
    if (webSearchState.eveKillCallCount > MAX_EVE_KILL_CALLS_PER_TURN) {
      console.log('[eve-kill] blocked: limit %d reached (call #%d)', MAX_EVE_KILL_CALLS_PER_TURN, webSearchState.eveKillCallCount);
      return { ok: false, error: `Лимит eve-kill (${MAX_EVE_KILL_CALLS_PER_TURN}) на один ответ исчерпан. Анализируй уже собранные данные.`, blocked: true };
    }
    const result = await executeEveKillTool(db, name as EveKillToolName, args);
    console.log('[eve-kill] %s completed (call #%d)', name, webSearchState.eveKillCallCount);
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

const WEB_SEARCH_TIMEOUT_MS = 8000;

export type WebSearchState = {
  normalizedQueries: string[];
  eveKillCallCount: number;
};

export function createWebSearchState(): WebSearchState {
  return { normalizedQueries: [], eveKillCallCount: 0 };
}

export function registerWebSearch(
  state: WebSearchState,
  query: string,
): { allowed: boolean; reason: string | null } {
  const normalized = normalizeWebSearchQuery(query);
  const prior = state.normalizedQueries;

  if (prior.includes(normalized)) {
    return {
      allowed: false,
      reason: 'Повторный web_search с тем же запросом запрещён. Используй уже найденные источники и сформируй ответ.',
    };
  }

  const hasSimilarPrior = prior.some((entry) => areSimilarWebSearchQueries(entry, normalized));
  if (prior.length >= MAX_WEB_SEARCHES_PER_TURN || (prior.length >= 2 && hasSimilarPrior)) {
    return {
      allowed: false,
      reason: 'Достигнут лимит web_search на один ответ. После 1-2 поисков нужно ответить по найденным данным или явно указать, чего не хватило.',
    };
  }

  state.normalizedQueries.push(normalized);
  return { allowed: true, reason: null };
}

export function normalizeWebSearchQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/site:[^\s]+/g, ' ')
    .replace(/["'`()[\],.:;!?/+_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function areSimilarWebSearchQueries(left: string, right: string): boolean {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return left === right;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const similarity = overlap / Math.min(leftTokens.size, rightTokens.size);
  return similarity >= 0.6;
}

async function executeWebSearch(query: string): Promise<{ ok: boolean; results: Array<{ title: string; url: string; snippet: string; source: string }>; error: string | null }> {
  if (!query.trim()) return { ok: false, results: [], error: 'Empty query' };

  const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];
  const errors: string[] = [];

  const tavilyKey = config.tavily?.apiKey;
  const searches = [
    ...(tavilyKey ? [fetchTavily(query, tavilyKey)] : []),
    fetchEveUni(query),
  ];

  const settled = await Promise.allSettled(searches);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
    else errors.push(String(s.reason));
  }

  // Dedupe by URL
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const key = r.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  return { ok: deduped.length > 0, results: deduped, error: errors.length > 0 ? errors.join('; ') : null };
}

async function fetchTavily(query: string, apiKey: string): Promise<Array<{ title: string; url: string; snippet: string; source: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic: 'general',
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data?.results ?? [])
      .filter((r) => r.title && r.url)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: (r.content ?? '').slice(0, 300),
        source: 'Tavily',
      }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEveUni(query: string): Promise<Array<{ title: string; url: string; snippet: string; source: string }>> {
  const url = new URL('https://wiki.eveuniversity.org/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  url.searchParams.set('srlimit', '5');
  url.searchParams.set('srsearch', query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal, headers: { 'User-Agent': 'EVEAIBOT/1.0 (+https://eveonline-ai.ru/)' } });
    if (!res.ok) return [];
    const data = await res.json() as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
    return (data?.query?.search ?? [])
      .filter((i) => i.title)
      .map((i) => ({
        title: i.title!,
        url: `https://wiki.eveuniversity.org/${encodeURIComponent(i.title!.replace(/ /g, '_'))}`,
        snippet: (i.snippet ?? '').replace(/<[^>]*>/g, '').slice(0, 300),
        source: 'EVE University Wiki',
      }));
  } finally {
    clearTimeout(timer);
  }
}

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
      text: '[system] Proxy-side tool state was lost after tool execution. Use the recovered tool results above to answer if they are sufficient. If more work is still required, continue from this cold context and avoid repeating the same tool call loop.',
    }],
  });
  return items;
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
  if (!message.includes(TOOL_STATE_MISMATCH_FRAGMENT)) return false;
  return pendingItems.some((item) => item.type === 'function_call_output');
}

/** Errors that indicate a broken continuation chain — recoverable via cold restart. */
const WS_RETRIABLE_PATTERNS = [
  'not found',                          // "Previous response with id ... not found"
  'ws_transport_error',                 // proxy WS transport failure
  'ws closed',                          // server closed WebSocket
  'ws timeout',                         // idle timeout
  'ws idle timeout',                    // per-frame idle timeout
  'ws error',                           // generic WS error
  'connection_limit_reached',           // server WS connection limit (codex-specific)
  'connection reset',                   // TCP reset
  'socket hang up',                     // Node undici socket error
  'econnrefused',                       // connection refused
  'terminated',                         // undici terminated
];

function isWsRetriableError(message: string): boolean {
  const lower = message.toLowerCase();
  return WS_RETRIABLE_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function shouldUseToolStateRecovery(
  message: string,
  exhausted: boolean,
  previousResponseId: string | null,
  pendingItems: NativeInputItem[],
): boolean {
  if (exhausted) return false;
  if (shouldRecoverFromToolStateMismatch(message, previousResponseId, pendingItems)) return true;
  // Also recover from WS transport errors (broken continuation chain)
  if (previousResponseId && isWsRetriableError(message)) return true;
  return false;
}

type StaticAggregateObjectKind = 'constellations' | 'systems' | 'planets' | 'moons' | 'asteroid_belts' | 'stations' | 'stargates';
type StaticAggregateTargetKind = 'system' | 'constellation' | 'region';

type StaticAggregateIntent = {
  objectKind: StaticAggregateObjectKind;
  targetKind: StaticAggregateTargetKind;
  targetName: string;
};

export function deriveLiveContextNeeds(goal: string): LiveContextNeeds {
  const normalized = goal.toLowerCase();
  const ship = /(мой корабль|мой шип|на чем я|на чём я|какой у меня корабль|какой у меня шип|my ship|what ship|летаю)/u.test(normalized);
  const location = ship
    || /\b(где я|мой регион|моя система|мо[её] созвездие|my region|my system|my constellation|current region|current system|current constellation|отсюда|from here|here|здесь)\b/u.test(normalized)
    || /\b(маршрут|route|автопилот|autopilot)\b/u.test(normalized)
    || /в мо[её]м регионе/u.test(normalized)
    || /в мо[её]й системе/u.test(normalized)
    || /в мо[её]м созвездии/u.test(normalized)
    || /в текущ(?:ем|ей)\s+(?:регионе|системе|созвездии)/u.test(normalized);

  return { location, ship };
}

function isSimpleStaticAggregateCountGoal(goal: string): boolean {
  return detectStaticAggregateObjectKind(goal) !== null;
}

function extractStaticAggregateObjectScope(normalized: string): string {
  return normalized
    .replace(/^(?:сколько|посчитай|подсчитай|количеств[оа]|how many|count|number of)\s+/u, '')
    .replace(/\s+(?:are\s+)?(?:в|in)\s+.+$/u, '')
    .trim();
}

function detectStaticAggregateObjectKind(goal: string): StaticAggregateObjectKind | null {
  const normalized = goal.toLowerCase();
  if (!/(сколько|посчитай|подсчитай|количеств[оа]|how many|count|number of)/u.test(normalized)) {
    return null;
  }
  const objectScope = extractStaticAggregateObjectScope(normalized);
  if (!objectScope) return null;
  if (/\b(какие|какая|какой|где|почему|зачем|how|which|why|where|market|price|route|маршрут|цена|ордер|рынок)\b/u.test(objectScope)) {
    return null;
  }
  if (/\sи\s/u.test(objectScope)) {
    return null;
  }

  const matches: StaticAggregateObjectKind[] = [];
  if (/созвезд/u.test(objectScope) || /\bconstellation(s)?\b/u.test(objectScope)) matches.push('constellations');
  if (/систем/u.test(objectScope) || /\bsystem(s)?\b/u.test(objectScope)) matches.push('systems');
  if (/планет/u.test(objectScope) || /\bplanet(s)?\b/u.test(objectScope)) matches.push('planets');
  if (/лун/u.test(objectScope) || /\bmoon(s)?\b/u.test(objectScope)) matches.push('moons');
  if (/астероидн(?:ый|ых)?\s+пояс/u.test(objectScope) || /\basteroid belt(s)?\b/u.test(objectScope)) matches.push('asteroid_belts');
  if (/станци/u.test(objectScope) || /\bstation(s)?\b/u.test(objectScope)) matches.push('stations');
  if (/врат/u.test(objectScope) || /\bstargate(s)?\b/u.test(objectScope)) matches.push('stargates');

  return matches.length === 1 ? matches[0] : null;
}

function normalizeStaticAggregateTargetName(value: string): string {
  return value
    .trim()
    .replace(/^[«"'`]+/u, '')
    .replace(/[»"'`?!.,:;]+$/u, '')
    .trim();
}

function resolveBareStaticAggregateTarget(
  db: Db,
  objectKind: StaticAggregateObjectKind,
  targetName: string,
): { targetKind: StaticAggregateTargetKind; targetName: string } | null {
  const canonicalName = normalizeStaticAggregateTargetName(targetName);
  if (!canonicalName) return null;

  const candidateKinds: StaticAggregateTargetKind[] = objectKind === 'constellations'
    ? ['region']
    : objectKind === 'systems'
      ? ['constellation', 'region']
      : ['system', 'constellation', 'region'];

  for (const targetKind of candidateKinds) {
    if (targetKind === 'system') {
      const row = db.prepare('SELECT name FROM sde_systems WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(canonicalName) as { name: string } | undefined;
      if (row) return { targetKind, targetName: row.name };
      continue;
    }
    if (targetKind === 'constellation') {
      const row = db.prepare('SELECT name FROM sde_constellations WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(canonicalName) as { name: string } | undefined;
      if (row) return { targetKind, targetName: row.name };
      continue;
    }
    const row = db.prepare('SELECT name FROM sde_regions WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(canonicalName) as { name: string } | undefined;
    if (row) return { targetKind, targetName: row.name };
  }

  return null;
}

function parseStaticAggregateIntent(
  db: Db,
  goal: string,
  locationContext: SystemLocationContext | null,
): StaticAggregateIntent | null {
  const objectKind = detectStaticAggregateObjectKind(goal);
  if (!objectKind) return null;

  const normalized = goal.toLowerCase();
  if (/в мо[её]м регионе/u.test(normalized) && locationContext?.regionName) {
    return { objectKind, targetKind: 'region', targetName: locationContext.regionName };
  }
  if (/в мо[её]й системе/u.test(normalized) && locationContext?.systemName) {
    return { objectKind, targetKind: 'system', targetName: locationContext.systemName };
  }
  if (/в мо[её]м созвездии/u.test(normalized) && locationContext?.constellationName) {
    return { objectKind, targetKind: 'constellation', targetName: locationContext.constellationName };
  }
  if (/\b(current region|текущ(?:ем|ий)\s+регион(?:е)?)\b/u.test(normalized) && locationContext?.regionName) {
    return { objectKind, targetKind: 'region', targetName: locationContext.regionName };
  }
  if (/\b(current system|текущ(?:ей|ая)\s+систем(?:е|а)|here|здесь)\b/u.test(normalized) && locationContext?.systemName) {
    return { objectKind, targetKind: 'system', targetName: locationContext.systemName };
  }
  if (/\b(current constellation|текущ(?:ем|ее)\s+созвездии)\b/u.test(normalized) && locationContext?.constellationName) {
    return { objectKind, targetKind: 'constellation', targetName: locationContext.constellationName };
  }

  const regionMatch = /(?:^|\s)в\s+регионе?\s+(.+)$/iu.exec(goal);
  if (regionMatch) {
    const targetName = normalizeStaticAggregateTargetName(regionMatch[1]);
    if (targetName) return { objectKind, targetKind: 'region', targetName };
  }
  const regionMatchEn = /(?:^|\s)in\s+region\s+(.+)$/iu.exec(goal);
  if (regionMatchEn) {
    const targetName = normalizeStaticAggregateTargetName(regionMatchEn[1]);
    if (targetName) return { objectKind, targetKind: 'region', targetName };
  }

  const systemMatch = /(?:^|\s)в\s+систем[еуы]?\s+(.+)$/iu.exec(goal);
  if (systemMatch) {
    const targetName = normalizeStaticAggregateTargetName(systemMatch[1]);
    if (targetName) return { objectKind, targetKind: 'system', targetName };
  }
  const systemMatchEn = /(?:^|\s)in\s+system\s+(.+)$/iu.exec(goal);
  if (systemMatchEn) {
    const targetName = normalizeStaticAggregateTargetName(systemMatchEn[1]);
    if (targetName) return { objectKind, targetKind: 'system', targetName };
  }

  const constellationMatch = /(?:^|\s)в\s+созвездии\s+(.+)$/iu.exec(goal);
  if (constellationMatch) {
    const targetName = normalizeStaticAggregateTargetName(constellationMatch[1]);
    if (targetName) return { objectKind, targetKind: 'constellation', targetName };
  }
  const constellationMatchEn = /(?:^|\s)in\s+constellation\s+(.+)$/iu.exec(goal);
  if (constellationMatchEn) {
    const targetName = normalizeStaticAggregateTargetName(constellationMatchEn[1]);
    if (targetName) return { objectKind, targetKind: 'constellation', targetName };
  }

  const bareTargetMatch = /(?:^|\s)в\s+(.+)$/iu.exec(goal);
  const targetFragment = bareTargetMatch?.[1] ?? /\bin\s+(.+)$/iu.exec(goal)?.[1];
  if (!targetFragment) return null;
  const resolvedTarget = resolveBareStaticAggregateTarget(db, objectKind, targetFragment);
  if (!resolvedTarget) return null;

  return {
    objectKind,
    targetKind: resolvedTarget.targetKind,
    targetName: resolvedTarget.targetName,
  };
}

type DeterministicCountToolCall = { name: string };

function tryBuildDeterministicCountAnswer(
  goal: string,
  toolCalls: DeterministicCountToolCall[],
  results: unknown[],
): string | null {
  if (!isSimpleStaticAggregateCountGoal(goal)) return null;
  if (toolCalls.length !== results.length) return null;

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolName = toolCalls[index].name;
    const result = results[index];
    if (toolName === 'count_universe_objects') {
      const answer = formatUniverseCountAnswer(result);
      if (answer) return answer;
    }
  }
  return null;
}

function tryHandleStaticAggregateFastPath(
  db: Db,
  threadId: string,
  goal: string,
  locationContext: SystemLocationContext | null,
): string | null {
  const intent = parseStaticAggregateIntent(db, goal, locationContext);
  if (!intent) return null;

  const result = executeUniverseObjectCount(db, {
    target_kind: intent.targetKind,
    target_name: intent.targetName,
    object_kind: intent.objectKind,
  });

  const answer = formatUniverseCountAnswer(result);
  if (!answer) return null;

  storeAssistantMessage(db, threadId, answer);
  saveLastResponseId(db, threadId, null);
  console.log('[executor] === DONE (static-aggregate-fast-path) object=%s target=%s:%s answer=%d chars ===',
    intent.objectKind, intent.targetKind, intent.targetName, answer.length);
  return answer;
}

function formatUniverseCountAnswer(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (record.ok !== true || typeof record.target_kind !== 'string' || typeof record.target_name !== 'string') {
    return null;
  }
  if (typeof record.object_kind !== 'string' || typeof record.count !== 'number') {
    return null;
  }

  const nounForms = getUniverseCountNounForms(record.object_kind);
  if (!nounForms) return null;
  const targetLabel = record.target_kind === 'system'
    ? 'системе'
    : record.target_kind === 'constellation'
      ? 'созвездии'
      : 'регионе';

  const base = `В ${targetLabel} **${record.target_name}** — **${record.count} ${formatCountNoun(record.count, nounForms)}**.`;

  // Enriched moon answer: append planet_count and system_count extras (region-level)
  if (record.object_kind === 'moons') {
    const extras: string[] = [];
    if (typeof record.system_count === 'number') {
      extras.push(`систем: **${record.system_count}**`);
    }
    if (typeof record.planet_count === 'number') {
      extras.push(`планет: **${record.planet_count}**`);
    }
    if (extras.length > 0) {
      return `${base}\n\nДополнительно:\n- ${extras.join('\n- ')}`;
    }
  }

  return base;
}

function getUniverseCountNounForms(objectKind: string): [string, string, string] | null {
  switch (objectKind) {
    case 'constellations':
      return ['созвездие', 'созвездия', 'созвездий'];
    case 'systems':
      return ['система', 'системы', 'систем'];
    case 'planets':
      return ['планета', 'планеты', 'планет'];
    case 'moons':
      return ['луна', 'луны', 'лун'];
    case 'asteroid_belts':
      return ['астероидный пояс', 'астероидных пояса', 'астероидных поясов'];
    case 'stations':
      return ['станция', 'станции', 'станций'];
    case 'stargates':
      return ['старгейт', 'старгейта', 'старгейтов'];
    default:
      return null;
  }
}

function formatCountNoun(count: number, [one, few, many]: [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

type ConversationContinuation = {
  mode: 'warm' | 'cold';
  items: NativeInputItem[];
  previousResponseId: string | null;
};

function planConversationContinuation(db: Db, threadId: string): ConversationContinuation {
  const row = db.prepare(
    `SELECT
       t.last_response_id AS last_response_id,
       (SELECT content FROM messages WHERE thread_id = t.thread_id AND role = 'user' ORDER BY id DESC LIMIT 1) AS latest_user_content,
       (SELECT created_at FROM messages WHERE thread_id = t.thread_id AND role = 'assistant' ORDER BY id DESC LIMIT 1) AS latest_assistant_at
     FROM agent_threads t
     WHERE t.thread_id = ?`
  ).get(threadId) as {
    last_response_id: string | null;
    latest_user_content: string | null;
    latest_assistant_at: string | null;
  } | undefined;

  if (
    row?.last_response_id
    && row.latest_user_content
    && isRecentSqliteTimestamp(row.latest_assistant_at, PREVIOUS_RESPONSE_MAX_AGE_MS)
  ) {
    return {
      mode: 'warm',
      items: [toNativeMessage(row.latest_user_content)],
      previousResponseId: row.last_response_id,
    };
  }

  return {
    mode: 'cold',
    items: buildSmartContext(db, threadId),
    previousResponseId: null,
  };
}

function saveLastResponseId(db: Db, threadId: string, responseId: string | null): void {
  db.prepare(
    "UPDATE agent_threads SET last_response_id = ?, updated_at = datetime('now') WHERE thread_id = ?"
  ).run(responseId, threadId);
}

function isRecentSqliteTimestamp(value: string | null, maxAgeMs: number): boolean {
  if (!value) return false;
  const millis = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(millis)) return false;
  return (Date.now() - millis) <= maxAgeMs;
}

export const __test__ = {
  buildSmartContext,
  buildToolStateRecoveryContext,
  buildRecentToolSummaryMessage,
  deriveLiveContextNeeds,
  resolveSystemLocationContext,
  shouldRecoverFromToolStateMismatch,
  shouldUseToolStateRecovery,
  isSimpleStaticAggregateCountGoal,
  detectStaticAggregateObjectKind,
  parseStaticAggregateIntent,
  tryBuildDeterministicCountAnswer,
  tryHandleStaticAggregateFastPath,
  formatCountNoun,
  planConversationContinuation,
  isRecentSqliteTimestamp,
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
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json;
  try {
    const parsed = JSON.parse(json) as unknown;

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
        return JSON.stringify(wrapperObj).slice(0, MAX_TOOL_OUTPUT_CHARS);
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
      return JSON.stringify(smallPayload);
    }
  } catch {
    // fall through
  }
  return JSON.stringify({
    truncated: true,
    total_chars: json.length,
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

function storeAssistantMessage(db: Db, threadId: string, content: string): void {
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'assistant', content);
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
