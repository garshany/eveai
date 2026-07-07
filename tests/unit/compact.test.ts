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
  it('never deletes messages that did not fit into the summarizer input budget', async () => {
    process.env.COMPACT_MAX_INPUT_CHARS = '20000';
    vi.resetModules();
    const { compactThread } = await import('../../src/agent/compact.js');

    const longText = 'x'.repeat(4000);
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', `msg ${i} ${longText}`);
    }
    const before = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1'").get() as { n: number };

    const seenBatches: number[] = [];
    const changed = await compactThread(db, 't1', async ({ messages }) => {
      seenBatches.push(messages.length);
      return `Summary of ${messages.length}`;
    });

    expect(changed).toBe(true);
    // Budget is 20K chars and every message is ~4K chars: one pass must not
    // swallow (and delete) more than ~5 messages.
    expect(seenBatches[0]).toBeLessThanOrEqual(5);

    const after = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1'").get() as { n: number };
    // Only the summarized prefix may be deleted.
    expect(before.n - after.n).toBe(seenBatches[0]);

    // A second pass continues from where the first stopped.
    const changedAgain = await compactThread(db, 't1', async ({ messages }) => {
      seenBatches.push(messages.length);
      return `Summary of ${messages.length}`;
    });
    expect(changedAgain).toBe(true);
    expect(seenBatches[1]).toBeLessThanOrEqual(5);
  });

  it('prunes stale tool messages even when there is nothing to summarize', async () => {
    vi.resetModules();
    const { compactThread } = await import('../../src/agent/compact.js');

    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'tool', `{"tool":"old_${i}"}`);
    }
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'q1');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'assistant', 'a1');
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'q2');

    const changed = await compactThread(db, 't1', async () => 'unused');
    expect(changed).toBe(false);

    const toolRows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1' AND role = 'tool'").get() as { n: number };
    expect(toolRows.n).toBe(0);
    const chatRows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1' AND role IN ('user','assistant')").get() as { n: number };
    expect(chatRows.n).toBe(3);
  });

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

    // Repeated passes drain the backlog down to the keep window without ever
    // deleting unsummarized messages.
    for (let pass = 0; pass < 20; pass++) {
      const again = await compactThread(db, 't1', async ({ messages }) => `Summary of ${messages.length} messages`);
      if (!again) break;
    }

    const remaining = db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY id ASC").all('t1') as
      Array<{ content: string }>;
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(40);
  });
});

describe('estimateTokens (Cyrillic-aware keep budget)', () => {
  it('counts ASCII ~chars/4 and Cyrillic ~2x higher (UTF-8 bytes/4)', async () => {
    const { estimateTokens } = await import('../../src/agent/compact.js');
    expect(estimateTokens('abcd')).toBe(1);          // 4 ASCII bytes / 4
    expect(estimateTokens('a'.repeat(40))).toBe(10); // 40 bytes / 4
    // Cyrillic is 2 UTF-8 bytes/char, so it counts ~2x higher than chars/4.
    const cyr = 'привет как дела друг';
    expect(estimateTokens(cyr)).toBeGreaterThan(Math.ceil(cyr.length / 4));
  });

  it('keeps fewer Cyrillic messages than the old chars/4 estimate would', async () => {
    process.env.OPENAI_MODEL_CONTEXT_WINDOW = '200000';
    process.env.OPENAI_COMPACT_THRESHOLD = '0';
    vi.resetModules();
    const { compactThread, estimateTokens } = await import('../../src/agent/compact.js');

    // 30 Cyrillic messages, each ~2000 chars (~4000 UTF-8 bytes). Under the
    // byte-aware estimate the 20k keep budget holds fewer than all 30 — whereas
    // chars/4 (~half the count) would have kept the whole backlog.
    const line = 'ассеты и цены '.repeat(140); // ~2000 chars, all Cyrillic
    for (let i = 0; i < 30; i++) {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)")
        .run('t1', i % 2 === 0 ? 'user' : 'assistant', `${i}: ${line}`);
    }
    expect(estimateTokens(line)).toBeGreaterThan(400); // byte-aware, well above chars/4

    await compactThread(db, 't1', async ({ messages }) => `Summary of ${messages.length} messages`);
    const kept = db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id = ? AND role IN ('user','assistant')")
      .get('t1') as { n: number };
    // Byte-aware budget keeps a bounded, smaller recent window (not all 30).
    expect(kept.n).toBeLessThan(30);
    expect(kept.n).toBeGreaterThan(0);
  });
});

describe('capOnLineBoundary (summary trim)', () => {
  it('cuts on a line boundary and never mid-bullet, within the cap', async () => {
    const { capOnLineBoundary } = await import('../../src/agent/compact.js');
    const bullets = Array.from({ length: 50 }, (_, i) => `- факт номер ${i} с деталями`).join('\n');
    const capped = capOnLineBoundary(bullets, 400);
    expect(capped.length).toBeLessThanOrEqual(400);
    expect(capped.endsWith('\n')).toBe(false);
    // Every kept line is a complete bullet — none truncated mid-line.
    expect(capped.split('\n').every((l) => l.startsWith('- факт'))).toBe(true);
    // Short input is returned unchanged.
    expect(capOnLineBoundary('short', 400)).toBe('short');
  });
});
