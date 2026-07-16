import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import {
  clearChatConversation,
  clearInFlightRequest,
  hasInFlightRequestForActor,
  rememberInFlightRequest,
  resetChatRequestGuardForTests,
} from '../../src/chat/shared.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
});

afterEach(() => {
  resetChatRequestGuardForTests();
  db.close();
});

describe('multi-platform actor isolation', () => {
  it('allows only one active request for the same user across different chat lanes', () => {
    rememberInFlightRequest(42, 'telegram-thread', 'one', 'token', 1_000, 7);
    expect(hasInFlightRequestForActor(-99, 7)).toBe(true);
    expect(hasInFlightRequestForActor(-99, 8)).toBe(false);
    clearInFlightRequest(42, 'token');
    expect(hasInFlightRequestForActor(-99, 7)).toBe(false);
  });
});

describe('clearChatConversation', () => {
  it('wipes conversation history but preserves manual kill watches', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (42, 'pilot')").run();
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES ('t1', 42, 1)").run();
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES ('t1', 'user', 'hi')").run();
    db.prepare("INSERT INTO thread_summaries (thread_id, summary, last_message_id) VALUES ('t1', 's', 1)").run();
    // A manual kill-watch subscription (not a route-created one).
    db.prepare("INSERT INTO kill_watches (chat_id, topic, label) VALUES (42, 'system.30000142', 'Jita')").run();

    const cleared = clearChatConversation(db, 42);

    expect(cleared).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_threads WHERE chat_id = 42").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1'").get()).toEqual({ n: 0 });
    // The persistent kill watch must survive — it is not conversation state.
    const watches = db.prepare("SELECT topic FROM kill_watches WHERE chat_id = 42").all() as Array<{ topic: string }>;
    expect(watches.map((w) => w.topic)).toEqual(['system.30000142']);
  });
});
