import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

// Mock ONLY the network call; keep the real item builders/helpers so the loop
// under test assembles input exactly as production does.
const { createNativeResponseMock, runPreTurnCompactMock, runMidTurnCompactMock } = vi.hoisted(() => ({
  createNativeResponseMock: vi.fn(),
  runPreTurnCompactMock: vi.fn(),
  runMidTurnCompactMock: vi.fn(),
}));
vi.mock('../../src/agent/native-responses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/native-responses.js')>();
  return { ...actual, createNativeResponse: createNativeResponseMock };
});
vi.mock('../../src/agent/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/compact.js')>();
  return {
    ...actual,
    runPreTurnCompact: runPreTurnCompactMock,
    runMidTurnCompact: runMidTurnCompactMock,
  };
});

const GOAL = 'сравни цены Rifter и Punisher в Jita для соло-PvP';

type MockResponse = {
  id: string | null;
  output: Array<Record<string, unknown>>;
  outputText: string;
  error: { message: string } | null;
  toolSearchPaths: string[];
  rawEvents: Array<{ event: string; data: unknown }>;
  usage: { input: number; output: number; cached: number; reasoning: number } | null;
  status?: string | null;
};

function toolCallResponse(callId: string, sql: string): MockResponse {
  return {
    id: `resp_${callId}`,
    output: [{ type: 'function_call', call_id: callId, name: 'sde_sql', arguments: JSON.stringify({ sql }) }],
    outputText: '',
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: { input: 1000, output: 50, cached: 0, reasoning: 0 },
  };
}

function textResponse(text: string): MockResponse {
  return {
    id: 'resp_final',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    outputText: text,
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: { input: 1200, output: 80, cached: 0, reasoning: 0 },
  };
}

function outputResponse(output: Array<Record<string, unknown>>, id = 'resp_output'): MockResponse {
  return {
    id,
    output,
    outputText: '',
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: { input: 1000, output: 50, cached: 0, reasoning: 0 },
  };
}

/** Flatten a request's input items into a searchable string per item. */
function itemTexts(items: Array<Record<string, unknown>>): string[] {
  return items.map((item) => JSON.stringify(item));
}

let db: Database.Database;

beforeEach(() => {
  process.env.ALLOWED_TELEGRAM_USER_ID = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.EVE_CLIENT_ID = 'test';
  process.env.EVE_CLIENT_SECRET = 'test';
  process.env.DEFAULT_MARKET_REGION_ID = '10000002';
  process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
  process.env.OPENAI_RESPONSE_STATE_MODE = 'stateless';
  process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'false';
  process.env.OPENAI_REASONING_EFFORT = 'auto';
  process.env.OPENAI_REASONING_MODE = 'standard';
  process.env.AUTH_SECRET_KEY = 'test-secret';
  vi.resetModules();
  createNativeResponseMock.mockReset();
  runPreTurnCompactMock.mockReset();
  runMidTurnCompactMock.mockReset();
  runMidTurnCompactMock.mockResolvedValue(undefined);
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(1, 'u');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, total_tokens) VALUES (?, ?, ?)').run('t1', 1, 0);
  // The user's message is stored by the chat pipeline before the loop runs.
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run('t1', 'user', GOAL);
});

afterEach(() => {
  db.close();
  vi.resetModules();
});

async function runLoop(): Promise<{ text: string }> {
  const { __test__ } = await import('../../src/agent/executor.js');
  return __test__.runNativeAgentLoop(
    db as never,
    't1',
    { userId: 1, chatId: 1 },
    GOAL,
    'developer prompt',
    () => 'developer prompt',
  );
}

