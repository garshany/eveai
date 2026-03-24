import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

afterEach(() => {
  db.close();
});

describe('handleAgentMessage thread ownership', () => {
  it('rejects thread ids that belong to a different chat', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(10, 'u1');
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(11, 'u2');
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('thread-1', 10);

    const { handleAgentMessage } = await import('../../src/agent/executor.js');

    await expect(handleAgentMessage(db, 'thread-1', { userId: 0, chatId: 11 }, 'hello')).rejects.toThrow(
      'does not belong to chat 11',
    );
  });

  it('rejects thread reuse from another chat even for the same user', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(10, 'u1');
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(11, 'u1-alt');
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)").run('thread-2', 10, 7);

    const { handleAgentMessage } = await import('../../src/agent/executor.js');

    await expect(handleAgentMessage(db, 'thread-2', { userId: 7, chatId: 11 }, 'hello')).rejects.toThrow(
      'does not belong to chat 11',
    );
  });
});
