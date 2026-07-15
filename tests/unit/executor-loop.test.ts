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
  delete process.env.OPENAI_PROVIDER;
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
  delete process.env.OPENAI_PROVIDER;
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

describe('client tool search loop', () => {
  function toolSearchCall(
    callId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: 'tool_search_call',
      id: `ts_${callId}`,
      call_id: callId,
      status: 'completed',
      execution: 'client',
      arguments: { query: 'market history summary', limit: 5 },
      ...overrides,
    };
  }

  function useCheapVibeCode(): void {
    process.env.OPENAI_PROVIDER = 'cheapvibecode';
    vi.resetModules();
  }

  it('replays a valid client search call and its exact call-id output before continuing', async () => {
    useCheapVibeCode();
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([toolSearchCall('search_1')]))
      .mockResolvedValueOnce(textResponse('нашёл подходящий tool'));

    expect((await runLoop()).text).toBe('нашёл подходящий tool');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(2);
    const continuation = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const callIndex = continuation.findIndex((item) => item.type === 'tool_search_call');
    const outputIndex = continuation.findIndex((item) => item.type === 'tool_search_output');
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThan(callIndex);
    expect(continuation[outputIndex]).toMatchObject({
      type: 'tool_search_output',
      call_id: 'search_1',
      status: 'completed',
      execution: 'client',
    });
    expect(JSON.stringify(continuation[outputIndex])).toContain('market_history_summary');
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
  });

  it.each([
    {
      label: 'mixed ordinary and search calls',
      output: [
        toolSearchCall('mixed_search'),
        { type: 'function_call', call_id: 'mixed_sql', name: 'sde_sql', arguments: '{"sql":"SELECT 1"}' },
      ],
    },
    {
      label: 'duplicate call ids',
      output: [toolSearchCall('duplicate'), toolSearchCall('duplicate')],
    },
    {
      label: 'more than four calls',
      output: [1, 2, 3, 4, 5].map((index) => toolSearchCall(`budget_${index}`)),
    },
    {
      label: 'provider-owned execution mode',
      output: [toolSearchCall('wrong_execution', { execution: 'server' })],
    },
    {
      label: 'missing call id',
      output: [toolSearchCall('missing_id', { call_id: '' })],
    },
  ])('fails closed on $label before any tool dispatch', async ({ output }) => {
    useCheapVibeCode();
    createNativeResponseMock.mockResolvedValueOnce(outputResponse(output));

    const result = await runLoop();
    expect(result.text).toBe('Не удалось безопасно выполнить локальный поиск tools. Попробуй ещё раз.');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
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

  it('does not let a rejected duplicate waive an accepted program minimum shape', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_partial_duplicate' };
    const countCall = (callId: string) => ({
      type: 'function_call',
      call_id: callId,
      name: 'count_universe_objects',
      arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: 'systems' }),
      caller,
    });
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_partial_duplicate', code: 'hosted' },
        countCall('count_accepted'),
      ]))
      .mockResolvedValueOnce(outputResponse([countCall('count_duplicate')]))
      .mockResolvedValueOnce(textResponse('must not accept partial duplicate program'));
    const activity: Array<{ type: string; accepted?: number; rejected?: number }> = [];
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    const result = await runWithActivitySink(
      { emit: (event) => activity.push(event) },
      () => runLoop(),
    );

    expect(result.text).toContain('Не удалось завершить безопасную программную выборку');
    expect(result.text).not.toContain('must not accept partial duplicate program');
    expect(activity.filter((event) => event.type === 'tool_start')).toHaveLength(1);
    expect(activity.filter((event) => event.type === 'programmatic_tool_batch')).toEqual([
      { type: 'programmatic_tool_batch', accepted: 1, rejected: 0 },
      { type: 'programmatic_tool_batch', accepted: 0, rejected: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 2 });
    const finalItems = createNativeResponseMock.mock.calls[2][0].items as Array<Record<string, unknown>>;
    const duplicateOutput = finalItems.find((item) =>
      item.type === 'function_call_output' && item.call_id === 'count_duplicate');
    expect(String(duplicateOutput?.output)).toContain('Duplicate programmatic tool call');
  });

  it('does not let a rejected over-budget batch waive an accepted program minimum shape', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: 'prog_partial_budget' };
    const countCall = (callId: string, objectKind: string) => ({
      type: 'function_call',
      call_id: callId,
      name: 'count_universe_objects',
      arguments: JSON.stringify({ target_kind: 'region', target_name: 'The Forge', object_kind: objectKind }),
      caller,
    });
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: 'prog_partial_budget', code: 'hosted' },
        countCall('count_accepted', 'systems'),
      ]))
      .mockResolvedValueOnce(outputResponse([
        countCall('count_budget_1', 'constellations'),
        countCall('count_budget_2', 'planets'),
        countCall('count_budget_3', 'moons'),
        countCall('count_budget_4', 'stations'),
      ]))
      .mockResolvedValueOnce(textResponse('must not accept partial over-budget program'));
    const activity: Array<{ type: string; accepted?: number; rejected?: number }> = [];
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    const result = await runWithActivitySink(
      { emit: (event) => activity.push(event) },
      () => runLoop(),
    );

    expect(result.text).toContain('Не удалось завершить безопасную программную выборку');
    expect(result.text).not.toContain('must not accept partial over-budget program');
    expect(activity.filter((event) => event.type === 'tool_start')).toHaveLength(1);
    expect(activity.filter((event) => event.type === 'programmatic_tool_batch')).toEqual([
      { type: 'programmatic_tool_batch', accepted: 1, rejected: 0 },
      { type: 'programmatic_tool_batch', accepted: 0, rejected: 4 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 5 });
    const finalItems = createNativeResponseMock.mock.calls[2][0].items as Array<Record<string, unknown>>;
    const rejectedOutputs = finalItems.filter((item) =>
      item.type === 'function_call_output' && String(item.call_id).startsWith('count_budget_'));
    expect(rejectedOutputs).toHaveLength(4);
    expect(rejectedOutputs.every((item) => String(item.output).includes('budget exceeded'))).toBe(true);
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

    const activity: Array<{ type: string; accepted?: number; rejected?: number }> = [];
    const { runWithActivitySink } = await import('../../src/agent/activity.js');
    expect((await runWithActivitySink(
      { emit: (event) => activity.push(event) },
      () => runLoop(),
    )).text).toBe('budget handled');
    expect(activity.filter((event) => event.type === 'tool_start')).toHaveLength(0);
    expect(activity.filter((event) => event.type === 'programmatic_tool_batch')).toEqual([
      { type: 'programmatic_tool_batch', accepted: 0, rejected: 5 },
    ]);
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

  it.each([
    {
      label: 'market-history windows',
      tool: 'market_history_summary',
      first: { region_id: 10000002, type_id: 34, days: 30 },
      second: { region_id: 10000043, type_id: 34, days: 90 },
    },
    {
      label: 'system-id ordering',
      tool: 'system_metric_snapshot',
      first: { metric: 'kills', system_ids: [30000142, 30002187] },
      second: { metric: 'jumps', system_ids: [30002187, 30000142] },
    },
    {
      label: 'doctrine comparison settings',
      tool: 'doctrine_summary',
      first: {
        entity_id: 99000001,
        entity_type: 'alliance',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-10T00:00:00.000Z',
        top: 2,
      },
      second: {
        entity_id: 99000002,
        entity_type: 'alliance',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-10T00:00:00.000Z',
        top: 3,
      },
    },
    {
      label: 'dynamic attribute ordering',
      tool: 'dynamic_item_summary',
      first: { type_id: 49726, item_id: 1000000001, attribute_ids: [9, 37] },
      second: { type_id: 49727, item_id: 1000000002, attribute_ids: [37, 9] },
    },
  ])('rejects incoherent $label atomically before dispatch', async ({ tool, first, second }) => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const caller = { type: 'program', caller_id: `prog_${tool}` };
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([
        { type: 'program', call_id: caller.caller_id, code: 'hosted' },
        {
          type: 'function_call', call_id: `${tool}_1`, name: tool,
          arguments: JSON.stringify(first), caller,
        },
        {
          type: 'function_call', call_id: `${tool}_2`, name: tool,
          arguments: JSON.stringify(second), caller,
        },
      ]))
      .mockResolvedValueOnce(textResponse('rejected safely'));
    const activity: Array<{ type: string }> = [];
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    expect((await runWithActivitySink(
      { emit: (event) => activity.push(event) },
      () => runLoop(),
    )).text).toBe('rejected safely');
    expect(activity.filter((event) => event.type === 'tool_start')).toHaveLength(0);
    const continuation = createNativeResponseMock.mock.calls[1][0].items as Array<Record<string, unknown>>;
    const outputs = continuation.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(2);
    expect(outputs.every((item) => String(item.output).includes('one coherent shape'))).toBe(true);
  });

  it.each([
    {
      tool: 'market_history_summary',
      calls: [
        { region_id: 10000002, type_id: 34, days: 90 },
        { region_id: 10000043, type_id: 34, days: 90 },
      ],
    },
    {
      tool: 'system_metric_snapshot',
      calls: [
        { metric: 'kills', system_ids: [30000142, 30002187] },
        { metric: 'jumps', system_ids: [30000142, 30002187] },
      ],
    },
    {
      tool: 'doctrine_summary',
      calls: [
        { entity_id: 99000001, entity_type: 'alliance', from: '2026-07-01T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z', top: 5 },
        { entity_id: 99000002, entity_type: 'alliance', from: '2026-07-01T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z', top: 5 },
      ],
    },
    {
      tool: 'dynamic_item_summary',
      calls: [
        { type_id: 49726, item_id: 1000000001, attribute_ids: [9, 37] },
        { type_id: 49727, item_id: 1000000002, attribute_ids: [9, 37] },
      ],
    },
  ])('reserves a coherent two-call $tool program', async ({ tool, calls }) => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const { __test__ } = await import('../../src/agent/executor.js');
    const caller = { type: 'program', caller_id: `prog_${tool}` };
    const extracted = calls.map((args, index) => ({
      callId: `${tool}_${index}`,
      name: tool,
      argumentsText: JSON.stringify(args),
      caller,
    }));

    const result = __test__.validateProgrammaticBatch(
      extracted,
      new Set([caller.caller_id]),
      0,
      new Map(),
    );
    expect(result.reservedProgrammaticCalls).toBe(2);
    expect(result.rejections.filter(Boolean)).toHaveLength(0);
    expect(result.normalizedArgs.filter(Boolean)).toHaveLength(2);
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

  it.each(['failed', 'incomplete', 'cancelled', 'queued'])(
    'does not dispatch or account for tools from a %s response envelope',
    async (status) => {
      process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
      vi.resetModules();
      createNativeResponseMock.mockResolvedValueOnce({
        ...outputResponse([
          { type: 'program', call_id: 'must_not_register', code: 'hosted' },
          {
            type: 'function_call',
            call_id: 'must_not_run',
            name: 'count_universe_objects',
            arguments: '{"target_kind":"region","target_name":"The Forge","object_kind":"systems"}',
            caller: { type: 'program', caller_id: 'must_not_register' },
          },
        ]),
        status,
      });
      const activityTypes: string[] = [];
      const { runWithActivitySink } = await import('../../src/agent/activity.js');

      const result = await runWithActivitySink(
        { emit: (event) => activityTypes.push(event.type) },
        () => runLoop(),
      );

      expect(result.text).toContain('временно недоступен');
      expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
      expect(activityTypes).not.toContain('tool_start');
      expect(activityTypes).not.toContain('programmatic_tool_batch');
      expect(db.prepare('SELECT last_response_id FROM agent_threads WHERE thread_id = ?').get('t1'))
        .toEqual({ last_response_id: null });
    },
  );

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

  it.each([false, true])(
    'keeps direct bounded public facades callable and redacts audit values when PTC enabled=%s',
    async (programmaticEnabled) => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = String(programmaticEnabled);
    vi.resetModules();
    const calls = [
      ['market_history_summary', { region_id: 10000002, type_id: 34, days: 7 }],
      ['system_metric_snapshot', { metric: 'kills', system_ids: [30000142, 30002187], extra: 44 }],
      ['doctrine_summary', {
        scope: 'alliance', id: 1354830081, from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-02T00:00:00.000Z', top: 0,
      }],
      ['dynamic_item_summary', { type_id: 49722, item_id: 987654321, attribute_ids: [] }],
    ].map(([name, args], index) => ({
      type: 'function_call',
      call_id: `facade_${index}`,
      name,
      arguments: JSON.stringify(args),
    }));
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse(calls))
      .mockResolvedValueOnce(textResponse('redacted'));

    expect((await runLoop()).text).toBe('redacted');
    const rows = db.prepare(
      "SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id",
    ).all('t1') as Array<{ content: string }>;
    expect(rows).toHaveLength(4);
    const audits = rows.map((row) => JSON.parse(row.content) as Record<string, unknown>);
    expect(audits.map((audit) => audit.tool)).toEqual(calls.map((call) => call.name));
    for (const audit of audits) {
      const args = audit.args as Record<string, unknown>;
      expect(args).toEqual({ classification: 'bounded-public-read' });
    }
    const persisted = JSON.stringify(audits);
    for (const privateValue of ['10000002', '30000142', '1354830081', '987654321']) {
      expect(persisted).not.toContain(privateValue);
    }
    },
  );

  it('persists only bounded metadata for a successful direct facade result', async () => {
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'true';
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      system_id: 30000142,
      ship_kills: 7,
      npc_kills: 11,
      pod_kills: 3,
    }]), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        expires: new Date(Date.now() + 60_000).toUTCString(),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    createNativeResponseMock
      .mockResolvedValueOnce(outputResponse([{
        type: 'function_call',
        call_id: 'facade_success',
        name: 'system_metric_snapshot',
        arguments: JSON.stringify({ metric: 'kills', system_ids: [30000142] }),
      }]))
      .mockResolvedValueOnce(textResponse('bounded'));

    try {
      expect((await runLoop()).text).toBe('bounded');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const row = db.prepare(
        "SELECT content FROM messages WHERE thread_id = ? AND role = 'tool'",
      ).get('t1') as { content: string };
      const audit = JSON.parse(row.content) as Record<string, unknown>;
      expect(audit).toMatchObject({
        tool: 'system_metric_snapshot',
        args: { classification: 'bounded-public-read' },
        result: { ok: true, blocked: false, schema_valid: true },
      });
      expect((audit.result as Record<string, unknown>).output_chars).toEqual(expect.any(Number));
      expect(row.content).not.toContain('30000142');
      expect(row.content).not.toContain('ship_kills');
      expect(row.content).not.toContain('npc_kills');
      expect(row.content).not.toContain('pod_kills');
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

describe('server-side Responses continuation', () => {
  beforeEach(() => {
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';
    process.env.OPENAI_STORE_RESPONSES = 'true';
    vi.resetModules();
  });

  it('retries transport failures with the exact same previous response and input', async () => {
    createNativeResponseMock
      .mockResolvedValueOnce({ ...toolCallResponse('call_1', 'SELECT 1'), status: 'completed' })
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ...textResponse('готово'), status: 'completed' });

    const result = await runLoop();

    expect(result.text).toBe('готово');
    expect(createNativeResponseMock).toHaveBeenCalledTimes(3);
    expect(createNativeResponseMock.mock.calls[2][0].previousResponseId)
      .toBe(createNativeResponseMock.mock.calls[1][0].previousResponseId);
    expect(createNativeResponseMock.mock.calls[2][0].items)
      .toEqual(createNativeResponseMock.mock.calls[1][0].items);
  });

  it('replays the exact active turn after explicit provider state loss', async () => {
    createNativeResponseMock
      .mockResolvedValueOnce({ ...toolCallResponse('call_1', 'SELECT 1'), status: 'completed' })
      .mockResolvedValueOnce(errorResponse('response_state_missing'))
      .mockResolvedValueOnce({ ...textResponse('восстановлено'), status: 'completed' });

    const result = await runLoop();

    expect(result.text).toBe('восстановлено');
    const chained = createNativeResponseMock.mock.calls[1][0];
    const recovered = createNativeResponseMock.mock.calls[2][0];
    expect(chained.previousResponseId).toBe('resp_call_1');
    expect(recovered.previousResponseId).toBeNull();
    const replay = JSON.stringify(recovered.items);
    expect(replay).toContain(GOAL);
    expect(replay).toContain('call_1');
    expect(replay).toContain('function_call_output');
  });

  it('does not dispatch a server-side function call without a completed response id', async () => {
    createNativeResponseMock.mockResolvedValueOnce({
      ...toolCallResponse('call_unanchored', 'SELECT 1'),
      id: null,
      status: 'completed',
    });

    const result = await runLoop();

    expect(result.text).toContain('provider did not return response id');
    const toolRows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get() as { n: number };
    expect(toolRows.n).toBe(0);
  });

  it('stores the final response id atomically with its assistant-message anchor', async () => {
    createNativeResponseMock.mockResolvedValueOnce({ ...textResponse('anchored'), status: 'completed' });

    await runLoop();

    const row = db.prepare(
      `SELECT t.last_response_id, t.last_response_message_id, m.content
       FROM agent_threads t
       LEFT JOIN messages m ON m.id = t.last_response_message_id
       WHERE t.thread_id = ?`,
    ).get('t1') as {
      last_response_id: string | null;
      last_response_message_id: number | null;
      content: string | null;
    };
    expect(row).toMatchObject({ last_response_id: 'resp_final', content: 'anchored' });
    expect(row.last_response_message_id).not.toBeNull();
  });

  it('stores the latest server-chain input size instead of double-counting it', async () => {
    db.prepare('UPDATE agent_threads SET total_tokens = 9000 WHERE thread_id = ?').run('t1');
    createNativeResponseMock.mockResolvedValueOnce({ ...textResponse('sized'), status: 'completed' });
    const { handleAgentMessage } = await import('../../src/agent/executor.js');

    await handleAgentMessage(db as never, 't1', { userId: 1, chatId: 1 }, GOAL);

    const row = db.prepare('SELECT total_tokens FROM agent_threads WHERE thread_id = ?').get('t1') as { total_tokens: number };
    expect(row.total_tokens).toBe(1200);
  });

  it('reuses a completed write result when cold recovery repeats the same call', async () => {
    const watchArgs = JSON.stringify({
      action: 'watch',
      topic_type: 'system',
      topic_id: 30000142,
      label: 'Jita',
    });
    const watchCall = (callId: string) => ({
      ...outputResponse([{
        type: 'function_call', call_id: callId, name: 'kill_watch', arguments: watchArgs,
      }], `resp_${callId}`),
      status: 'completed',
    });
    createNativeResponseMock
      .mockResolvedValueOnce(watchCall('watch_1'))
      .mockResolvedValueOnce(errorResponse('response_state_missing'))
      .mockResolvedValueOnce(watchCall('watch_2'))
      .mockResolvedValueOnce({ ...textResponse('watch ready'), status: 'completed' });
    const starts: string[] = [];
    const { __test__ } = await import('../../src/agent/executor.js');
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    const result = await runWithActivitySink(
      { emit: (event) => { if (event.type === 'tool_start') starts.push(event.name); } },
      () => __test__.runNativeAgentLoop(
        db as never,
        't1',
        { userId: 1, chatId: 1 },
        GOAL,
        'developer prompt',
        () => 'developer prompt',
      ),
    );

    expect(result.text).toBe('watch ready');
    expect(starts.filter((name) => name === 'kill_watch')).toHaveLength(1);
    const watches = db.prepare('SELECT COUNT(*) AS n FROM kill_watches').get() as { n: number };
    expect(watches.n).toBe(1);
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

  it.each(['failed', 'incomplete'])(
    'retries a transient %s envelope without processing its returned tool call',
    async (status) => {
      createNativeResponseMock
        .mockResolvedValueOnce({
          ...outputResponse([{
            type: 'function_call',
            call_id: `must_not_dispatch_${status}`,
            name: 'sde_sql',
            arguments: '{"sql":"SELECT 1"}',
          }]),
          status,
          error: { message: 'HTTP 503: Service Unavailable' },
        })
        .mockResolvedValueOnce(textResponse('ответ после безопасного ретрая'));
      const activity: Array<{ type: string; iteration?: number }> = [];
      const { runWithActivitySink } = await import('../../src/agent/activity.js');

      const result = await runWithActivitySink(
        { emit: (event) => activity.push(event) },
        () => runLoop(),
      );

      expect(result.text).toBe('ответ после безопасного ретрая');
      expect(createNativeResponseMock).toHaveBeenCalledTimes(2);
      const firstRequest = createNativeResponseMock.mock.calls[0][0];
      const retriedRequest = createNativeResponseMock.mock.calls[1][0];
      expect(retriedRequest.items).toEqual(firstRequest.items);
      expect(retriedRequest.previousResponseId ?? null).toBe(firstRequest.previousResponseId ?? null);
      expect(activity.filter((event) => event.type === 'model_turn').map((event) => event.iteration))
        .toEqual([0, 0]);
      expect(activity.some((event) => event.type === 'tool_start')).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
      expect(JSON.stringify(db.prepare('SELECT content FROM messages ORDER BY id').all()))
        .not.toContain(`must_not_dispatch_${status}`);
    },
  );

  it('sanitizes a non-recoverable payload error before status or output handling', async () => {
    const providerDetail = 'private-provider-detail-must-not-escape';
    createNativeResponseMock.mockResolvedValueOnce({
      ...outputResponse([{
        type: 'function_call',
        call_id: 'must_not_dispatch_permanent',
        name: 'sde_sql',
        arguments: '{"sql":"SELECT 1"}',
      }]),
      status: 'failed',
      error: { message: `HTTP 400: ${providerDetail}` },
    });
    const activityTypes: string[] = [];
    const { runWithActivitySink } = await import('../../src/agent/activity.js');

    const result = await runWithActivitySink(
      { emit: (event) => activityTypes.push(event.type) },
      () => runLoop(),
    );

    expect(result.text).toContain('временно недоступен');
    expect(result.text).not.toContain(providerDetail);
    expect(activityTypes).not.toContain('tool_start');
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'tool'").get()).toEqual({ n: 0 });
    expect(JSON.stringify(db.prepare('SELECT content FROM messages ORDER BY id').all()))
      .not.toContain(providerDetail);
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
