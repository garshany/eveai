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
  process.env.OPENAI_MODEL_CONTEXT_WINDOW = '200000';
  process.env.OPENAI_COMPACT_THRESHOLD = '0';
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

describe('autoCompactLimit', () => {
  it('returns 90% of model context window by default', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '200000';
    process.env.OPENAI_COMPACT_THRESHOLD = '0';
    vi.resetModules();
    const { autoCompactLimit } = await import('../../src/agent/compact.js');
    expect(autoCompactLimit()).toBe(180_000); // 200K * 0.9
  });

  it('uses explicit override when smaller than 90% context window', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '200000';
    process.env.OPENAI_COMPACT_THRESHOLD = '100000';
    vi.resetModules();
    const { autoCompactLimit } = await import('../../src/agent/compact.js');
    expect(autoCompactLimit()).toBe(100_000); // min(100K, 180K)
  });

  it('caps override at 90% of context window', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '100000';
    process.env.OPENAI_COMPACT_THRESHOLD = '120000';
    vi.resetModules();
    const { autoCompactLimit } = await import('../../src/agent/compact.js');
    expect(autoCompactLimit()).toBe(90_000); // min(120K, 90K) = 90K
  });

  it('adapts to smaller model context window', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '32000';
    process.env.OPENAI_COMPACT_THRESHOLD = '0';
    vi.resetModules();
    const { autoCompactLimit } = await import('../../src/agent/compact.js');
    expect(autoCompactLimit()).toBe(28_800); // 32K * 0.9
  });
});

describe('pre-turn compaction', () => {
  it('does not trigger when total_tokens below autoCompactLimit', async () => {
    vi.resetModules();
    const { needsPreTurnCompaction, compactThread, getThreadSummary } = await import('../../src/agent/compact.js');

    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'hello');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'hi');
    // total_tokens = 0 (below 180K limit for 200K context)
    expect(needsPreTurnCompaction(db, 't1')).toBe(false);

    const changed = await compactThread(db, 't1', async () => 'summary');
    expect(changed).toBe(false); // only 2 messages, <= 2 guard
    expect(getThreadSummary(db, 't1')).toBe(null);
  });

  it('triggers pre-turn compaction when total_tokens >= autoCompactLimit', async () => {
    vi.resetModules();
    const { needsPreTurnCompaction, runPreTurnCompact, getThreadSummary } = await import('../../src/agent/compact.js');

    const longText = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', `reply ${i} ${longText}`);
    }
    // Set above 180K (90% of 200K)
    db.prepare('UPDATE agent_threads SET total_tokens = 190000 WHERE thread_id = ?').run('t1');

    expect(needsPreTurnCompaction(db, 't1')).toBe(true);

    const changed = await runPreTurnCompact(db, 't1', async ({ messages }) => {
      return `Summary of ${messages.length} messages`;
    });

    expect(changed).toBe(true);
    expect(getThreadSummary(db, 't1')).toContain('Summary of');

    const row = db.prepare('SELECT total_tokens FROM agent_threads WHERE thread_id = ?').get('t1') as { total_tokens: number };
    expect(row.total_tokens).toBe(0);
  });
});

describe('mid-turn compaction', () => {
  it('needsMidTurnCompaction returns true when input >= autoCompactLimit', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '200000';
    process.env.OPENAI_COMPACT_THRESHOLD = '0';
    vi.resetModules();
    const { needsMidTurnCompaction } = await import('../../src/agent/compact.js');

    expect(needsMidTurnCompaction(180_000)).toBe(true);
    expect(needsMidTurnCompaction(179_999)).toBe(false);
  });

  it('needsMidTurnCompaction adapts to smaller context window', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '128000';
    process.env.OPENAI_COMPACT_THRESHOLD = '0';
    vi.resetModules();
    const { needsMidTurnCompaction } = await import('../../src/agent/compact.js');

    // 128K * 0.9 = 115_200
    expect(needsMidTurnCompaction(115_200)).toBe(true);
    expect(needsMidTurnCompaction(115_199)).toBe(false);
  });

  it('runMidTurnCompact compacts and resets tokens', async () => {
    vi.resetModules();
    const { runMidTurnCompact, getThreadSummary } = await import('../../src/agent/compact.js');

    const longText = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', `reply ${i} ${longText}`);
    }

    const changed = await runMidTurnCompact(db, 't1', async ({ messages }) => {
      return `Mid-turn summary of ${messages.length} msgs`;
    });

    expect(changed).toBe(true);
    expect(getThreadSummary(db, 't1')).toContain('Mid-turn summary');

    const row = db.prepare('SELECT total_tokens, last_response_id FROM agent_threads WHERE thread_id = ?').get('t1') as
      { total_tokens: number; last_response_id: string | null };
    expect(row.total_tokens).toBe(0);
    expect(row.last_response_id).toBe(null);
  });
});

describe('compactThreadWithRetry', () => {
  it('retries on summarizer failure and eventually throws', async () => {
    vi.resetModules();
    const { compactThreadWithRetry } = await import('../../src/agent/compact.js');

    const longText = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', `reply ${i} ${longText}`);
    }

    let callCount = 0;
    const throwingSummarizer = async () => {
      callCount++;
      throw new Error('summarizer down');
    };

    await expect(compactThreadWithRetry(db, 't1', throwingSummarizer)).rejects.toThrow('summarizer down');
    expect(callCount).toBe(3); // 1 initial + 2 retries
  }, 15_000);

  it('succeeds on retry after initial failure', async () => {
    vi.resetModules();
    const { compactThreadWithRetry, getThreadSummary } = await import('../../src/agent/compact.js');

    const longText = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', `reply ${i} ${longText}`);
    }

    let callCount = 0;
    const flakySuccessSummarizer = async () => {
      callCount++;
      if (callCount === 1) throw new Error('transient failure');
      return 'recovered summary';
    };

    const changed = await compactThreadWithRetry(db, 't1', flakySuccessSummarizer);
    expect(changed).toBe(true);
    expect(callCount).toBe(2);
    expect(getThreadSummary(db, 't1')).toBe('recovered summary');
  }, 15_000);
});

describe('compactThread core', () => {
  it('compacts and preserves recent messages', async () => {
    vi.resetModules();
    const { compactThread, getThreadSummary } = await import('../../src/agent/compact.js');

    const longText = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', `reply ${i} ${longText}`);
    }

    const changed = await compactThread(db, 't1', async ({ messages }) => {
      return `Summary of ${messages.length} messages`;
    });

    expect(changed).toBe(true);
    const summary = getThreadSummary(db, 't1');
    expect(summary).toContain('Summary of');

    const row = db.prepare('SELECT total_tokens FROM agent_threads WHERE thread_id = ?').get('t1') as { total_tokens: number };
    expect(row.total_tokens).toBe(0);

    const remaining = db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t1') as
      Array<{ content: string }>;
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(40);
  });
});
