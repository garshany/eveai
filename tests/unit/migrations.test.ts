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
});
