import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { executeSdeSql } from '../../src/agent/tools.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare('INSERT INTO users (display_name) VALUES (?)').run('pilot');
  db.prepare('INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name) VALUES (?, ?, ?, ?)').run(1001, 1, 'pilot', 'Pilot');
  db.prepare('INSERT INTO auth_requests (state, type, user_id, chat_id, expires_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+10 minutes\'))').run('state-1', 'eve_sso', 1, 2001);
  db.prepare('INSERT INTO intel_notes (user_id, system_id, system_name, text) VALUES (?, ?, ?, ?)').run(1, 30000142, 'Jita', 'secret note');
  db.prepare('INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(2001, 'pilot');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id) VALUES (?, ?)').run('thread-1', 2001);
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run('thread-1', 'user', 'secret');
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
    VALUES (?, ?, ?, ?, datetime('now', '+1 hour'), ?)
  `).run(90000001, 'Pilot One', 'access-token', 'refresh-token', '[]');

  db.prepare('INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)').run(
    25,
    'Frigate',
    6,
    JSON.stringify({ group_id: 25, name: 'Frigate', category_id: 6 }),
  );
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)').run(
    587,
    'Rifter',
    25,
    JSON.stringify({ type_id: 587, name: 'Rifter', group_id: 25 }),
  );
  db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)').run(
    30000142,
    'Jita',
    20000020,
    JSON.stringify({ system_id: 30000142, name: 'Jita', security: 0.9 }),
  );
});

afterEach(() => {
  db.close();
});

describe('executeSdeSql security boundary', () => {
  it('allows read-only lookups against SDE tables', () => {
    const result = executeSdeSql(db as Db, "SELECT type_id, name FROM sde_types WHERE name = 'Rifter'");

    expect(result).toEqual({
      ok: true,
      rows: [{ type_id: 587, name: 'Rifter' }],
      count: 1,
      error: null,
    });
  });

  it('allows SDE joins and resolves aliases via query plan validation', () => {
    const result = executeSdeSql(
      db as Db,
      `
        SELECT t.name AS type_name, g.name AS group_name
        FROM sde_types AS t
        JOIN sde_groups AS g ON g.group_id = t.group_id
        WHERE t.type_id = 587
      `,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ type_name: 'Rifter', group_name: 'Frigate' }]);
  });

  it('allows CTEs when they resolve only to SDE base tables', () => {
    const result = executeSdeSql(
      db as Db,
      `
        WITH ships AS (
          SELECT type_id, name, group_id
          FROM sde_types
          WHERE type_id = 587
        )
        SELECT ships.name, g.name AS group_name
        FROM ships
        JOIN sde_groups AS g ON g.group_id = ships.group_id
      `,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ name: 'Rifter', group_name: 'Frigate' }]);
  });

  it.each([
    'eve_accounts',
    'intel_notes',
    'messages',
    'auth_requests',
    'agent_threads',
    'users',
    'telegram_accounts',
  ])('rejects direct reads from %s', (tableName) => {
    const result = executeSdeSql(db as Db, `SELECT * FROM ${tableName}`);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.error).toContain('Only SDE tables are allowed');
    expect(result.error).toContain(tableName);
  });

  it('rejects hidden non-SDE reads inside subqueries', () => {
    const result = executeSdeSql(
      db as Db,
      `
        SELECT name
        FROM sde_types
        WHERE EXISTS (
          SELECT 1
          FROM eve_accounts
          WHERE eve_accounts.character_name = sde_types.name
        )
      `,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Only SDE tables are allowed');
    expect(result.error).toContain('eve_accounts');
  });

  it('rejects queries without SDE table access', () => {
    const result = executeSdeSql(db as Db, 'SELECT 1');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Query must read from at least one SDE table');
  });

  it('rejects cartesian products that would scan multiple tables in full', () => {
    const result = executeSdeSql(db as Db, 'SELECT COUNT(*) FROM sde_types, sde_groups');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cartesian');
  });

  it('allows an indexed join (one full scan + indexed lookups)', () => {
    const result = executeSdeSql(
      db as Db,
      'SELECT t.name, g.name AS group_name FROM sde_types t JOIN sde_groups g ON g.group_id = t.group_id',
    );

    expect(result.ok).toBe(true);
  });

  it('bounds result rows without materializing an unbounded set', () => {
    for (let i = 1; i <= 120; i += 1) {
      db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
        .run(1000 + i, `Item ${i}`, 25, '{}');
    }
    const result = executeSdeSql(db as Db, 'SELECT type_id FROM sde_types');

    expect(result.ok).toBe(true);
    expect(result.rows.length).toBeLessThanOrEqual(50);
    expect(result.error).toContain('narrow the query');
  });
});