describe('tool output truncation', () => {
  it('preserves ordinary JSON output exactly', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    const output = JSON.stringify({ ok: true, data: [{ id: 1, name: 'Jita' }] });

    expect(__test__.truncateToolOutput(output)).toBe(output);
  });

  it('returns bounded valid JSON for malformed input', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');

    const truncated = __test__.truncateToolOutput('{not valid JSON');
    expect(truncated.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(truncated)).not.toThrow();
  });

  it('keeps an oversized aggregate wrapper bounded and valid JSON', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    const output = JSON.stringify({
      context: 'x'.repeat(13_000),
      data: Array.from({ length: 20 }, (_, index) => ({ id: index, value: index * 2 })),
    });

    const truncated = __test__.truncateToolOutput(output);
    expect(truncated.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(truncated)).not.toThrow();
  });

  it('keeps an oversized 20-item fallback bounded and valid JSON', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    const output = JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
      id: index,
      payload: 'x'.repeat(3_000),
    })));

    const truncated = __test__.truncateToolOutput(output);
    expect(truncated.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(truncated)).not.toThrow();
  });
});

describe('stateless tool loop context accumulation', () => {
  it('continues a two-pause program, preserves callers and waits for a final message', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    db.exec(`
      INSERT INTO sde_regions (region_id, name, data_json) VALUES (10000002, 'The Forge', '{}');
      INSERT INTO sde_constellations (constellation_id, region_id, name, data_json) VALUES (20000020, 10000002, 'Kimotoro', '{}');
      INSERT INTO sde_systems (system_id, constellation_id, name, data_json) VALUES (30000142, 20000020, 'Jita', '{}');
    `);
    const caller = { type: 'program', caller_id: 'prog_call_1' };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', id: 'prog_1', call_id: 'prog_call_1', code: 'not persisted', fingerprint: 'opaque-fp' },
        { type: 'function_call', call_id: 'count_1', name: 'count_universe_objects', arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }), caller },
      ]))
      .mockResolvedValueOnce(outputResponse([
        { type: 'function_call', call_id: 'count_2', name: 'count_universe_objects', arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'constellations' }), caller },
      ]))
      .mockResolvedValueOnce(outputResponse([
        { type: 'program_output', id: 'po_1', call_id: 'prog_call_1', result: 'done', status: 'incomplete' },
      ]))
      .mockResolvedValueOnce(textResponse('финальный ответ'));

    const result = await runLoop();
    expect(result.text).toBe('финальный ответ');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(4);
    const fourthItems = createNativeResponseMock.mock.calls[3][0].items as Array<Record<string, unknown>>;
    expect(fourthItems.filter((item) => item.type === 'program')).toHaveLength(1);
    expect(fourthItems.filter((item) => item.type === 'program_output')).toHaveLength(1);
    expect(fourthItems.filter((item) => item.type === 'function_call_output')).toHaveLength(2);
    expect(fourthItems.filter((item) => item.type === 'function_call_output').every((item) =>
      JSON.stringify(item.caller) === JSON.stringify(caller))).toBe(true);
    expect(runMidTurnCompactMock).not.toHaveBeenCalled();
    const persisted = JSON.stringify(db.prepare('SELECT content FROM messages').all());
    expect(persisted).not.toContain('opaque-fp');
    expect(persisted).not.toContain('not persisted');
  });

  it('fails closed when a program reaches a final message below its minimum call shape', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_too_short' };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_too_short', code: 'hosted' },
        {
          type: 'function_call',
          call_id: 'count_only_one',
          name: 'count_universe_objects',
          arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }),
          caller,
        },
      ]))
      .mockResolvedValueOnce(textResponse('must not be accepted'));

    const result = await runLoop();
    expect(result.text).toContain('Не удалось завершить безопасную программную выборку');
    expect(result.text).not.toContain('must not be accepted');
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 1 });
  });

  it('reserves the whole programmatic batch and rejects more than four calls without dispatch', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_batch' };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_batch', code: 'hosted' },
        ...[1, 2, 3, 4, 5].map((n) => ({
          type: 'function_call', call_id: `count_${n}`, name: 'count_universe_objects',
          arguments: JSON.stringify({ target_kind: 'region', target_name: `Region ${n}`, object_kind: 'systems' }), caller,
        })),
      ]))
      .mockResolvedValueOnce(textResponse('budget handled'));

    expect((await runLoop()).text).toBe('budget handled');
    const second = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const outputs = second.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(5);
    expect(outputs.every((item) => String(item.output).includes('budget exceeded'))).toBe(true);
  });

  it('fails closed on structurally unusable program caller data', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    createNativeResponseMock.mockResolvedValueOnce(outputResponse([
      { type: 'program', call_id: 'prog_bad' },
      { type: 'function_call', call_id: 'count_bad', name: 'count_universe_objects', arguments: '{}', caller: { type: 'program', caller_id: '' } },
    ]));
    await expect(runLoop()).rejects.toThrow('Invalid programmatic tool caller');
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
  });

  it('rejects disallowed and unlinked programmatic calls without generic dispatch', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_safe' },
        { type: 'function_call', call_id: 'sql_bad', name: 'sde_sql', arguments: '{"sql":"SELECT 1"}', caller: { type: 'program', caller_id: 'prog_safe' } },
        { type: 'function_call', call_id: 'count_unlinked', name: 'count_universe_objects', arguments: '{}', caller: { type: 'program', caller_id: 'missing_program' } },
      ]))
      .mockResolvedValueOnce(textResponse('rejections handled'));

    expect((await runLoop()).text).toBe('rejections handled');
    const second = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const outputs = second.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(2);
    expect(String(outputs[0]?.output)).toContain('not allowed');
    expect(String(outputs[1]?.output)).toContain('not allowed');
    const audits = db.prepare("SELECT content FROM messages WHERE role = 'tool' ORDER BY id").all() as Array<{ content: string }>;
    expect(audits.map((row) => JSON.parse(row.content).result.schema_valid)).toEqual([false, true]);
  });

  it('rejects an incoherent market comparison as one atomic programmatic batch', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_market' };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_market', code: 'hosted' },
        {
          type: 'function_call',
          call_id: 'market_1',
          name: 'batch_market_prices',
          arguments: JSON.stringify({ region_id: 10000002, type_ids: [34, 35] }),
          caller,
        },
        {
          type: 'function_call',
          call_id: 'market_2',
          name: 'batch_market_prices',
          arguments: JSON.stringify({ region_id: 10000043, type_ids: [35, 34] }),
          caller,
        },
      ]))
      .mockResolvedValueOnce(textResponse('market rejected'));

    expect((await runLoop()).text).toBe('market rejected');
    const second = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const outputs = second.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(2);
    expect(outputs.every((item) => String(item.output).includes('same ordered type_ids'))).toBe(true);
    const persisted = JSON.stringify(db.prepare("SELECT content FROM messages WHERE role = 'tool'").all());
    expect(persisted).not.toContain('10000002');
    expect(persisted).not.toContain('10000043');
  });

  it('rejects mixed eligible tool families for one program without dispatch', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_mixed' };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_mixed', code: 'hosted' },
        {
          type: 'function_call',
          call_id: 'count_mixed',
          name: 'count_universe_objects',
          arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }),
          caller,
        },
        {
          type: 'function_call',
          call_id: 'wh_mixed',
          name: 'compare_wormhole_types',
          arguments: JSON.stringify({ identifiers: ['C140', 'A239'] }),
          caller,
        },
      ]))
      .mockResolvedValueOnce(textResponse('mixed rejected'));

    expect((await runLoop()).text).toBe('mixed rejected');
    const second = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const outputs = second.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(2);
    expect(outputs.every((item) => String(item.output).includes('one eligible tool family'))).toBe(true);
  });

  it('preserves disabled direct completion from bare output text', async () => {
    createNativeResponseMock.mockResolvedValueOnce({
      ...outputResponse([]),
      outputText: 'legacy direct answer',
    });

    expect((await runLoop()).text).toBe('legacy direct answer');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
  });

  it('emits an explicit completion signal only for a real final assistant message', async () => {
    createNativeResponseMock.mockResolvedValueOnce(textResponse('real final'));
    const { runWithActivitySink } = await import('../../src/agent/activity.js');
    const events: string[] = [];

    await runWithActivitySink(
      { emit: (event) => events.push(event.type) },
      () => runLoop(),
    );

    expect(events).toContain('final_assistant_message');
  });

  it('carries active-program convenience text but rejects a final message with no bounded tool shape', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', id: 'prog_item', call_id: 'prog_call', code: 'hosted' },
      ]))
      .mockResolvedValueOnce({ ...outputResponse([]), outputText: 'provider convenience text only' })
      .mockResolvedValueOnce(textResponse('real final message'));

    expect((await runLoop()).text).toContain('Не удалось завершить безопасную программную выборку');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(3);
    const thirdItems = createNativeResponseMock.mock.calls[2][0].items as Array<Record<string, unknown>>;
    expect(thirdItems).toContainEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'provider convenience text only' }],
    });
  });

  it('fails closed when an unstarted program is followed by an unrelated unknown caller', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', id: 'prog_item_only', call_id: 'prog_call', code: 'hosted' },
        {
          type: 'function_call',
          call_id: 'count_wrong_link',
          name: 'count_universe_objects',
          arguments: '{"target_kind":"region","target_name":"The Forge","object_kind":"systems"}',
          caller: { type: 'program', caller_id: 'prog_item_only' },
        },
      ]))
      .mockResolvedValueOnce(textResponse('rejection handled'));
    const activityTypes: string[] = [];
    const { __test__ } = await import('../../src/agent/executor.js');
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    const result = await runWithActivitySink(
      { emit: (event) => activityTypes.push(event.type), aborted: () => false },
      () => __test__.runNativeAgentLoop(
        db as never, 't1', { userId: 1, chatId: 1 }, GOAL, 'developer prompt', () => 'developer prompt',
      ),
    );

    expect(result.text).toContain('Не удалось завершить безопасную программную выборку');
    expect(result.text).not.toContain('rejection handled');
    expect(activityTypes).not.toContain('tool_start');
    const secondItems = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const output = secondItems.find((item) =>
      item.type === 'function_call_output' && item.call_id === 'count_wrong_link');
    expect(JSON.parse(String(output?.output))).toMatchObject({
      ok: false,
      blocked: true,
      error: 'Unknown program caller',
    });
  });

  it('does not let an unrelated unknown caller waive an active program minimum shape', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_active' };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_active', code: 'hosted' },
        {
          type: 'function_call',
          call_id: 'count_first',
          name: 'count_universe_objects',
          arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }),
          caller,
        },
      ]))
      .mockResolvedValueOnce(outputResponse([
        {
          type: 'function_call',
          call_id: 'unrelated_unknown',
          name: 'count_universe_objects',
          arguments: JSON.stringify({ target_kind: 'region', target_name: 'Domain', object_kind: 'systems' }),
          caller: { type: 'program', caller_id: 'unknown_program' },
        },
      ]))
      .mockResolvedValueOnce(textResponse('must not bypass the minimum'));

    const result = await runLoop();
    expect(result.text).toContain('Не удалось завершить безопасную программную выборку');
    expect(result.text).not.toContain('must not bypass the minimum');
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 2 });
  });

  it('does not dispatch tools from a non-completed response envelope', async () => {
    createNativeResponseMock.mockResolvedValueOnce({
      ...outputResponse([
        { type: 'function_call', call_id: 'must_not_run', name: 'sde_sql', arguments: '{"sql":"SELECT 1"}' },
      ]),
      status: 'incomplete',
    });

    expect((await runLoop()).text).toContain('временно недоступен');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
  });

  it('enforces the two-call count-family budget across separate program pauses', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    db.exec(`
      INSERT INTO sde_regions (region_id, name, data_json) VALUES (10000002, 'The Forge', '{}');
      INSERT INTO sde_constellations (constellation_id, region_id, name, data_json) VALUES (20000020, 10000002, 'Kimotoro', '{}');
      INSERT INTO sde_systems (system_id, constellation_id, name, data_json) VALUES (30000142, 20000020, 'Jita', '{}');
    `);
    const caller = { type: 'program', caller_id: 'prog_budget' };
    const countCall = (callId: string, objectKind: string) => ({
      type: 'function_call',
      call_id: callId,
      name: 'count_universe_objects',
      arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: objectKind }),
      caller,
    });
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([{ type: 'program', call_id: 'prog_budget', code: 'hosted' }, countCall('count_1', 'systems')]))
      .mockResolvedValueOnce(outputResponse([countCall('count_2', 'constellations')]))
      .mockResolvedValueOnce(outputResponse([countCall('count_3', 'planets')]))
      .mockResolvedValueOnce(textResponse('budget complete'));

    expect((await runLoop()).text).toBe('budget complete');
    const fourthItems = createNativeResponseMock.mock.calls[3][0].items as Array<Record<string, unknown>>;
    const count3Output = fourthItems.find((item) => item.type === 'function_call_output' && item.call_id === 'count_3');
    expect(String(count3Output?.output)).toContain('budget exceeded');
    const count1Output = fourthItems.find((item) => item.type === 'function_call_output' && item.call_id === 'count_1');
    const count2Output = fourthItems.find((item) => item.type === 'function_call_output' && item.call_id === 'count_2');
    expect(JSON.parse(String(count1Output?.output))).toMatchObject({ ok: true });
    expect(JSON.parse(String(count2Output?.output))).toMatchObject({ ok: true });
    const persisted = JSON.stringify(db.prepare("SELECT content FROM messages WHERE role = 'tool'").all());
    expect(persisted).not.toContain('The Forge');
    expect(persisted).not.toContain('"systems"');
  });
  it('routes analytics locally and never persists rejected private argument values', async () => {
    const secret = 'private-analytics-sentinel';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([{
        type: 'function_call',
        call_id: 'analytics_1',
        name: 'killmail_forensics',
        arguments: JSON.stringify({ killmail_id: 123, private_token: secret }),
      }]))
      .mockResolvedValueOnce(textResponse('безопасный ответ'));

    try {
      const result = await runLoop();
      expect(result.text).toBe('безопасный ответ');
      expect(fetchMock).not.toHaveBeenCalled();
      const toolMessages = db.prepare(
        "SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id",
      ).all('t1') as Array<{ content: string }>;
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.content).not.toContain(secret);
      expect(JSON.parse(toolMessages[0]!.content)).toMatchObject({
        tool: 'killmail_forensics',
        args: { fields: ['killmail_id', 'private_token'] },
        result: { ok: false, error: 'Invalid EVE-KILL analytics arguments' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('caps local EVE-KILL analytics at four calls per turn', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"finding":"ok"}' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { __test__, createWebSearchState } = await import('../../src/agent/executor.js');
      const state = createWebSearchState();
      const results: unknown[] = [];
      for (let index = 0; index < 5; index += 1) {
        results.push(await __test__.executeToolCall(
          db as never,
          'request-1',
          GOAL,
          { userId: 1, chatId: 1 },
          'killmail_forensics',
          { killmail_id: 100 + index },
          state,
        ));
      }

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(results.slice(0, 4).every((result) => (result as { ok?: boolean }).ok === true)).toBe(true);
      expect(results[4]).toMatchObject({ ok: false, blocked: true });
      expect(state).toMatchObject({ eveKillCallCount: 5, eveKillAnalyticsCallCount: 5 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the user goal and earlier tool rounds in every request', async () => {
    createNativeResponseMock
      .mockResolvedValueOnce(toolCallResponse('call_1', 'SELECT type_id FROM sde_types LIMIT 1'))
      .mockResolvedValueOnce(toolCallResponse('call_2', 'SELECT type_id FROM sde_types LIMIT 2'))
      .mockResolvedValueOnce(textResponse('готовый ответ'));

    const result = await runLoop();
    expect(result.text).toBe('готовый ответ');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(3);

    // Request 1: smart context with the user's goal.
    const first = itemTexts(createNativeResponseMock.mock.calls[0][0].items);
    expect(first.some((t) => t.includes('Rifter'))).toBe(true);

    // Request 2: goal still present + round-1 call/output pair.
    const second = itemTexts(createNativeResponseMock.mock.calls[1][0].items);
    expect(second.some((t) => t.includes('Rifter'))).toBe(true);
    expect(second.some((t) => t.includes('"function_call"') && t.includes('call_1'))).toBe(true);
    expect(second.some((t) => t.includes('function_call_output') && t.includes('call_1'))).toBe(true);

    // Request 3: goal + BOTH earlier rounds survive (nothing replaced).
    const third = itemTexts(createNativeResponseMock.mock.calls[2][0].items);
    expect(third.some((t) => t.includes('Rifter'))).toBe(true);
    for (const callId of ['call_1', 'call_2']) {
      expect(third.some((t) => t.includes('"function_call"') && t.includes(callId))).toBe(true);
      expect(third.some((t) => t.includes('function_call_output') && t.includes(callId))).toBe(true);
    }

    // Stateless mode must never chain server-side state.
    for (const call of createNativeResponseMock.mock.calls) {
      expect(call[0].previousResponseId ?? null).toBeNull();
    }
  });

  it('does not duplicate items across iterations', async () => {
    createNativeResponseMock
      .mockResolvedValueOnce(toolCallResponse('call_1', 'SELECT type_id FROM sde_types LIMIT 1'))
      .mockResolvedValueOnce(textResponse('ответ'));

    await runLoop();
    const second: Array<Record<string, unknown>> = createNativeResponseMock.mock.calls[1][0].items;
    const callItems = second.filter((item) => item.type === 'function_call');
    const outputItems = second.filter((item) => item.type === 'function_call_output');
    expect(callItems).toHaveLength(1);
    expect(outputItems).toHaveLength(1);
  });

  it('replays encrypted reasoning before its call/output and never persists it', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'opaque-reasoning-must-stay-in-memory',
      summary: [],
    };
    const call = toolCallResponse('call_reasoning', 'SELECT 1').output[0];
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([reasoning, call], 'resp_reasoning'))
      .mockResolvedValueOnce(textResponse('готово'));

    const result = await runLoop();
    expect(result.text).toBe('готово');
    const second = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const reasoningIndex = second.findIndex((item) => item.id === 'rs_1');
    const callIndex = second.findIndex((item) => item.type === 'function_call' && item.call_id === 'call_reasoning');
    const outputIndex = second.findIndex((item) => item.type === 'function_call_output' && item.call_id === 'call_reasoning');
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(reasoningIndex).toBeLessThan(callIndex);
    expect(callIndex).toBeLessThan(outputIndex);

    const persisted = db.prepare('SELECT content FROM messages ORDER BY id').all() as Array<{ content: string }>;
    expect(JSON.stringify(persisted)).not.toContain('opaque-reasoning-must-stay-in-memory');
  });
});

