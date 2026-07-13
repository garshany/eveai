import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

// Mock ONLY the network call; keep the real item builders/helpers so the loop
// under test assembles input exactly as production does.
const { createNativeResponseMock, runPreTurnCompactMock } = vi.hoisted(() => ({
  createNativeResponseMock: vi.fn(),
  runPreTurnCompactMock: vi.fn(),
}));
vi.mock('../../src/agent/native-responses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/native-responses.js')>();
  return { ...actual, createNativeResponse: createNativeResponseMock };
});
vi.mock('../../src/agent/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/compact.js')>();
  return { ...actual, runPreTurnCompact: runPreTurnCompactMock };
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
  process.env.OPENAI_REASONING_EFFORT = 'auto';
  process.env.OPENAI_REASONING_MODE = 'standard';
  process.env.AUTH_SECRET_KEY = 'test-secret';
  vi.resetModules();
  createNativeResponseMock.mockReset();
  runPreTurnCompactMock.mockReset();
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

describe('stateless tool loop context accumulation', () => {
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
});

describe('runPreTurnCompactSafe', () => {
  it('swallows compaction failure instead of failing the turn', async () => {
    runPreTurnCompactMock.mockRejectedValueOnce(new Error('summarizer down'));
    const { __test__ } = await import('../../src/agent/executor.js');
    await expect(__test__.runPreTurnCompactSafe(db as never, 't1')).resolves.toBeUndefined();
    expect(runPreTurnCompactMock).toHaveBeenCalledTimes(1);
  });
});
