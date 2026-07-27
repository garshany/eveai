import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { config } from '../../src/config.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  MARKET_AI_SEARCH_MAX_RESULTS,
  MARKET_AI_SEARCH_MAX_TOOL_CALLS,
  parseMarketAiSearchPicks,
  runMarketAiSearch,
  type MarketAiSearchOptions,
} from '../../src/agent/market-ai-search.js';
import type {
  NativeResponseOutputItem,
  NativeResponseResult,
  NativeUsage,
} from '../../src/agent/native-responses.js';
import type { UserContext } from '../../src/auth/user-resolver.js';

describe('parseMarketAiSearchPicks', () => {
  it('parses a bare JSON array and trims fields', () => {
    const picks = parseMarketAiSearchPicks('[{"type_id": 587, "reason": "  Дешёвый фрегат.  "}]');
    expect(picks).toEqual([{ type_id: 587, reason: 'Дешёвый фрегат.' }]);
  });

  it('tolerates prose around the array and skips invalid entries', () => {
    const text = 'Вот подборка:\n[{"type_id": 587, "reason": "ok"}, {"type_id": "587"}, {"type_id": -3}, {"reason": "no id"}, null, {"type_id": 587, "reason": "дубликат"}]\nНадеюсь, помогло.';
    expect(parseMarketAiSearchPicks(text)).toEqual([{ type_id: 587, reason: 'ok' }]);
  });

  it('caps the list at the result budget', () => {
    const entries = Array.from({ length: MARKET_AI_SEARCH_MAX_RESULTS + 5 }, (_, index) => ({ type_id: 100 + index, reason: '' }));
    const picks = parseMarketAiSearchPicks(JSON.stringify(entries));
    expect(picks).toHaveLength(MARKET_AI_SEARCH_MAX_RESULTS);
  });

  it('returns null when there is no parseable array', () => {
    expect(parseMarketAiSearchPicks('Модель ответила текстом без JSON')).toBeNull();
    expect(parseMarketAiSearchPicks('[{битый json')).toBeNull();
    expect(parseMarketAiSearchPicks('{"type_id": 587}')).toBeNull();
  });
});

type ResponseFactory = NonNullable<MarketAiSearchOptions['responseFactory']>;
type FactoryInput = Parameters<ResponseFactory>[0];

const CTX: UserContext = { userId: 1, chatId: -1 };
const REGION = 10000002;

const USAGE: NativeUsage = { input: 100, output: 25, total: 125, cached: 0, reasoning: 0 };

function response(output: NativeResponseOutputItem[], outputText = ''): NativeResponseResult {
  return {
    id: 'resp-test',
    output,
    outputText,
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: { ...USAGE },
    status: 'completed',
    sawUsefulDeltas: true,
  };
}

function finalText(text: string): NativeResponseResult {
  return response([], text);
}

function toolCalls(
  calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
): NativeResponseResult {
  return response(calls.map((call) => ({
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.args ?? { sql: 'SELECT type_id FROM sde_types LIMIT 1' }),
  })));
}

function sdeCalls(prefix: string, count: number): NativeResponseResult {
  return toolCalls(Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: 'sde_sql',
  })));
}

/** function_call_output элементы, которые раннер отправил модели следующим входом. */
function toolOutputsOf(input: FactoryInput): Array<{ call_id: string; output: string }> {
  return (input.items as Array<Record<string, unknown>>)
    .filter((item) => item.type === 'function_call_output')
    .map((item) => ({ call_id: String(item.call_id), output: String(item.output) }));
}