describe('top-level GPT-5.6 reasoning selection', () => {
  it('uses the goal classifier only when the operator selects auto', async () => {
    createNativeResponseMock.mockResolvedValueOnce(textResponse('ответ'));
    await runLoop();
    expect(createNativeResponseMock.mock.calls[0][0].reasoningEffort).toBe('high');
    expect(createNativeResponseMock.mock.calls[0][0].reasoningMode).toBe('standard');
  });

  it('keeps a fixed effort, Pro mode, and opaque safety identifier', async () => {
    process.env.OPENAI_REASONING_EFFORT = 'max';
    process.env.OPENAI_REASONING_MODE = 'pro';
    vi.resetModules();
    createNativeResponseMock.mockResolvedValueOnce(textResponse('ответ'));

    await runLoop();
    const request = createNativeResponseMock.mock.calls[0][0];
    expect(request.reasoningEffort).toBe('max');
    expect(request.reasoningMode).toBe('pro');
    expect(request.preserveReasoning).toBe(true);
    expect(request.safetyIdentifier).toMatch(/^[a-f0-9]{64}$/);
    expect(request.safetyIdentifier).not.toBe('1');
    expect(request.promptCacheKey).toBe(request.safetyIdentifier);
    expect(request.promptCacheKey).not.toBe('t1');
  });
});

