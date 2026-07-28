import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { buildMapGraph, invalidateMapGraphCache, routeWithRisk } from '../../src/eve/map-graph.js';
import {
  MAX_AVOID_SYSTEMS,
  addAvoided,
  avoidSetFor,
  clearAvoided,
  effectiveAvoidSet,
  listAvoided,
  removeAvoided,
} from '../../src/eve-map/avoid.js';

const USER = 7;

/**
 * Граф-ромб: 1 → (2 | 3) → 4. Через 2 короче, через 3 длиннее ровно на прыжок,
 * поэтому «избегать 2» обязано увести маршрут на 3, а не просто упасть.
 */
function seed(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', 'now');
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (1, ?, ?)').run('R', '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 1, ?)')
    .run('C', '{}');

  const system = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  const at = (x: number): string => JSON.stringify({ securityStatus: 0.9, position2D: { x, y: 0 } });
  system.run(1, 'Origin', at(0));
  system.run(2, 'Uedama', at(1));
  system.run(3, 'Detour', at(1));
  system.run(4, 'Destination', at(2));
  system.run(5, 'Bridge', at(2));

  const gate = db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
  gate.run(1, 1, 2, '{}');
  gate.run(2, 2, 4, '{}');
  gate.run(3, 1, 3, '{}');
  gate.run(4, 3, 5, '{}');
  gate.run(5, 5, 4, '{}');
  buildMapGraph(db, { force: true });
}

describe('avoid list', () => {
  let db: Database.Database;

  beforeEach(() => {
    invalidateMapGraphCache();
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    seed(db);
  });

  afterEach(() => {
    db.close();
    invalidateMapGraphCache();
  });

  it('remembers what the pilot clicked and survives the request', () => {
    const added = addAvoided(db, USER, 2, 'ганкеры');
    expect(added.ok).toBe(true);

    const listed = listAvoided(db, USER);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ systemId: 2, name: 'Uedama', note: 'ганкеры' });
    expect(avoidSetFor(db, USER)).toEqual(new Set([2]));
  });

  it('is per pilot, not global', () => {
    addAvoided(db, USER, 2);
    expect(avoidSetFor(db, 999).size).toBe(0);
  });

  it('adding twice is not an error and does not duplicate', () => {
    addAvoided(db, USER, 2);
    const again = addAvoided(db, USER, 2);
    expect(again.ok && again.alreadyPresent).toBe(true);
    expect(listAvoided(db, USER)).toHaveLength(1);
  });

  it('refuses a system that is not on the map', () => {
    const result = addAvoided(db, USER, 424242);
    expect(result.ok).toBe(false);
  });

  it('actually reroutes around an avoided system', () => {
    const direct = routeWithRisk(db, 1, 4, {});
    expect(direct.systemIds).toEqual([1, 2, 4]);

    addAvoided(db, USER, 2);
    const rerouted = routeWithRisk(db, 1, 4, {
      avoid: effectiveAvoidSet(db, USER, [], [1, 4]),
    });
    // Крюк длиннее — и это правильный ответ, а не отказ строить маршрут.
    expect(rerouted.ok).toBe(true);
    expect(rerouted.systemIds).toEqual([1, 3, 5, 4]);
  });

  it('never blocks flying to a system you avoided', () => {
    addAvoided(db, USER, 4);
    // Решение «не летать через» не должно запрещать «прилететь в».
    const set = effectiveAvoidSet(db, USER, [], [1, 4]);
    expect(set.has(4)).toBe(false);
    expect(routeWithRisk(db, 1, 4, { avoid: set }).ok).toBe(true);
  });

  it('merges the stored list with per-request avoids', () => {
    addAvoided(db, USER, 2);
    expect([...effectiveAvoidSet(db, USER, [3], [1, 4])].sort()).toEqual([2, 3]);
  });

  it('removes and clears', () => {
    addAvoided(db, USER, 2);
    addAvoided(db, USER, 3);
    expect(removeAvoided(db, USER, 2)).toBe(true);
    expect(listAvoided(db, USER)).toHaveLength(1);
    expect(clearAvoided(db, USER)).toBe(1);
    expect(listAvoided(db, USER)).toHaveLength(0);
  });

  it('caps the list before it can disconnect the graph', () => {
    addAvoided(db, USER, 2);
    const insert = db.prepare(
      'INSERT INTO map_avoid_systems (user_id, system_id, note, created_at_ms) VALUES (?, ?, NULL, 0)',
    );
    for (let index = 0; index < MAX_AVOID_SYSTEMS - 1; index += 1) insert.run(USER, 100_000 + index);

    // Список полон: новая система не влезает, иначе граф рассыпается и
    // «маршрут не найден» становится обычным ответом.
    expect(addAvoided(db, USER, 3).ok).toBe(false);
    // Потолок ограничивает рост, а не правку уже добавленного.
    const existing = addAvoided(db, USER, 2, 'уточнил причину');
    expect(existing.ok && existing.alreadyPresent).toBe(true);
  });
});
