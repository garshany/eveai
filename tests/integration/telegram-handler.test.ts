import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    openai: { apiKey: 'test', model: 'test', baseUrl: '', apiMode: 'auto', reasoningEffort: '' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '0.0.0.0' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    security: { allowWebAuth: true },
    esi: { maxPages: 5, backoffMaxSeconds: 10 },
    userProfile: { path: './data/USER_{character_id}.md', refreshSeconds: 300 },
    market: { defaultRegionId: 10000002, defaultRegionName: 'The Forge' },
    webSearch: { timeoutMs: 8000, maxResults: 5 },
    compact: { messageThreshold: 50, tokenRatio: 0.6, tokenBudget: 8000, keepLast: 10, maxInputChars: 20000 },
  },
}));

import { clearInFlightRequest, isDuplicateInFlightRequest, rememberInFlightRequest } from '../../src/telegram/handlers.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('Telegram handler DB operations', () => {
  afterEach(() => {
    clearInFlightRequest(42);
  });

  it('creates a session on first message', () => {
    db.prepare(
      `INSERT INTO telegram_sessions (chat_id, username, last_seen_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET last_seen_at = datetime('now')`
    ).run(42, 'testuser');

    const row = db.prepare('SELECT * FROM telegram_sessions WHERE chat_id = ?').get(42) as {
      chat_id: number;
      username: string;
    };
    expect(row.chat_id).toBe(42);
    expect(row.username).toBe('testuser');
  });

  it('creates thread and stores message', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(42, 'u');
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 42);
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'What is Tritanium?');

    const msgs = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all('t1') as { content: string }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('What is Tritanium?');
  });

  it('reset clears threads and messages', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(42, 'u');
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 42);
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'test');

    // Simulate /reset
    db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(42);
    db.prepare('DELETE FROM agent_threads WHERE chat_id = ?').run(42);

    const threads = db.prepare('SELECT * FROM agent_threads WHERE chat_id = ?').all(42);
    const msgs = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all('t1');
    expect(threads).toHaveLength(0);
    expect(msgs).toHaveLength(0);
  });

  it('dedupes identical in-flight requests for the same thread', () => {
    rememberInFlightRequest(42, 't1', 'route to jita', 'tok-1', 1000);

    expect(isDuplicateInFlightRequest(42, 't1', 'route to jita', 2000)).toBe(true);
    expect(isDuplicateInFlightRequest(42, 't1', 'route to amarr', 2000)).toBe(false);
    expect(isDuplicateInFlightRequest(42, 't2', 'route to jita', 2000)).toBe(false);

    clearInFlightRequest(42, 'tok-1');
    expect(isDuplicateInFlightRequest(42, 't1', 'route to jita', 2000)).toBe(false);
  });
});
