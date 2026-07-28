import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { attributeKillsToGates } from '../../src/eve-board/analytics.js';

/**
 * Привязка кила к гейту — единственное, что отличает кемп от «в этой системе
 * кого-то убили». Радиус здесь был завышен в миллион раз (200 млн км вместо
 * 200 км), из-за чего к гейту прилипал любой кил в системе. Эти тесты
 * закрепляют границу.
 */
const SYSTEM_ID = 30000142;
const GATE_A = 50000001;
const GATE_B = 50000002;

/** Позиции в метрах: гейты разнесены на 1 а.е. по X. */
const AU_M = 149_597_870_700;

function seed(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  const system = db.prepare('INSERT OR REPLACE INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  system.run(SYSTEM_ID, 'Jita', '{}');
  system.run(30000144, 'Perimeter', '{}');
  system.run(30000145, 'Sobaseki', '{}');

  const gate = db.prepare('INSERT OR REPLACE INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
  gate.run(GATE_A, SYSTEM_ID, 30000144, JSON.stringify({ position: { x: 0, y: 0, z: 0 } }));
  gate.run(GATE_B, SYSTEM_ID, 30000145, JSON.stringify({ position: { x: AU_M, y: 0, z: 0 } }));
}

function kill(id: number, x: number): {
  killmail_id: number;
  killmail_time: string;
  position: { x: number; y: number; z: number };
} {
  return {
    killmail_id: id,
    killmail_time: new Date().toISOString(),
    position: { x, y: 0, z: 0 },
  };
}

describe('gate attribution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    seed(db);
  });

  afterEach(() => db.close());

  it('attributes a kill sitting on the gate', () => {
    // 14.5 км — расстояние реального кемп-кила от гейта.
    const gates = attributeKillsToGates(db, SYSTEM_ID, [kill(1, 14_581)]);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.stargateId).toBe(GATE_A);
    expect(gates[0]!.connectedSystemName).toBe('Perimeter');
    expect(gates[0]!.killCount).toBe(1);
  });

  it('ignores a kill far from every gate', () => {
    // Полмиллиона километров от ближайшего гейта — это не кемп, это где-то
    // в системе. Со старым радиусом такой кил считался «на гейте».
    const gates = attributeKillsToGates(db, SYSTEM_ID, [kill(2, 500_000_000)]);
    expect(gates).toHaveLength(0);
  });

  it('does not attribute a kill at another celestial to the nearest gate', () => {
    const gates = attributeKillsToGates(db, SYSTEM_ID, [kill(3, AU_M / 2)]);
    expect(gates).toHaveLength(0);
  });

  it('groups repeated kills on the same gate', () => {
    const gates = attributeKillsToGates(db, SYSTEM_ID, [
      kill(4, 1_000), kill(5, 50_000), kill(6, 190_000),
    ]);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.killCount).toBe(3);
  });

  it('separates kills on different gates', () => {
    const gates = attributeKillsToGates(db, SYSTEM_ID, [kill(7, 1_000), kill(8, AU_M + 1_000)]);
    expect(gates.map((gate) => gate.stargateId).sort()).toEqual([GATE_A, GATE_B]);
  });

  it('returns nothing for a system with no stargates', () => {
    expect(attributeKillsToGates(db, 30000144, [kill(9, 0)])).toHaveLength(0);
  });

  it('skips kills that carry no position', () => {
    expect(attributeKillsToGates(db, SYSTEM_ID, [{ killmail_id: 10 }])).toHaveLength(0);
  });
});
