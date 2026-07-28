import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import type { UsageTokenCounts } from '../usage/pricing.js';
import type { UserContext } from '../auth/user-resolver.js';
import { executeBatchMarketPrices } from './executor.js';
import {
  buildFunctionCallOutputs,
  buildOrderedContinuationInputItems,
  createNativeResponse,
  extractFinalAssistantText,
  extractFunctionCalls,
  toNativeMessage,
  type NativeInputItem,
} from './native-responses.js';
import { EffectiveToolRegistry, validateEffectiveToolCalls } from './tool-registry.js';
import { buildMarketAiSearchTools, executeSdeSql, isBatchMarketTool, isSdeSqlTool } from './tools.js';
import { SDE_SCHEMA } from './tools/sde-schema.js';

/**
 * Лёгкий исполнитель для /api/web/market/ai-search: один запрос пользователя →
 * список подходящих type_id. По образцу runReadSubagent (read-subagents.ts),
 * но ещё жёстче по бюджету: до config.web.aiSearchMaxModelCalls вызовов модели
 * (дефолт 3 — до двух тул-раундов + финальный ответ; на последнем вызове тулы
 * не предлагаются, чтобы модель гарантированно отдала JSON, а не просила раунд,
 * на который бюджета нет), максимум
 * config.web.aiSearchMaxResults предметов, внешний таймаут через AbortSignal.
 * Тулы только публичные: sde_sql (статика) и batch_market_prices (публичные
 * цены ESI). Фан-аут ограничен листовым бюджетом MAX_TOOL_CALLS на весь поиск,
 * а сигнал таймаута прокинут в guard тулов — после отмены новые листы не
 * стартуют и не давят общий ESI-семафор чата.
 */

export const MARKET_AI_SEARCH_MAX_RESULTS = 20;
export const MARKET_AI_SEARCH_TIMEOUT_MS = 30_000;
/**
 * Суммарный листовой бюджет тул-вызовов на один поиск (как maxToolLeaves у
 * субагентов). Жёсткий guard, не качественный лимит: без него фан-аут
 * 16 вызовов × 30 type_id × 2 раунда давал ~960 ESI-обращений на запрос.
 */
export const MARKET_AI_SEARCH_MAX_TOOL_CALLS = 10;
const MAX_OUTPUT_TOKENS = 1_500;
const MAX_REASON_CHARS = 240;
const TOOL_BUDGET_ERROR = 'Tool call budget for this search is exhausted';

export type MarketAiSearchPick = {
  type_id: number;
  reason: string;
};

export type MarketAiSearchOutcome = {
  ok: boolean;
  picks: MarketAiSearchPick[];
  usage: UsageTokenCounts | null;
};

export type MarketAiSearchOptions = {
  signal?: AbortSignal;
  responseFactory?: typeof createNativeResponse;
};

function systemPrompt(maxResults: number): string {
  return `You are an item picker for the EVE Online market screen.
The user describes in natural language (Russian or English) what kind of items they need.
Find matching tradeable items using the tools, then answer ONLY with a JSON array — no prose, no markdown fences:
[{"type_id": 587, "reason": "one short sentence in the user's language explaining the fit"}]
Rules:
- type_id must come from sde_sql results (published items with a market group); never invent IDs.
- At most ${maxResults} entries, best matches first; an empty array when nothing fits.
- Use batch_market_prices when the request mentions price, budget, or "cheap/expensive".
- reason: one sentence max, no prices invented — only numbers seen in tool output.
<sde_schema>
${SDE_SCHEMA}
</sde_schema>`;
}

