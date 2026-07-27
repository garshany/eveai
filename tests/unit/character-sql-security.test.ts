import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  analyzeCharacterSqlTables,
  executeCharacterSql,
} from '../../src/agent/tools/character-execution.js';

const OWN_CHARACTER = 111;
const OTHER_CHARACTER = 222;

let db: Database.Database;

function insertAsset(characterId: number, itemId: number, typeId: number, quantity: number): void {
  db.prepare(`
    INSERT INTO character_assets (
      character_id, item_id, type_id, location_id, location_type, location_flag,
      quantity, is_singleton, data_json, synced_at
    ) VALUES (?, ?, ?, ?, 'station', 'Hangar', ?, 1, ?, datetime('now'))
  `).run(characterId, itemId, typeId, 60003760, quantity, JSON.stringify({ item_id: itemId, type_id: typeId }));
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Rows for two different characters plus sensitive non-character tables.
  insertAsset(OWN_CHARACTER, 1, 587, 3);
  insertAsset(OWN_CHARACTER, 2, 34, 1000);
  insertAsset(OTHER_CHARACTER, 3, 44993, 1);
  db.prepare('INSERT INTO character_wallet (character_id, balance, synced_at) VALUES (?, ?, datetime(\'now\'))')
    .run(OWN_CHARACTER, 100.5);
  db.prepare('INSERT INTO character_wallet (character_id, balance, synced_at) VALUES (?, ?, datetime(\'now\'))')
    .run(OTHER_CHARACTER, 999999.9);
  db.prepare(`
    INSERT INTO character_clones (character_id, jump_clone_id, location_id, location_type, name, implants_json, data_json, synced_at)
    VALUES (?, ?, ?, 'station', 'Home', ?, '{}', datetime('now'))
  `).run(OWN_CHARACTER, 7, 60003760, '[20401, 20402]');
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
    VALUES (?, ?, 'secret-access', 'secret-refresh', datetime('now', '+1 hour'), '[]')
  `).run(OTHER_CHARACTER, 'Other Pilot');
  db.prepare('INSERT INTO users (display_name) VALUES (?)').run('someone');
  db.prepare('INSERT INTO intel_notes (user_id, text) VALUES (?, ?)').run(1, 'secret note');
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(587, 'Rifter', 25, '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(34, 'Tritanium', 25, '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(44993, 'PLEX', 25, '{}');
});

afterEach(() => {
  db.close();
});

describe('executeCharacterSql row isolation', () => {
  it('returns only the active character rows', () => {
    const result = executeCharacterSql(db as Db, 'SELECT item_id, type_id FROM character_assets ORDER BY item_id', OWN_CHARACTER);

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([
      { item_id: 1, type_id: 587 },
      { item_id: 2, type_id: 34 },
    ]);
  });

  it('hides other characters even when the query filters by their character_id explicitly', () => {
    const result = executeCharacterSql(
      db as Db,
      `SELECT item_id FROM character_assets WHERE character_id = ${OTHER_CHARACTER}`,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('hides other characters inside subqueries', () => {
    const result = executeCharacterSql(
      db as Db,
      `
        SELECT name FROM sde_types
        WHERE type_id IN (
          SELECT type_id FROM character_assets WHERE character_id = ${OTHER_CHARACTER}
        )
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('hides other characters inside CTEs and unions', () => {
    const result = executeCharacterSql(
      db as Db,
      `
        WITH balances AS (
          SELECT character_id, balance FROM character_wallet
          UNION ALL
          SELECT character_id, balance FROM character_wallet WHERE character_id = ${OTHER_CHARACTER}
        )
        SELECT balance FROM balances
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(true);
    // The first branch yields the own row; the second branch, filtered to the
    // other character, is empty because the isolation view already scopes rows.
    expect(result.rows).toEqual([{ balance: 100.5 }]);
  });

  it('rejects schema-qualified reads that would bypass the isolation views', () => {
    for (const sql of [
      'SELECT * FROM main.character_assets',
      `SELECT * FROM main.character_assets WHERE character_id = ${OTHER_CHARACTER}`,
      'SELECT * FROM temp.character_assets',
    ]) {
      const result = executeCharacterSql(db as Db, sql, OWN_CHARACTER);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Schema-qualified');
    }
  });

  it.each([
    'eve_accounts',
    'intel_notes',
    'users',
    'telegram_sessions',
    'messages',
    'agent_threads',
    'esi_cache',
  ])('rejects reads from %s', (tableName) => {
    const result = executeCharacterSql(db as Db, `SELECT * FROM ${tableName}`, OWN_CHARACTER);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Only character profile (character_*) and SDE (sde_*) tables are allowed');
  });

  it('rejects a hidden join to eve_accounts behind a character table', () => {
    const result = executeCharacterSql(
      db as Db,
      `
        SELECT a.item_id FROM character_assets a
        WHERE EXISTS (SELECT 1 FROM eve_accounts e WHERE e.character_id = a.character_id)
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('eve_accounts');
  });
});

