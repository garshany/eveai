import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { executeSdeSql } from '../../src/agent/tools/sde-execution.js';
import { SDE_SCHEMA, STATIC_AGGREGATE_SDE_SCHEMA } from '../../src/agent/tools/sde-schema.js';
import { CHARACTER_SCHEMA } from '../../src/agent/tools/character-schema.js';

function realColumns(db: Database.Database, table: string): string[] {
  // table_info omits generated columns (sde_types.market_group_id/published),
  // which the hint intentionally leaves out to keep the prompt small.
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

describe('model-facing SDE schema hints', () => {
  it('list exactly the real columns of every table they mention', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const mismatches: string[] = [];
    for (const hint of [SDE_SCHEMA, STATIC_AGGREGATE_SDE_SCHEMA]) {
      for (const match of hint.matchAll(/^(sde_\w+) \(([^)]*)\)/gmu)) {
        const hinted = match[2].split(',').map((column) => column.trim().split(' ')[0]).sort();
        const actual = realColumns(db, match[1]).sort();
        if (JSON.stringify(hinted) !== JSON.stringify(actual)) {
          mismatches.push(`${match[1]}: hint=${hinted.join(',')} db=${actual.join(',')}`);
        }
      }
    }
    db.close();
    expect(mismatches).toEqual([]);
  });

  it('character schema hint lists the real columns (character_id is server-enforced and omitted)', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const mismatches: string[] = [];
    for (const match of CHARACTER_SCHEMA.matchAll(/^(character_\w+) \(([^)]*)\)/gmu)) {
      const hinted = match[2].split(',').map((column) => column.trim().split(' ')[0]).sort();
      const actual = realColumns(db, match[1]).filter((column) => column !== 'character_id').sort();
      if (JSON.stringify(hinted) !== JSON.stringify(actual)) {
        mismatches.push(`${match[1]}: hint=${hinted.join(',')} db=${actual.join(',')}`);
      }
    }
    db.close();
    expect(mismatches).toEqual([]);
  });

  it('spell out the dogma column traps the model hit in production', () => {
    // Production errors: `a.unit_id` on sde_dogma_attributes, `name` on sde_type_dogma.
    expect(SDE_SCHEMA).toContain("sde_dogma_attributes (attribute_id INT, name TEXT, data_json TEXT) — attributeID→name; no unit_id: unit=json_extract(a.data_json,'$.unitID')");
    expect(SDE_SCHEMA).toContain('sde_type_dogma (type_id INT, data_json TEXT) — no name column;');
  });

  it('documents a unit lookup that runs through sde_sql', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO sde_type_dogma (type_id, data_json) VALUES (?, ?)')
      .run(587, JSON.stringify({ dogmaAttributes: [{ attributeID: 37, value: 365 }] }));
    db.prepare('INSERT INTO sde_dogma_attributes (attribute_id, name, data_json) VALUES (?, ?, ?)')
      .run(37, 'maxVelocity', JSON.stringify({ unitID: 11 }));
    db.prepare('INSERT INTO sde_dogma_units (unit_id, name, data_json) VALUES (?, ?, ?)')
      .run(11, 'Acceleration', JSON.stringify({ displayName: { en: 'm/sec' } }));

    const result = executeSdeSql(db as Db, `
      SELECT a.name, json_extract(j.value,'$.value') AS val, json_extract(u.data_json,'$.displayName.en') AS unit
      FROM sde_type_dogma d, json_each(d.data_json,'$.dogmaAttributes') j
      JOIN sde_dogma_attributes a ON a.attribute_id=json_extract(j.value,'$.attributeID')
      LEFT JOIN sde_dogma_units u ON u.unit_id=json_extract(a.data_json,'$.unitID')
      WHERE d.type_id=587`);
    db.close();

    expect(result).toEqual({ ok: true, rows: [{ name: 'maxVelocity', val: 365, unit: 'm/sec' }], count: 1, error: null });
  });
});