export async function runMarketAiSearch(
  db: Db,
  query: string,
  ctx: UserContext,
  regionId: number,
  options: MarketAiSearchOptions = {},
): Promise<MarketAiSearchOutcome> {
  const maxModelCalls = config.web.aiSearchMaxModelCalls;
  const maxResults = config.web.aiSearchMaxResults;
  const signal = options.signal ?? AbortSignal.timeout(config.web.aiSearchTimeoutMs);
  const responseFactory = options.responseFactory ?? createNativeResponse;
  const tools = buildMarketAiSearchTools();
  const registry = new EffectiveToolRegistry(tools);
  const seenCallIds = new Set<string>();
  const usageTotal = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
  let sawUsage = false;
  let toolCallsUsed = 0;
  let pendingItems: NativeInputItem[] = [
    toNativeMessage(`Trade region for price checks: ${regionId}. User request: ${query}`),
  ];

  const finish = (ok: boolean, picks: MarketAiSearchPick[]): MarketAiSearchOutcome => ({
    ok,
    picks,
    usage: sawUsage ? usageTotal : null,
  });

  // Деградации логируем с категорией: раньше эти пути были молчаливыми — роут
  // отдавал 503, а в журнале не было ни строки для диагностики.
  const fail = (category: string, detail?: string): MarketAiSearchOutcome => {
    console.warn(
      '[market-ai-search] search degraded category=%s%s',
      category,
      detail ? ` detail=${detail}` : '',
    );
    return finish(false, []);
  };

  for (let call = 0; call < maxModelCalls; call += 1) {
    if (signal.aborted) return fail('aborted');
    // Последний разрешённый вызов — без тулов: модель обязана собрать финальный
    // JSON из уже полученных данных, а не просить ещё один тул-раунд, на который
    // бюджета всё равно нет.
    const isFinalCall = call + 1 >= maxModelCalls;
    let response: Awaited<ReturnType<typeof createNativeResponse>>;
    try {
      response = await responseFactory({
        instructions: systemPrompt(maxResults),
        items: pendingItems,
        tools: isFinalCall ? [] : tools,
        parallelToolCalls: true,
        truncation: 'auto',
        reasoningEffort: 'low',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        preserveReasoning: false,
        streamToActivity: false,
        signal,
      });
    } catch (error) {
      // Переполнение очереди допуска, таймаут, сеть — детали провайдера не
      // наружу и не в Fastify-500: честная деградация, usage до броска сохранён.
      console.error(
        '[market-ai-search] model call failed category=model_failure detail=%s',
        error instanceof Error ? error.message : String(error),
      );
      return finish(false, []);
    }
    if (signal.aborted) return fail('aborted');
    if (response.usage) {
      sawUsage = true;
      usageTotal.input += response.usage.input;
      usageTotal.output += response.usage.output;
      usageTotal.cached += response.usage.cached;
      usageTotal.cacheWrite += response.usage.cacheWrite ?? 0;
      usageTotal.reasoning += response.usage.reasoning;
    }
    if (response.error || response.status !== 'completed') {
      return fail('provider_error', response.error ? String(response.error) : `status=${response.status}`);
    }

    const calls = extractFunctionCalls(response.output);
    const rawCallCount = response.output.filter((item) => item.type === 'function_call').length;
    if (rawCallCount !== calls.length) return fail('output_shape_mismatch');

    if (calls.length === 0) {
      const text = extractFinalAssistantText(response.output) ?? response.outputText;
      const picks = parsePicks(text, maxResults);
      return picks === null ? fail('unparseable_final_text') : finish(true, picks);
    }
    // Финальный текст обязателен: это последний разрешённый вызов модели. Тулов
    // на нём не предлагалось, так что вызовы здесь — мусорный выход модели.
    if (isFinalCall) return fail('tool_calls_on_final_call');

    const validation = validateEffectiveToolCalls(registry, calls, seenCallIds);
    if (!validation.ok) return fail('invalid_tool_calls');
    for (const toolCall of calls) seenCallIds.add(toolCall.callId);

    let outputs: Array<{ callId: string; output: string }>;
    if (validation.rejections.some((entry) => entry !== undefined)) {
      outputs = calls.map((toolCall, index) => ({
        callId: toolCall.callId,
        output: JSON.stringify(validation.rejections[index]),
      }));
    } else {
      // Отмена между ответом модели и диспатчем: новые листы не стартуют.
      if (signal.aborted) return fail('aborted');
      const remaining = Math.max(0, MARKET_AI_SEARCH_MAX_TOOL_CALLS - toolCallsUsed);
      const executable = calls.slice(0, remaining);
      toolCallsUsed += executable.length;
      const executed = executable.length > 0
        ? await dispatchCalls(db, ctx, executable, validation.args, signal)
        : [];
      outputs = [
        ...executed,
        ...calls.slice(executable.length).map((toolCall) => ({
          callId: toolCall.callId,
          output: JSON.stringify({ ok: false, error: TOOL_BUDGET_ERROR }),
        })),
      ];
    }

    pendingItems = [
      ...pendingItems,
      ...buildOrderedContinuationInputItems(response.output, false),
      ...buildFunctionCallOutputs(outputs),
    ];
  }

  return finish(false, []);
}

async function dispatchCalls(
  db: Db,
  ctx: UserContext,
  calls: Array<{ callId: string; name: string }>,
  args: Array<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Array<{ callId: string; output: string }>> {
  const settled = await Promise.allSettled(calls.map(async (toolCall, index) => {
    const toolArgs = args[index] ?? {};
    if (isSdeSqlTool(toolCall.name)) {
      return executeSdeSql(db, typeof toolArgs.sql === 'string' ? toolArgs.sql : '');
    }
    if (isBatchMarketTool(toolCall.name)) {
      return executeBatchMarketPrices(db, toolArgs, ctx, { signal });
    }
    return { ok: false, error: 'Tool is not available in market AI search' };
  }));
  return calls.map((toolCall, index) => {
    const item = settled[index]!;
    const value = item.status === 'fulfilled'
      ? item.value
      : { ok: false, error: 'Tool execution failed' };
    return { callId: toolCall.callId, output: JSON.stringify(value) };
  });
}

/**
 * Достаёт JSON-массив из финального текста модели (ей разрешён голый массив,
 * но на практике бывают обёртки) и валидирует каждую запись. null — ответ
 * не парсится, роут отвечает деградацией.
 */
export function parseMarketAiSearchPicks(text: string): MarketAiSearchPick[] | null {
  return parsePicks(text, config.web.aiSearchMaxResults);
}

function parsePicks(text: string, maxResults: number): MarketAiSearchPick[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const picks: MarketAiSearchPick[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const typeId = record.type_id;
    if (typeof typeId !== 'number' || !Number.isSafeInteger(typeId) || typeId <= 0 || seen.has(typeId)) continue;
    seen.add(typeId);
    const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, MAX_REASON_CHARS) : '';
    picks.push({ type_id: typeId, reason });
    if (picks.length >= maxResults) break;
  }
  return picks;
}
