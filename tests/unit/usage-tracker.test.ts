import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';
import {
  recordModelUsageSafe,
  recordUsageEvent,
  resolveUsageChannel,
} from '../../src/usage/tracker.js';

// Same harness as executor-loop.test.ts: mock only the network call so the
// real loop runs and its accounting write is exercised end to end.
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
});

afterEach(() => {
  db.close();
});

describe('resolveUsageChannel', () => {
  it('maps chat lane ids to channels without trusting input', () => {
    expect(resolveUsageChannel(0)).toBe('cli');
    expect(resolveUsageChannel(1)).toBe('telegram');
    expect(resolveUsageChannel(913_370_000)).toBe('telegram');
    expect(resolveUsageChannel(-2_000_000_000)).toBe('web');
    expect(resolveUsageChannel(-2_000_000_417)).toBe('web');
    expect(resolveUsageChannel(-1)).toBe('discord');
    expect(resolveUsageChannel(-199_999)).toBe('discord');
  });
});

describe('recordModelUsageSafe', () => {
  it('writes the event with the resolved channel and NULL cost when untariffed', () => {
    recordModelUsageSafe(
      db,
      { userId: 7, chatId: -2_000_000_000 },
      'thread-x',
      { input: 5000, output: 600, cached: 400, cacheWrite: 100, reasoning: 60 },
      'gpt-5.6-sol',
    );
    const row = db.prepare('SELECT * FROM usage_events').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      user_id: 7,
      thread_id: 'thread-x',
      channel: 'web',
      input_tokens: 5000,
      output_tokens: 600,
      cached_tokens: 400,
      cache_write_tokens: 100,
      reasoning_tokens: 60,
      cost_micros: null, // no tariffs in the test env: unknown, never 0
    });
    expect(typeof row.created_at_ms).toBe('number');
  });

  it('never throws — a broken accounting path must not fail a user turn', () => {
    const bareDb = new Database(':memory:'); // no usage_events table at all
    expect(() => recordModelUsageSafe(
      bareDb,
      { userId: 1, chatId: 1 },
      'thread-x',
      { input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 },
      'gpt-5.6-sol',
    )).not.toThrow();
    bareDb.close();
  });
});

describe('executor accounting wiring', () => {
  it('records one usage event per model response during a real loop turn', async () => {
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
      usage: { input: 1200, output: 80, cached: 100, reasoning: 30 },
    });

    const { __test__ } = await import('../../src/agent/executor.js');
    await __test__.runNativeAgentLoop(
      db as never,
      't1',
      { userId: 1, chatId: 1 },
      'привет',
      'developer prompt',
      () => 'developer prompt',
    );

    const rows = db.prepare('SELECT * FROM usage_events').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 1,
      thread_id: 't1',
      channel: 'telegram',
      // Whatever model the config resolves to: pinning the id would re-break
      // this test on every default-model switch.
      model: config.openai.model,
      input_tokens: 1200,
      output_tokens: 80,
      cached_tokens: 100,
      cache_write_tokens: 0,
      reasoning_tokens: 30,
      cost_micros: null,
    });
  });
});