function errorResponse(message: string): MockResponse {
  return {
    id: null,
    output: [],
    outputText: '',
    error: { message },
    toolSearchPaths: [],
    rawEvents: [],
    usage: null,
  };
}

describe('transient model error retry', () => {
  it('classifies transient vs permanent error messages', async () => {
    const { __test__ } = await import('../../src/agent/executor.js');
    const transient = [
      'Responses API timed out after 90s',
      'Incomplete response stream (no terminal event received)',
      'HTTP 502',
      'HTTP 429',
      'terminated',
      'fetch failed',
      'read ECONNRESET',
      'Rate limit reached for gpt-5.5',
      'The server had an error processing your request.',
      // Plain-text gateway bodies now arrive prefixed with the status code.
      'HTTP 429: Too Many Requests',
      'HTTP 502: Bad Gateway',
      'HTTP 503: Service Unavailable',
      'HTTP 504: Gateway Timeout',
    ];
    for (const message of transient) {
      expect(__test__.isTransientModelError(message), message).toBe(true);
    }
    const permanent = [
      'HTTP 400',
      'Invalid value for tools[3].parameters',
      'HTTP 401',
      'No tool output found for function call call_abc',
    ];
    for (const message of permanent) {
      expect(__test__.isTransientModelError(message), message).toBe(false);
    }
  });

  it('retries a thrown transient error with the same request and completes the turn', async () => {
    createNativeResponseMock
      .mockRejectedValueOnce(new Error('Responses API timed out after 90s'))
      .mockResolvedValueOnce(textResponse('ответ после ретрая'));
    const result = await runLoop();
    expect(result.text).toBe('ответ после ретрая');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(2);
    // The retried request must be byte-identical input to the failed one.
    expect(createNativeResponseMock.mock.calls[1][0].items)
      .toEqual(createNativeResponseMock.mock.calls[0][0].items);
  });

  it('retries an in-payload transient error (truncated stream)', async () => {
    createNativeResponseMock
      .mockResolvedValueOnce(errorResponse('Incomplete response stream (no terminal event received)'))
      .mockResolvedValueOnce(textResponse('ответ'));
    const result = await runLoop();
    expect(result.text).toBe('ответ');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent errors', async () => {
    createNativeResponseMock.mockRejectedValue(new Error('HTTP 400'));
    await expect(runLoop()).rejects.toThrow('HTTP 400');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
  });

  it('does not consume the tool-iteration budget on retry', async () => {
    // 1 transient failure + 15 tool rounds + final text. MAX_TOOL_ITERATIONS
    // is 16: if the retry burned an iteration slot, the final text call would
    // fall outside the loop and the turn would end with the timeout message.
    createNativeResponseMock.mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'));
    for (let i = 0; i < 15; i += 1) {
      createNativeResponseMock.mockResolvedValueOnce(
        toolCallResponse(`call_${i}`, `SELECT type_id FROM sde_types LIMIT ${i + 1}`),
      );
    }
    createNativeResponseMock.mockResolvedValueOnce(textResponse('успел'));

    const result = await runLoop();
    expect(result.text).toBe('успел');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(17);
  }, 20_000);

  // Real backoff delays (1s+2s+3s) run here — this test is deliberately slow.
  it('gives up after the per-turn retry budget', async () => {
    createNativeResponseMock.mockRejectedValue(new Error('fetch failed'));
    await expect(runLoop()).rejects.toThrow('fetch failed');
    // 1 original + 3 retries, then the error propagates.
    expect(createNativeResponseMock).toHaveBeenCalledTimes(4);
  }, 20_000);
});