describe('executeCharacterSql read-only boundary', () => {
  it.each([
    `UPDATE character_assets SET quantity = 0 WHERE character_id = ${OWN_CHARACTER}`,
    `DELETE FROM character_assets WHERE character_id = ${OWN_CHARACTER}`,
    'INSERT INTO character_assets (character_id, item_id, type_id, location_id, data_json, synced_at) VALUES (1, 2, 3, 4, \'{}\', \'now\')',
    'DROP TABLE character_assets',
    'CREATE TABLE pwned (id INTEGER)',
    'PRAGMA table_info(character_assets)',
    "ATTACH DATABASE '/tmp/x.db' AS x",
    'VACUUM',
  ])('rejects mutation attempt: %s', (sql) => {
    const result = executeCharacterSql(db as Db, sql, OWN_CHARACTER);

    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM character_assets WHERE character_id = ?').get(OWN_CHARACTER))
      .toEqual({ c: 2 });
  });

  it('rejects write keywords smuggled into a WITH query', () => {
    const result = executeCharacterSql(
      db as Db,
      'WITH x AS (SELECT 1) DELETE FROM character_assets',
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Write operations are not allowed');
  });

  it('rejects queries that touch no character table', () => {
    const result = executeCharacterSql(db as Db, 'SELECT 1', OWN_CHARACTER);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('at least one character_* table');
  });

  it('rejects cartesian products that would scan multiple tables in full', () => {
    // The isolation views always resolve to an indexed character_id lookup, so
    // reaching two unconstrained SCANs takes materialized CTE side tables.
    const result = executeCharacterSql(
      db as Db,
      `
        WITH x AS (SELECT * FROM sde_types), y AS (SELECT * FROM sde_types)
        SELECT COUNT(*) FROM character_assets, x, y
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cartesian');
  });

  it('bounds result rows', () => {
    for (let i = 0; i < 120; i += 1) {
      insertAsset(OWN_CHARACTER, 1000 + i, 34, 1);
    }
    const result = executeCharacterSql(db as Db, 'SELECT item_id FROM character_assets', OWN_CHARACTER);

    expect(result.ok).toBe(true);
    expect(result.rows.length).toBeLessThanOrEqual(50);
    expect(result.error).toContain('narrow the query');
  });

  it('rejects an invalid character context', () => {
    for (const bad of [0, -5, Number.NaN, 1.5]) {
      const result = executeCharacterSql(db as Db, 'SELECT * FROM character_assets', bad);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid character context');
    }
  });
});

describe('executeCharacterSql allowed shapes', () => {
  it('joins character tables with SDE tables via indexed lookup', () => {
    const result = executeCharacterSql(
      db as Db,
      `
        SELECT t.name, a.quantity
        FROM character_assets a
        JOIN sde_types t ON t.type_id = a.type_id
        ORDER BY t.name
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([
      { name: 'Rifter', quantity: 3 },
      { name: 'Tritanium', quantity: 1000 },
    ]);
  });

  it('supports json_each over JSON columns', () => {
    const result = executeCharacterSql(
      db as Db,
      `
        SELECT j.value AS implant
        FROM character_clones c, json_each(c.implants_json) j
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ implant: 20401 }, { implant: 20402 }]);
  });

  it('aggregates across the whole own profile', () => {
    const result = executeCharacterSql(
      db as Db,
      `
        SELECT a.type_id, SUM(a.quantity) AS qty
        FROM character_assets a
        GROUP BY a.type_id
        ORDER BY qty DESC
      `,
      OWN_CHARACTER,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([
      { type_id: 34, qty: 1000 },
      { type_id: 587, qty: 3 },
    ]);
  });

  it('sees the other character rows when that character is the active one', () => {
    const result = executeCharacterSql(db as Db, 'SELECT item_id, type_id FROM character_assets', OTHER_CHARACTER);

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ item_id: 3, type_id: 44993 }]);
  });

  it('leaves no isolation views behind after execution', () => {
    executeCharacterSql(db as Db, 'SELECT * FROM character_assets', OWN_CHARACTER);

    const tempViews = db.prepare(`
      SELECT name FROM sqlite_temp_master WHERE type = 'view'
    `).all();
    expect(tempViews).toEqual([]);
    // Direct table writes (the sync path) keep working unshadowed.
    insertAsset(OWN_CHARACTER, 5, 34, 10);
    const result = executeCharacterSql(db as Db, 'SELECT COUNT(*) AS c FROM character_assets', OWN_CHARACTER);
    expect(result.rows).toEqual([{ c: 3 }]);
  });
});

describe('analyzeCharacterSqlTables', () => {
  it('reports referenced character tables for dataset refresh', () => {
    const analysis = analyzeCharacterSqlTables(
      db as Db,
      `
        SELECT a.item_id, w.balance
        FROM character_assets a, character_wallet w
        WHERE a.item_id = 1
      `,
    );

    expect(analysis).toEqual({
      ok: true,
      characterTables: expect.arrayContaining(['character_assets', 'character_wallet']),
    });
  });

  it('rejects invalid SQL without executing it', () => {
    const analysis = analyzeCharacterSqlTables(db as Db, 'SELECT * FROM eve_accounts');

    expect(analysis.ok).toBe(false);
    if (analysis.ok) throw new Error('Expected analysis to reject non-character tables');
    expect(analysis.error).toContain('eve_accounts');
  });
});
