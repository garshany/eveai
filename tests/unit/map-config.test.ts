import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { bubbleFrom, buildMapGraph, invalidateMapGraphCache } from '../../src/eve/map-graph.js';

/**
 * Конфигурационные ручки должны доходить до поведения, а не только до объекта
 * config. Здесь проверяется и то, что каждая ручка задокументирована в
 * .env.example — иначе оператор не узнает о её существовании.
 */
describe('perimeter configuration', () => {
  const KNOBS = [
    'MAP_BUBBLE_DEFAULT_RADIUS',
    'MAP_BUBBLE_MAX_RADIUS',
    'MAP_BUBBLE_MAX_NODES',
    'MAP_LOCATION_POLL_SECONDS',
    'MAP_INTEL_REFRESH_SECONDS',
    'MAP_MAX_LIVE_SESSIONS',
    'MAP_MAX_LIVE_SESSIONS_PER_USER',
    'MAP_LIVE_SESSION_IDLE_SECONDS',
    'MAP_LIVE_SESSION_MAX_FAILURES',
    'MAP_KILL_INDEX_RETENTION_HOURS',
    'MAP_KILL_INDEX_MAX_ROWS',
    'MAP_KILL_BACKFILL_TTL_SECONDS',
    'MAP_KILL_BACKFILL_MAX_SYSTEMS',
    'MAP_METRICS_HISTORY_ENABLED',
    'MAP_METRICS_HOURLY_RETENTION_DAYS',
    'MAP_GATE_KILL_RETENTION_DAYS',
    'MAP_ADVISOR_COOLDOWN_SECONDS',
    'MAP_ADVISOR_LLM_COOLDOWN_SECONDS',
    'MAP_ADVISOR_LLM_ENABLED',
  ];

  it('documents every knob in .env.example', () => {
    const env = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const knob of KNOBS) {
      expect(env, `${knob} is missing from .env.example`).toContain(`${knob}=`);
    }
  });

  it('never lets the position poll go below the ESI cache window', () => {
    // Быстрее пяти секунд ESI отдаёт то же тело: это трата бюджета ошибок.
    expect(config.map.locationPollSeconds).toBeGreaterThanOrEqual(5);
  });

  it('keeps the default radius inside the maximum', () => {
    expect(config.map.bubbleDefaultRadius).toBeLessThanOrEqual(config.map.bubbleMaxRadius);
  });

  it('applies the node cap to a real bubble expansion', () => {
    invalidateMapGraphCache();
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
      CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
      CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
      CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
      CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
    `);
    db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', 'now');
    db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (1, ?, ?)').run('R', '{}');
    db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 1, ?)').run('C', '{}');

    // Цепочка из 40 систем: пузырь радиуса 30 упрётся в потолок в 10 узлов.
    const insertSystem = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
    const insertGate = db.prepare('INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)');
    for (let index = 0; index < 40; index += 1) {
      insertSystem.run(30000000 + index, `S${index}`, JSON.stringify({
        securityStatus: 0.5,
        position2D: { x: index, y: 0 },
      }));
      if (index > 0) insertGate.run(index, 30000000 + index - 1, 30000000 + index, '{}');
    }
    buildMapGraph(db, { force: true });

    const capped = bubbleFrom(db, 30000000, 30, 10);
    expect(capped.truncated).toBe(true);
    expect(capped.nodes.length).toBeLessThanOrEqual(10);
    expect(capped.radius).toBeLessThan(30);

    // Тот же радиус без потолка: от головы цепочки 30 прыжков — это 31 система.
    const uncapped = bubbleFrom(db, 30000000, 30, 1000);
    expect(uncapped.truncated).toBe(false);
    expect(uncapped.nodes.length).toBe(31);
    expect(uncapped.radius).toBe(30);

    db.close();
    invalidateMapGraphCache();
  });
});
