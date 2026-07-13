import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('runMigrations', () => {
  it('does not auto-link the first global EVE account to unrelated Telegram sessions', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(10, 'u1');
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(11, 'u2');
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'Pilot', 'tok', 'ref', '[]');

    runMigrations(db);

    const sessions = db.prepare(
      'SELECT chat_id, active_character_id FROM telegram_sessions ORDER BY chat_id'
    ).all() as Array<{ chat_id: number; active_character_id: number | null }>;
    const links = db.prepare(
      'SELECT chat_id, character_id FROM eve_character_links ORDER BY chat_id, character_id'
    ).all() as Array<{ chat_id: number; character_id: number }>;

    expect(sessions).toEqual([
      { chat_id: 10, active_character_id: null },
      { chat_id: 11, active_character_id: null },
    ]);
    expect(links).toEqual([]);
  });

  it('migrates a legacy pre-user_id DB whose agent_threads lacks the user_id column', () => {
    // Simulate an old production DB: agent_threads without user_id, plus an
    // inline SCHEMA_SQL index (idx_agent_threads_user) that references it.
    const legacyDb = new Database(':memory:');
    legacyDb.pragma('foreign_keys = ON');
    legacyDb.exec(`
      CREATE TABLE users (user_id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL, active_character_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE web_sessions (session_id TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT, created_at TEXT);
      CREATE TABLE telegram_login_attempts (nonce TEXT PRIMARY KEY, created_at TEXT, expires_at TEXT, used_at TEXT);
      CREATE TABLE telegram_sessions (chat_id INTEGER PRIMARY KEY, username TEXT, oauth_state TEXT, active_character_id INTEGER, last_seen_at TEXT);
      CREATE TABLE agent_threads (thread_id TEXT PRIMARY KEY, chat_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, role TEXT, content TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE eve_accounts (character_id INTEGER PRIMARY KEY, character_name TEXT, access_token TEXT, refresh_token TEXT, expires_at TEXT, scopes_json TEXT DEFAULT '[]');
      CREATE TABLE eve_character_links (chat_id INTEGER, character_id INTEGER, linked_at TEXT, PRIMARY KEY (chat_id, character_id));
      CREATE TABLE esi_cache (cache_key TEXT PRIMARY KEY, response_text TEXT, expires_at TEXT, created_at TEXT);
    `);
    legacyDb.prepare("INSERT INTO telegram_sessions (chat_id, username, oauth_state, active_character_id) VALUES (?, ?, ?, ?)").run(1001, 'pilotA', 'stale-state', 90000001);
    legacyDb.prepare("INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json) VALUES (?, ?, ?, ?, datetime('now','+1 hour'), ?)").run(90000001, 'Char A', 'enc:v1:x', 'enc:v1:y', '[]');
    legacyDb.prepare("INSERT INTO eve_character_links (chat_id, character_id, linked_at) VALUES (?, ?, datetime('now'))").run(1001, 90000001);
    legacyDb.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t-legacy', 1001);

    // Must not throw on a legacy schema.
    expect(() => runMigrations(legacyDb)).not.toThrow();

    const cols = (legacyDb.prepare('PRAGMA table_info(agent_threads)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('user_id');
    expect(legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_sessions'").get()).toBeUndefined();
    const link = legacyDb.prepare('SELECT user_id FROM eve_character_links WHERE chat_id = 1001').get() as { user_id: number | null };
    expect(link.user_id).toBeGreaterThan(0);
    legacyDb.close();
  });

  it('does not fabricate a Telegram account for Discord (negative) chat lanes', () => {
    // Discord DM lanes reuse telegram_sessions with negative chat keys.
    db.prepare("INSERT INTO users (user_id, display_name) VALUES (1, 'discord-user')").run();
    db.prepare("INSERT INTO discord_accounts (discord_user_id, user_id, username) VALUES ('123456789012345678', 1, 'dc')").run();
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (-1, 'dc-lane')").run();
    db.prepare("INSERT INTO discord_sessions (discord_channel_id, discord_user_id, user_id, chat_key, username) VALUES ('998', '123456789012345678', 1, -1, 'dc')").run();

    runMigrations(db);
    runMigrations(db); // second boot must stay idempotent

    const bogus = db.prepare('SELECT COUNT(*) AS n FROM telegram_accounts WHERE telegram_user_id <= 0').get() as { n: number };
    expect(bogus.n).toBe(0);
    // The Discord user identity is not duplicated.
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(users.n).toBe(1);
  });
});
