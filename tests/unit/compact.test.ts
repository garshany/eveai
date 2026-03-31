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
  process.env.COMPACT_MAX_INPUT_CHARS = '20000';
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'u');
  db.prepare("INSERT INTO agent_threads (thread_id, chat_id, total_tokens) VALUES (?, ?, ?)").run('t1', 1, 0);
});

afterEach(() => {
  db.close();
  vi.resetModules();
});

describe('compaction', () => {
  it('does nothing when total_tokens below 100K', async () => {
    vi.resetModules();
    const { needsCompaction, compactThread, getThreadSummary } = await import('../../src/agent/compact.js');

    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'hello');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'hi');
    // total_tokens = 0 (below 100K threshold)
    expect(needsCompaction(db, 't1')).toBe(false);

    const changed = await compactThread(db, 't1', async () => 'summary');
    // Still compacts if called directly (but needsCompaction guard prevents it in prod)
    expect(changed).toBe(false); // only 2 messages, <= 2 guard
    expect(getThreadSummary(db, 't1')).toBe(null);
  });

  it('triggers compaction when total_tokens >= 100K', async () => {
    vi.resetModules();
    const { needsCompaction, compactThread, getThreadSummary } = await import('../../src/agent/compact.js');

    // Insert messages with realistic size so some exceed the 20K keep token budget
    const longText = 'x'.repeat(4000); // ~1000 tokens each
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', `reply ${i} ${longText}`);
    }
    // Set total_tokens above threshold
    db.prepare('UPDATE agent_threads SET total_tokens = 120000 WHERE thread_id = ?').run('t1');

    expect(needsCompaction(db, 't1')).toBe(true);

    const changed = await compactThread(db, 't1', async ({ messages }) => {
      return `Summary of ${messages.length} messages`;
    });

    expect(changed).toBe(true);
    const summary = getThreadSummary(db, 't1');
    expect(summary).toContain('Summary of');

    // total_tokens should be reset to 0 after compaction
    const row = db.prepare('SELECT total_tokens FROM agent_threads WHERE thread_id = ?').get('t1') as { total_tokens: number };
    expect(row.total_tokens).toBe(0);

    // Recent messages should be kept
    const remaining = db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t1') as
      Array<{ content: string }>;
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(40); // some were deleted
  });
});
