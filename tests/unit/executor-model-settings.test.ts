import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import { saveUserModelSettings } from '../../src/user-model-settings.js';
import { READ_SUBAGENT_SYSTEM_PROMPT } from '../../src/agent/read-subagents.js';

// Same harness as executor-loop.test.ts / usage-tracker.test.ts: mock only the
// network boundary so the real loop resolves and applies the per-user settings.
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

let db: Database.Database;

beforeEach(() => {
  createNativeResponseMock.mockReset();
  runPreTurnCompactMock.mockReset();
  runMidTurnCompactMock.mockReset();
  runMidTurnCompactMock.mockResolvedValue(undefined);
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(1, 'u');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, total_tokens) VALUES (?, ?, ?)').run('t1', 1, 0);
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run('t1', 'user', 'привет');
  createNativeResponseMock.mockResolvedValue({
    id: 'resp_final',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ответ' }] }],
    outputText: 'ответ',
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: { input: 100, output: 20, cached: 0, reasoning: 0 },
  });
});

afterEach(() => {
  db.close();
});

function addUser(): number {
  const result = db.prepare("INSERT INTO users (display_name) VALUES ('capsuleer')").run();
  return Number(result.lastInsertRowid);
}

async function runTurn(userId: number) {
  const { __test__ } = await import('../../src/agent/executor.js');
  await __test__.runNativeAgentLoop(
    db as never,
    't1',
    { userId, chatId: 1 },
    'привет',
    'developer prompt',
    () => 'developer prompt',
  );
  // Always the LAST call: a previous runTurn in the same test already
  // populated calls[0], and reading it would assert the wrong user's payload.
  return createNativeResponseMock.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('executor: per-user model settings', () => {
  it('applies the saved model, effort and verbosity to the model call and the usage event', async () => {
    const userId = addUser();
    saveUserModelSettings(db, userId, {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verbosity: 'high',
    });

    const payload = await runTurn(userId);
    expect(payload.model).toBe('gpt-5.6-luna');
    expect(payload.textVerbosity).toBe('high');
    expect(payload.reasoningEffort).toBe('low');

    // The usage event must carry the APPLIED model so per-model tariffs price
    // the event correctly — never the config default.
    const event = db.prepare('SELECT * FROM usage_events').get() as Record<string, unknown>;
    expect(event.user_id).toBe(userId);
    expect(event.model).toBe('gpt-5.6-luna');
  });

  it('uses the config defaults when the user has no saved row', async () => {
    const userId = addUser();
    const payload = await runTurn(userId);
    expect(payload.model).toBe(config.openai.model);
    expect(payload.textVerbosity).toBe(config.openai.textVerbosity);

    const event = db.prepare('SELECT * FROM usage_events').get() as Record<string, unknown>;
    expect(event.model).toBe(config.openai.model);
  });

  it('resolves settings per user: another user on the same lane stays on defaults', async () => {
    const customized = addUser();
    const plain = addUser();
    saveUserModelSettings(db, customized, {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      verbosity: 'high',
    });

    const customPayload = await runTurn(customized);
    expect(customPayload.model).toBe('gpt-5.6-sol');
    expect(customPayload.reasoningEffort).toBe('max');

    const plainPayload = await runTurn(plain);
    expect(plainPayload.model).toBe(config.openai.model);
  });

  it('delegated read subagents run on the user model and write usage events', async () => {
    const userId = addUser();
    saveUserModelSettings(db, userId, {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verbosity: 'high',
    });

    const delegateArgs = JSON.stringify({
      tasks: [
        { id: 'forge', objective: 'Count systems in The Forge', tool_hints: ['count_universe_objects'] },
        { id: 'domain', objective: 'Count systems in Domain region', tool_hints: ['count_universe_objects'] },
      ],
    });
    const subagentUsage = { input: 7, output: 3, cached: 0, reasoning: 0 };
    const message = (id: string, text: string, usage: Record<string, number>) => ({
      id,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      outputText: text,
      error: null,
      toolSearchPaths: [],
      rawEvents: [],
      usage,
      status: 'completed',
    });
    createNativeResponseMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.instructions === READ_SUBAGENT_SYSTEM_PROMPT) {
        return message('resp_sub', 'нет данных', subagentUsage);
      }
      const items = input.items as Array<{ type: string }>;
      if (!items.some((item) => item.type === 'function_call_output')) {
        return {
          ...message('resp_delegate', '', { input: 50, output: 10, cached: 0, reasoning: 0 }),
          output: [{
            type: 'function_call',
            call_id: 'call_delegate',
            name: 'delegate_read_subagents',
            arguments: delegateArgs,
          }],
        };
      }
      return message('resp_final', 'ответ', { input: 60, output: 12, cached: 0, reasoning: 0 });
    });

    const previous = config.openai.readSubagentsEnabled;
    config.openai.readSubagentsEnabled = true;
    try {
      await runTurn(userId);
    } finally {
      config.openai.readSubagentsEnabled = previous;
    }

    const subagentCalls = createNativeResponseMock.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((payload) => payload.instructions === READ_SUBAGENT_SYSTEM_PROMPT);
    expect(subagentCalls.length).toBeGreaterThan(0);
    for (const payload of subagentCalls) {
      expect(payload.model).toBe('gpt-5.6-luna');
    }

    const events = db.prepare('SELECT * FROM usage_events ORDER BY event_id').all() as Array<Record<string, unknown>>;
    const subagentEvents = events.filter((event) => event.input_tokens === 7);
    expect(subagentEvents).toHaveLength(subagentCalls.length);
    for (const event of subagentEvents) {
      expect(event.user_id).toBe(userId);
      expect(event.thread_id).toBe('t1');
      expect(event.channel).toBe('telegram');
      expect(event.model).toBe('gpt-5.6-luna');
    }
  });
});
