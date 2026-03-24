import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

let db: Database.Database;

beforeEach(() => {
  process.env.ALLOWED_TELEGRAM_USER_ID = '1';
  process.env.TELEGRAM_BOT_TOKEN = 'test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.EVE_CLIENT_ID = 'test';
  process.env.EVE_CLIENT_SECRET = 'test';
  process.env.DEFAULT_MARKET_REGION_ID = '10000002';
  process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'u');
  db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);
});

afterEach(() => {
  db.close();
  vi.resetModules();
});

describe('compactThreadIfNeeded', () => {
  it('does nothing when below thresholds', async () => {
    vi.resetModules();
    process.env.COMPACT_MESSAGE_THRESHOLD = '10';
    process.env.COMPACT_KEEP_LAST = '5';
    process.env.COMPACT_TOKEN_RATIO = '0.9';
    process.env.COMPACT_TOKEN_BUDGET = '1000';
    process.env.COMPACT_MAX_INPUT_CHARS = '20000';

    const { compactThreadIfNeeded, getThreadSummary } = await import('../../src/agent/compact.js');

    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'hello');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'hi');

    const changed = await compactThreadIfNeeded(db, 't1', async () => 'summary');
    expect(changed).toBe(false);
    expect(getThreadSummary(db, 't1')).toBe(null);
  });

  it('creates summary and prunes old messages', async () => {
    vi.resetModules();
    process.env.COMPACT_MESSAGE_THRESHOLD = '3';
    process.env.COMPACT_KEEP_LAST = '1';
    process.env.COMPACT_TOKEN_RATIO = '0';
    process.env.COMPACT_TOKEN_BUDGET = '1';
    process.env.COMPACT_MAX_INPUT_CHARS = '20000';

    const { compactThreadIfNeeded, getThreadSummary } = await import('../../src/agent/compact.js');

    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'm1');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'm2');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'm3');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'm4');

    const changed = await compactThreadIfNeeded(db, 't1', async ({ messages }) => {
      return `Facts:\n- summarized ${messages.length} messages`;
    });

    expect(changed).toBe(true);
    const summary = getThreadSummary(db, 't1');
    expect(summary).toContain('summarized');

    const remaining = db.prepare("SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t1') as
      Array<{ role: string; content: string }>;
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe('m4');
  });
});
