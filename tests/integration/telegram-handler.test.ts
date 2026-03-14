import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

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
});
