import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: {
      apiKey: 'test', model: 'test', baseUrl: '', apiMode: 'native_responses',
      reasoningEffort: '', store: true, compactThreshold: 100000,
    },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    security: { allowWebAuth: true },
    esi: { maxPages: 5, backoffMaxSeconds: 10 },
    userProfile: { path: './data/USER.md', refreshSeconds: 300 },
    market: { defaultRegionId: 10000002, defaultRegionName: 'The Forge' },
    compact: { messageThreshold: 50, tokenRatio: 0.6, tokenBudget: 8000, keepLast: 10, maxInputChars: 20000 },
    zkill: { baseUrl: '', timeoutMs: 5000, cacheTtlSeconds: 300, maxPastSeconds: 604800, userAgent: 'test' },
  },
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('warm/cold path DB operations', () => {
  it('new thread has null last_response_id', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);

    const row = db.prepare('SELECT last_response_id FROM agent_threads WHERE thread_id = ?').get('t1') as any;
    expect(row.last_response_id).toBeNull();
  });

  it('saves and retrieves last_response_id', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);

    db.prepare("UPDATE agent_threads SET last_response_id = ? WHERE thread_id = ?")
      .run('resp_abc123', 't1');

    const row = db.prepare('SELECT last_response_id FROM agent_threads WHERE thread_id = ?').get('t1') as any;
    expect(row.last_response_id).toBe('resp_abc123');
  });

  it('clear conversation resets last_response_id (by deleting thread)', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);
    db.prepare("UPDATE agent_threads SET last_response_id = ? WHERE thread_id = ?")
      .run('resp_abc123', 't1');

    // Simulate /clear
    db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(1);
    db.prepare('DELETE FROM agent_threads WHERE chat_id = ?').run(1);

    const row = db.prepare('SELECT * FROM agent_threads WHERE thread_id = ?').get('t1');
    expect(row).toBeUndefined();
  });

  it('cold start history includes both user and assistant messages', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);

    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'Привет');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'Привет! Чем помочь?');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'tool', '{"tool":"sde_sql"}');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'Где я?');

    // Cold start query (same as executor.ts)
    const rows = db.prepare(
      "SELECT role, content FROM messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY created_at ASC"
    ).all('t1') as Array<{ role: string; content: string }>;

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ role: 'user', content: 'Привет' });
    expect(rows[1]).toEqual({ role: 'assistant', content: 'Привет! Чем помочь?' });
    expect(rows[2]).toEqual({ role: 'user', content: 'Где я?' });
  });

  it('uses previous_response_id for fresh warm continuations', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id, last_response_id) VALUES (?, ?, ?)")
      .run('t1', 1, 'resp_abc123');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'Привет! Чем помочь?');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'Покажи кошелек');

    const { __test__ } = await import('../../src/agent/executor.js');
    const continuation = __test__.planConversationContinuation(db as never, 't1');

    expect(continuation.mode).toBe('warm');
    expect(continuation.previousResponseId).toBe('resp_abc123');
    expect(continuation.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Покажи кошелек' }],
      },
    ]);
  });

  it('falls back to cold history when previous_response_id is stale', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id) VALUES (?)").run(1);
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id, last_response_id) VALUES (?, ?, ?)")
      .run('t1', 1, 'resp_old');
    db.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', '-2 hours'))")
      .run('t1', 'user', 'Старое сообщение');
    db.prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', '-2 hours'))")
      .run('t1', 'assistant', 'Старый ответ');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'Новый вопрос');

    const { __test__ } = await import('../../src/agent/executor.js');
    const continuation = __test__.planConversationContinuation(db as never, 't1');

    expect(continuation.mode).toBe('cold');
    expect(continuation.previousResponseId).toBeNull();
    expect(continuation.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Старое сообщение' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Старый ответ' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Новый вопрос' }],
      },
    ]);
  });
});

describe('native-responses payload', () => {
  it('toNativeMessage creates user input item', async () => {
    const { toNativeMessage } = await import('../../src/agent/native-responses.js');
    const item = toNativeMessage('hello');
    expect(item).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    });
  });

  it('toNativeAssistantMessage creates assistant output item', async () => {
    const { toNativeAssistantMessage } = await import('../../src/agent/native-responses.js');
    const item = toNativeAssistantMessage('hi there');
    expect(item).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi there' }],
    });
  });
});
