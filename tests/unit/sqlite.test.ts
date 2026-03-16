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

describe('SQLite schema', () => {
  it('creates all core tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('telegram_sessions');
    expect(names).toContain('agent_threads');
    expect(names).toContain('messages');
    expect(names).toContain('eve_accounts');
    expect(names).toContain('plans');
    expect(names).toContain('plan_steps');
    expect(names).toContain('esi_cache');
    expect(names).toContain('sde_meta');
    expect(names).toContain('thread_summaries');
    expect(names).toContain('thread_artifacts');
  });

  it('creates SDE tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sde_%'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('sde_types');
    expect(names).toContain('sde_groups');
    expect(names).toContain('sde_regions');
    expect(names).toContain('sde_systems');
    expect(names).toContain('sde_blueprints');
    expect(names).toContain('sde_raw_records');
  });

  it('inserts and reads telegram_sessions', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(123, 'testuser');
    const row = db.prepare('SELECT * FROM telegram_sessions WHERE chat_id = ?').get(123) as { chat_id: number; username: string };
    expect(row.chat_id).toBe(123);
    expect(row.username).toBe('testuser');
  });

  it('inserts and reads messages with foreign key', () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)").run(1, 'u');
    db.prepare("INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)").run('t1', 1);
    db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('t1', 'user', 'hello');

    const msgs = db.prepare('SELECT * FROM messages WHERE thread_id = ?').all('t1') as { role: string; content: string }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('hello');
  });

  it('inserts and reads eve_accounts', () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(12345, 'TestPilot', 'tok', 'ref', '["esi-wallet.read_character_wallet.v1"]');

    const acc = db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(12345) as {
      character_name: string;
      scopes_json: string;
    };
    expect(acc.character_name).toBe('TestPilot');
    expect(JSON.parse(acc.scopes_json)).toContain('esi-wallet.read_character_wallet.v1');
  });

  it('inserts and reads plans with steps', () => {
    db.prepare("INSERT INTO plans (request_id, goal) VALUES (?, ?)").run('r1', 'test goal');
    db.prepare(`
      INSERT INTO plan_steps (request_id, step_id, title, status, depends_on_json, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('r1', 's1', 'Step 1', 'pending', '[]', '');

    const steps = db.prepare('SELECT * FROM plan_steps WHERE request_id = ?').all('r1') as { step_id: string; title: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe('Step 1');
  });

  it('enforces foreign key on messages', () => {
    expect(() => {
      db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)").run('nonexistent', 'user', 'x');
    }).toThrow();
  });
});