describe('runMarketAiSearch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('stops at the configured model-call budget when the model keeps calling tools', async () => {
    const factory = vi.fn<ResponseFactory>(async () => sdeCalls('loop', 1));

    const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, { responseFactory: factory });

    expect(outcome.ok).toBe(false);
    // Бюджет по умолчанию — два вызова (раунд тулов + финальный ответ).
    expect(factory).toHaveBeenCalledTimes(2);
    // Usage потраченных вызовов не теряется даже при неуспехе.
    expect(outcome.usage).toMatchObject({ input: 200, output: 50 });
  });

  it('honours WEB_AI_SEARCH_MAX_MODEL_CALLS overrides (config wiring is live)', async () => {
    const original = config.web.aiSearchMaxModelCalls;
    config.web.aiSearchMaxModelCalls = 1;
    try {
      const factory = vi.fn<ResponseFactory>(async () => sdeCalls('loop', 1));
      const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, { responseFactory: factory });
      expect(outcome.ok).toBe(false);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      config.web.aiSearchMaxModelCalls = original;
    }
  });

  it('cuts tool calls beyond the per-search leaf budget instead of starting them', async () => {
    const original = config.web.aiSearchMaxModelCalls;
    config.web.aiSearchMaxModelCalls = 3;
    try {
      const factory = vi.fn<ResponseFactory>()
        .mockResolvedValueOnce(sdeCalls('round1', 6))
        .mockResolvedValueOnce(sdeCalls('round2', 6))
        .mockResolvedValueOnce(finalText('[]'));

      const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, { responseFactory: factory });

      expect(outcome.ok).toBe(true);
      expect(factory).toHaveBeenCalledTimes(3);
      const secondRound = toolOutputsOf(factory.mock.calls[1]![0])
        .filter((entry) => entry.call_id.startsWith('round1'));
      const thirdRound = toolOutputsOf(factory.mock.calls[2]![0])
        .filter((entry) => entry.call_id.startsWith('round2'));
      // Первый раунд целиком в бюджете, второй — только остаток до потолка.
      expect(secondRound).toHaveLength(6);
      expect(secondRound.filter((entry) => entry.output.includes('exhausted'))).toHaveLength(0);
      expect(thirdRound).toHaveLength(6);
      expect(thirdRound.filter((entry) => entry.output.includes('exhausted')))
        .toHaveLength(6 - (MARKET_AI_SEARCH_MAX_TOOL_CALLS - 6));
      // Выполненные листы получили честный ответ sde_sql.
      expect(thirdRound.filter((entry) => entry.output.includes('"ok":true')))
        .toHaveLength(MARKET_AI_SEARCH_MAX_TOOL_CALLS - 6);
    } finally {
      config.web.aiSearchMaxModelCalls = original;
    }
  });

  it('feeds back a rejection instead of executing an undeclared tool', async () => {
    const factory = vi.fn<ResponseFactory>()
      .mockResolvedValueOnce(toolCalls([{ id: 'rogue-1', name: 'character_sql' }]))
      .mockResolvedValueOnce(finalText('[]'));

    const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, { responseFactory: factory });

    expect(outcome.ok).toBe(true);
    const outputs = toolOutputsOf(factory.mock.calls[1]![0]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.output).toContain('Tool was not declared for this turn');
  });

  it('does not start anything when the signal is already aborted', async () => {
    const factory = vi.fn<ResponseFactory>(async () => finalText('[]'));
    const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, {
      responseFactory: factory,
      signal: AbortSignal.abort(),
    });
    expect(outcome).toEqual({ ok: false, picks: [], usage: null });
    expect(factory).not.toHaveBeenCalled();
  });

  it('drops the search when the signal aborts mid-flight, without new tool calls', async () => {
    const controller = new AbortController();
    const factory = vi.fn<ResponseFactory>(async () => {
      controller.abort();
      // Модель вернула бы тул-вызовы — но диспатч после отмены не стартует,
      // и второго вызова модели тоже не будет.
      return sdeCalls('late', 3);
    });

    const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, {
      responseFactory: factory,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('degrades without leaking provider internals when the model call throws, keeping prior usage', async () => {
    const factory = vi.fn<ResponseFactory>()
      .mockResolvedValueOnce(sdeCalls('round1', 1))
      .mockRejectedValueOnce(new Error('Responses admission queue is full at https://provider.example/v1'));

    const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, { responseFactory: factory });

    expect(outcome.ok).toBe(false);
    expect(outcome.picks).toEqual([]);
    // Usage первого (успешного) вызова зафиксирован — роут запишет его в usage_events.
    expect(outcome.usage).toMatchObject({ input: 100, output: 25 });
  });

  it('answers with parsed picks on a clean single round', async () => {
    const factory = vi.fn<ResponseFactory>()
      .mockResolvedValueOnce(sdeCalls('lookup', 1))
      .mockResolvedValueOnce(finalText('[{"type_id": 587, "reason": "Дешёвый фрегат."}]'));

    const outcome = await runMarketAiSearch(db, 'фрегат', CTX, REGION, { responseFactory: factory });

    expect(outcome.ok).toBe(true);
    expect(outcome.picks).toEqual([{ type_id: 587, reason: 'Дешёвый фрегат.' }]);
  });
});