describe('cooperative turn abort (CLI Ctrl-C)', () => {
  it('stops before any tool runs when the sink reports aborted mid-sampling', async () => {
    let aborted = false;
    createNativeResponseMock.mockImplementation(async () => {
      // Simulate the user hitting Ctrl-C while the model call is in flight.
      aborted = true;
      return toolCallResponse('call_1', 'SELECT type_id FROM sde_types LIMIT 1');
    });
    const { __test__ } = await import('../../src/agent/executor.js');
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    await expect(runWithActivitySink(
      { emit: () => {}, aborted: () => aborted },
      () => __test__.runNativeAgentLoop(
        db as never, 't1', { userId: 1, chatId: 1 }, GOAL, 'developer prompt', () => 'developer prompt',
      ),
    )).rejects.toThrow('Turn aborted by user');

    // One model call, then the loop stopped — the returned tool call never ran.
    expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
    const toolRows = db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1' AND role = 'tool'",
    ).get() as { n: number };
    expect(toolRows.n).toBe(0);
  });

  it('without an aborted probe (bots) the loop is unaffected', async () => {
    createNativeResponseMock.mockResolvedValueOnce(textResponse('ок'));
    const result = await runLoop();
    expect(result.text).toBe('ок');
  });

  it('does not run kill_watch after cancellation during an earlier read in the same batch', async () => {
    const readCall = toolCallResponse('call_read', 'SELECT type_id FROM sde_types LIMIT 1').output[0];
    const watchCall = {
      type: 'function_call',
      call_id: 'call_watch',
      name: 'kill_watch',
      arguments: JSON.stringify({
        action: 'watch',
        topic_type: 'system',
        topic_id: 30000142,
        label: 'must-not-be-created',
      }),
    };
    createNativeResponseMock.mockResolvedValueOnce(outputResponse([readCall, watchCall]));
    let aborted = false;
    const { __test__ } = await import('../../src/agent/executor.js');
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    await expect(runWithActivitySink(
      {
        emit: (event) => {
          if (event.type === 'tool_start' && event.name === 'sde_sql') aborted = true;
        },
        aborted: () => aborted,
      },
      () => __test__.runNativeAgentLoop(
        db as never,
        't1',
        { userId: 1, chatId: 1 },
        GOAL,
        'developer prompt',
        () => 'developer prompt',
      ),
    )).rejects.toThrow('Turn aborted by user');

    const watches = db.prepare('SELECT COUNT(*) AS n FROM kill_watches').get() as { n: number };
    expect(watches.n).toBe(0);
  });

  it('fails closed if a stale response asks a transient CLI lane to create a durable watch', async () => {
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([{
        type: 'function_call',
        call_id: 'call_watch',
        name: 'kill_watch',
        arguments: JSON.stringify({
          action: 'watch',
          topic_type: 'system',
          topic_id: 30000142,
          label: 'must-not-persist',
        }),
      }]))
      .mockResolvedValueOnce(textResponse('уведомления недоступны'));
    const { __test__ } = await import('../../src/agent/executor.js');

    const result = await __test__.runNativeAgentLoop(
      db as never,
      't1',
      { userId: 1, chatId: 1, notificationCapability: 'none' },
      GOAL,
      'developer prompt',
      () => 'developer prompt',
    );

    expect(result.text).toBe('уведомления недоступны');
    const watches = db.prepare('SELECT COUNT(*) AS n FROM kill_watches').get() as { n: number };
    expect(watches.n).toBe(0);
    const second = JSON.stringify(createNativeResponseMock.mock.calls[1]?.[0].items);
    expect(second).toContain('Durable background notifications are unavailable');
  });
});

describe('runPreTurnCompactSafe', () => {
  it('swallows compaction failure instead of failing the turn', async () => {
    runPreTurnCompactMock.mockRejectedValueOnce(new Error('summarizer down'));
    const { __test__ } = await import('../../src/agent/executor.js');
    await expect(__test__.runPreTurnCompactSafe(db as never, 't1')).resolves.toBeUndefined();
    expect(runPreTurnCompactMock).toHaveBeenCalledTimes(1);
  });
});
