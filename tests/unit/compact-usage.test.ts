import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';

// Mock only the network boundary: the real defaultSummarizer must run so the
// compaction model call is billed to the thread owner's usage_events lane.
const { createNativeResponseMock } = vi.hoisted(() => ({
  createNativeResponseMock: vi.fn(),
}));
vi.mock('../../src/agent/native-responses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/native-responses.js')>();
  return { ...actual, createNativeResponse: createNativeResponseMock };
});

import { compactThread } from '../../src/agent/compact.js';

let db: Database.Database;
let userId: number;

beforeEach(() => {
  createNativeResponseMock.mockReset();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  userId = Number(db.prepare("INSERT INTO users (display_name) VALUES ('capsuleer')").run().lastInsertRowid);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(1, 'u');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, user_id, total_tokens) VALUES (?, ?, ?, ?)')
    .run('t1', 1, userId, 0);
  // Enough history to overflow the 20k-token keep window so a summarizer pass
  // actually runs.
  const longText = 'x'.repeat(4000);
  for (let i = 0; i < 30; i++) {
    db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run('t1', 'user', `msg ${i} ${longText}`);
    db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run('t1', 'assistant', `reply ${i} ${longText}`);
  }
  createNativeResponseMock.mockResolvedValue({
    id: 'resp_compact',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'сводка' }] }],
    outputText: 'сводка',
    error: null,
    toolSearchPaths: [],
    rawEvents: [],
    usage: { input: 30, output: 12, cached: 0, reasoning: 0 },
    status: 'completed',
  });
});

afterEach(() => {
  db.close();
});

describe('compaction usage accounting', () => {
  it('bills the compaction summary call to the thread owner on the config model', async () => {
    const changed = await compactThread(db, 't1');
    expect(changed).toBe(true);

    // The summarizer is an internal call: it deliberately runs on the
    // operator-configured model, NOT the user's saved one — but its spend is
    // recorded like any other event on the user's lane.
    const payload = createNativeResponseMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.model).toBeUndefined();

    const events = db.prepare('SELECT * FROM usage_events').all() as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      user_id: userId,
      thread_id: 't1',
      channel: 'telegram',
      model: config.openai.model,
      input_tokens: 30,
      output_tokens: 12,
    });
  });
});
